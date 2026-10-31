/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import { randomUUID, webcrypto } from 'node:crypto';

import type { OidcClientMetadata } from '@seamless-auth/types';
import express from 'express';
import * as oidc from 'openid-client';
import { beforeEach, describe, expect, it } from 'vitest';

import { createRateLimiter } from '../src/rateLimit.js';
import { FakeBrowser, sendToEdge } from './browser.js';
import { ISSUER } from './fakeApi.js';
import {
  firstParty,
  follow,
  interactionUid,
  otherFirstParty,
  relyingParty,
  SESSION,
  signIn,
  startAuthorization,
  startEdge,
  USER,
} from './harness.js';

const ORDERS = 'https://orders.example.com';

const refreshing: OidcClientMetadata = {
  ...firstParty,
  grant_types: ['authorization_code', 'refresh_token'],
};

async function confidentialClient(clientId: string) {
  const { privateKey, publicKey } = await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = await webcrypto.subtle.exportKey('jwk', publicKey);
  const kid = randomUUID();
  const metadata: OidcClientMetadata = {
    ...firstParty,
    client_id: clientId,
    client_name: clientId,
    token_endpoint_auth_method: 'private_key_jwt',
    grant_types: ['client_credentials'],
    response_types: [],
    redirect_uris: [],
    jwks: {
      keys: [{ kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y!, kid, alg: 'ES256', use: 'sig' }],
    },
  };
  return { metadata, auth: oidc.PrivateKeyJwt({ key: privateKey, kid }) };
}

describe('introspection and revocation', () => {
  let started: Awaited<ReturnType<typeof startEdge>>;
  let browser: FakeBrowser;
  let app: oidc.Configuration;

  async function userTokens(extra: Record<string, string>) {
    const flow = await startAuthorization(app, refreshing, extra);
    let landed = await follow(browser, flow.url.href);
    signIn(browser);
    for (let step = 0; step < 3 && landed.pathname.startsWith('/interaction/'); step += 1) {
      const uid = interactionUid(landed);
      const details = await browser.get(`/interaction/${uid}/details`);
      const name = details.json<{ prompt: { name: string } }>().prompt.name;
      const done = await browser.post(`/interaction/${uid}/${name}`);
      landed = await follow(browser, done.json<{ redirectTo: string }>().redirectTo);
    }
    return oidc.authorizationCodeGrant(app, landed, {
      pkceCodeVerifier: flow.codeVerifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce,
    });
  }

  beforeEach(async () => {
    started = await startEdge();
    started.store.addClient(refreshing);
    started.store.setResources(refreshing.client_id, [
      { identifier: ORDERS, scopes: ['orders:read'], accessTokenTtlSeconds: null },
    ]);
    browser = new FakeBrowser(started.base);
    app = await relyingParty(started.base, refreshing);
  });

  it('lists both endpoints in discovery', () => {
    expect(app.serverMetadata()).toMatchObject({
      introspection_endpoint: `${ISSUER}/token/introspection`,
      revocation_endpoint: `${ISSUER}/token/revocation`,
    });
  });

  it("answers a resource server about its own audience's JWTs, until the session ends", async () => {
    const orders = await confidentialClient('orders-api');
    started.store.addClient(orders.metadata);
    started.store.setResources(orders.metadata.client_id, [
      { identifier: ORDERS, scopes: [], accessTokenTtlSeconds: null },
    ]);
    const rs = await relyingParty(started.base, orders.metadata, orders.auth);

    const tokens = await userTokens({ resource: ORDERS, scope: 'openid orders:read' });
    const active = await oidc.tokenIntrospection(rs, tokens.access_token);
    expect(active).toMatchObject({
      active: true,
      sub: USER,
      aud: ORDERS,
      client_id: refreshing.client_id,
      scope: 'orders:read',
      token_type: 'Bearer',
    });

    started.store.endSession(SESSION);
    expect(await oidc.tokenIntrospection(rs, tokens.access_token)).toEqual({ active: false });
  });

  it('tells any other client nothing about the token', async () => {
    const stranger = await confidentialClient('reporting-job');
    started.store.addClient(stranger.metadata);
    const rs = await relyingParty(started.base, stranger.metadata, stranger.auth);
    const tokens = await userTokens({ resource: ORDERS, scope: 'openid orders:read' });
    expect(await oidc.tokenIntrospection(rs, tokens.access_token)).toEqual({ active: false });
  });

  it('does not accept a JWT it did not sign', async () => {
    const tokens = await userTokens({ resource: ORDERS, scope: 'openid orders:read' });
    const [header, payload] = tokens.access_token.split('.');
    const forged = `${header}.${payload}.${Buffer.from('not a signature').toString('base64url')}`;
    expect(await oidc.tokenIntrospection(app, forged)).toEqual({ active: false });
    expect(await oidc.tokenIntrospection(app, tokens.access_token)).toMatchObject({ active: true });
  });

  it('lets a public client revoke its refresh token, and records it', async () => {
    const tokens = await userTokens({ scope: 'openid offline_access', prompt: 'consent' });
    expect(await oidc.tokenIntrospection(app, tokens.refresh_token!)).toMatchObject({
      active: true,
      sub: USER,
    });

    await oidc.tokenRevocation(app, tokens.refresh_token!);

    await expect(oidc.refreshTokenGrant(app, tokens.refresh_token!)).rejects.toMatchObject({
      error: 'invalid_grant',
    });
    expect(await oidc.tokenIntrospection(app, tokens.access_token)).toEqual({ active: false });
    expect(started.store.events).toContainEqual(
      expect.objectContaining({
        type: 'token_revoked',
        clientId: refreshing.client_id,
        userId: USER,
        sessionId: SESSION,
        metadata: { tokenType: 'RefreshToken' },
      }),
    );
    // Revoking an app's token is not a sign-out of the user's other apps.
    expect(started.store.revokedSessions).toEqual([]);
  });

  it('does not take the jti alone for the token', async () => {
    const tokens = await userTokens({ resource: ORDERS, scope: 'openid orders:read' });
    const { jti } = JSON.parse(
      Buffer.from(tokens.access_token.split('.')[1]!, 'base64url').toString(),
    ) as { jti: string };
    expect(await oidc.tokenIntrospection(app, jti)).toEqual({ active: false });
    await expect(oidc.fetchUserInfo(app, jti, USER)).rejects.toThrow();
  });

  it("records nothing when a public client presents another app's token", async () => {
    const tokens = await userTokens({ scope: 'openid offline_access', prompt: 'consent' });
    const other = await relyingParty(started.base, otherFirstParty);
    await oidc.tokenRevocation(other, tokens.refresh_token!);
    expect(started.store.events).toEqual([]);
    expect(await oidc.tokenIntrospection(app, tokens.refresh_token!)).toMatchObject({
      active: true,
    });
  });

  it('revokes a JWT access token by its jti', async () => {
    const tokens = await userTokens({ resource: ORDERS, scope: 'openid orders:read' });
    expect(await oidc.tokenIntrospection(app, tokens.access_token)).toMatchObject({ active: true });
    await oidc.tokenRevocation(app, tokens.access_token);
    expect(await oidc.tokenIntrospection(app, tokens.access_token)).toEqual({ active: false });
  });
});

describe('createRateLimiter', () => {
  it('answers 429 with Retry-After once a caller passes the limit', async () => {
    const server = express()
      .set('trust proxy', true)
      .use(createRateLimiter({ limit: 2, windowMs: 60_000 }))
      .use((_req, res) => {
        res.json({ ok: true });
      })
      .listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const address = server.address();
    const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    const statuses = [];
    for (let i = 0; i < 3; i += 1) {
      statuses.push((await sendToEdge(base, '/token/introspection')).status);
    }
    const limited = await sendToEdge(base, '/token/introspection');
    server.close();
    expect(statuses).toEqual([200, 200, 429]);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });
});
