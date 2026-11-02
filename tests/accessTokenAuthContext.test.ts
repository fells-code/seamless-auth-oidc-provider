/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import { randomUUID, webcrypto } from 'node:crypto';

import type { OidcAuthContext, OidcClientMetadata } from '@seamless-auth/types';
import * as oidc from 'openid-client';
import { beforeEach, describe, expect, it } from 'vitest';

import { FakeBrowser } from './browser.js';
import {
  firstParty,
  follow,
  interactionUid,
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

function payloadOf(token: string) {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as Record<
    string,
    unknown
  >;
}

async function resourceServer(clientId: string) {
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

describe('step-up claims on access tokens (RFC 9068 section 2.2.1)', () => {
  let started: Awaited<ReturnType<typeof startEdge>>;
  let browser: FakeBrowser;
  let app: oidc.Configuration;

  function setContext(context: Partial<OidcAuthContext>) {
    started.store.addAccount({
      sessionId: SESSION,
      claims: { sub: USER, email: 'ada@example.com', roles: [], org_id: null },
      context,
    });
  }

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

  it("states the session's acr, amr and auth_time on a token for a resource", async () => {
    const signedInAt = Math.floor(Date.now() / 1000) - 30;
    setContext({ acr: 'phr', amr: ['swk', 'user'], authTime: signedInAt });

    const tokens = await userTokens({ resource: ORDERS, scope: 'openid orders:read' });

    expect(payloadOf(tokens.access_token)).toMatchObject({
      aud: ORDERS,
      sub: USER,
      acr: 'phr',
      amr: ['swk', 'user'],
      auth_time: signedInAt,
    });
    // The same values the ID token states.
    expect(tokens.claims()).toMatchObject({
      acr: 'phr',
      amr: ['swk', 'user'],
      auth_time: signedInAt,
    });
  });

  it('leaves acr off when the session has none, and keeps amr and auth_time', async () => {
    const signedInAt = Math.floor(Date.now() / 1000) - 30;
    setContext({ acr: null, amr: ['otp'], authTime: signedInAt });

    const tokens = await userTokens({ resource: ORDERS, scope: 'openid orders:read' });

    const claims = payloadOf(tokens.access_token);
    expect(claims).not.toHaveProperty('acr');
    expect(claims).toMatchObject({ amr: ['otp'], auth_time: signedInAt });
  });

  it('carries a later step-up into the next refreshed access token', async () => {
    setContext({ acr: 'phr', amr: ['swk', 'user'], authTime: Math.floor(Date.now() / 1000) - 60 });
    const first = await userTokens({
      resource: ORDERS,
      scope: 'openid offline_access orders:read',
      prompt: 'consent',
    });
    expect(payloadOf(first.access_token)).toMatchObject({ acr: 'phr' });

    const steppedAt = Math.floor(Date.now() / 1000);
    setContext({ acr: 'phrh', amr: ['hwk', 'user', 'mfa'], authTime: steppedAt });
    const refreshed = await oidc.refreshTokenGrant(app, first.refresh_token!);

    expect(payloadOf(refreshed.access_token)).toMatchObject({
      aud: ORDERS,
      acr: 'phrh',
      amr: ['hwk', 'user', 'mfa'],
      auth_time: steppedAt,
    });
  });

  it('returns them from introspection to the resource server', async () => {
    const orders = await resourceServer('orders-api');
    started.store.addClient(orders.metadata);
    started.store.setResources(orders.metadata.client_id, [
      { identifier: ORDERS, scopes: [], accessTokenTtlSeconds: null },
    ]);
    const rs = await relyingParty(started.base, orders.metadata, orders.auth);
    const signedInAt = Math.floor(Date.now() / 1000) - 30;
    setContext({ acr: 'phrh', amr: ['hwk', 'user', 'mfa'], authTime: signedInAt });

    const tokens = await userTokens({ resource: ORDERS, scope: 'openid orders:read' });

    expect(await oidc.tokenIntrospection(rs, tokens.access_token)).toMatchObject({
      active: true,
      sub: USER,
      aud: ORDERS,
      acr: 'phrh',
      amr: ['hwk', 'user', 'mfa'],
      auth_time: signedInAt,
    });
  });

  it('adds nothing to an opaque userinfo token', async () => {
    const tokens = await userTokens({ scope: 'openid email' });

    expect(tokens.access_token.split('.')).toHaveLength(1);
    const introspected = await oidc.tokenIntrospection(app, tokens.access_token);
    expect(introspected).toMatchObject({ active: true, sub: USER });
    for (const claim of ['acr', 'amr', 'auth_time']) {
      expect(introspected).not.toHaveProperty(claim);
    }
  });
});
