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
import { ISSUER } from './fakeApi.js';
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
const BILLING = 'https://billing.example.com';

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

describe('refresh token rotation', () => {
  let browser: FakeBrowser;
  let started: Awaited<ReturnType<typeof startEdge>>;
  let config: oidc.Configuration;

  function setContext(context: Partial<OidcAuthContext>) {
    started.store.addAccount({
      sessionId: SESSION,
      claims: { sub: USER, email: 'ada@example.com', roles: [], org_id: null },
      context,
    });
  }

  async function signInWithOfflineAccess() {
    const flow = await startAuthorization(config, refreshing, {
      scope: 'openid email offline_access',
      prompt: 'consent',
    });
    let landed = await follow(browser, flow.url.href);
    signIn(browser);
    for (let step = 0; step < 3 && landed.pathname.startsWith('/interaction/'); step += 1) {
      const uid = interactionUid(landed);
      const details = await browser.get(`/interaction/${uid}/details`);
      const name = details.json<{ prompt: { name: string } }>().prompt.name;
      const done = await browser.post(`/interaction/${uid}/${name}`);
      landed = await follow(browser, done.json<{ redirectTo: string }>().redirectTo);
    }
    return oidc.authorizationCodeGrant(config, landed, {
      pkceCodeVerifier: flow.codeVerifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce,
    });
  }

  beforeEach(async () => {
    started = await startEdge();
    started.store.addClient(refreshing);
    browser = new FakeBrowser(started.base);
    config = await relyingParty(started.base, refreshing);
  });

  it('rotates the refresh token on every use', async () => {
    const first = await signInWithOfflineAccess();
    expect(first.refresh_token).toBeTruthy();
    const second = await oidc.refreshTokenGrant(config, first.refresh_token!);
    expect(second.refresh_token).toBeTruthy();
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(second.claims()).toMatchObject({ sub: USER, acr: 'phrh' });
    const third = await oidc.refreshTokenGrant(config, second.refresh_token!);
    expect(third.refresh_token).not.toBe(second.refresh_token);
  });

  it('ends the grant and the session when a used refresh token comes back', async () => {
    const first = await signInWithOfflineAccess();
    const second = await oidc.refreshTokenGrant(config, first.refresh_token!);

    await expect(oidc.refreshTokenGrant(config, first.refresh_token!)).rejects.toMatchObject({
      error: 'invalid_grant',
    });
    expect(started.store.revokedSessions).toEqual([
      { sessionId: SESSION, reason: 'refresh_token_reuse' },
    ]);
    // The rotated token went with the grant.
    await expect(oidc.refreshTokenGrant(config, second.refresh_token!)).rejects.toMatchObject({
      error: 'invalid_grant',
    });
  });

  it('carries a later step-up into the refreshed ID token', async () => {
    setContext({ acr: 'phr', amr: ['swk', 'user'], authTime: Math.floor(Date.now() / 1000) - 60 });
    const first = await signInWithOfflineAccess();
    expect(first.claims()).toMatchObject({ acr: 'phr' });

    const steppedAt = Math.floor(Date.now() / 1000);
    setContext({ acr: 'phrh', amr: ['hwk', 'user', 'mfa'], authTime: steppedAt });
    const refreshed = await oidc.refreshTokenGrant(config, first.refresh_token!);
    expect(refreshed.claims()).toMatchObject({
      acr: 'phrh',
      amr: ['hwk', 'user', 'mfa'],
      auth_time: steppedAt,
    });
    expect(started.store.revokedSessions).toEqual([]);
  });
});

describe('client credentials', () => {
  let started: Awaited<ReturnType<typeof startEdge>>;
  let machine: OidcClientMetadata;
  let config: oidc.Configuration;

  beforeEach(async () => {
    const { privateKey, publicKey } = await webcrypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    const jwk = await webcrypto.subtle.exportKey('jwk', publicKey);
    const kid = randomUUID();
    machine = {
      ...firstParty,
      client_id: 'reporting-job',
      client_name: 'Reporting job',
      token_endpoint_auth_method: 'private_key_jwt',
      grant_types: ['client_credentials'],
      response_types: [],
      redirect_uris: [],
      jwks: {
        keys: [{ kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y!, kid, alg: 'ES256', use: 'sig' }],
      },
    };
    started = await startEdge();
    started.store.addClient(machine);
    started.store.setResources(machine.client_id, [
      { identifier: ORDERS, scopes: ['orders:read'], accessTokenTtlSeconds: 120 },
    ]);
    config = await relyingParty(
      started.base,
      machine,
      oidc.PrivateKeyJwt({ key: privateKey, kid }),
    );
  });

  it('issues a JWT for the client itself at its only resource', async () => {
    const tokens = await oidc.clientCredentialsGrant(config, {
      scope: 'orders:read orders:write',
    });
    const claims = payloadOf(tokens.access_token);
    expect(claims).toMatchObject({
      aud: ORDERS,
      sub: machine.client_id,
      client_id: machine.client_id,
      scope: 'orders:read',
    });
    expect([120 - 1, 120]).toContain(tokens.expires_in);
    expect(started.store.signed).toEqual([
      { kind: 'client_credentials', clientId: machine.client_id },
    ]);
  });

  it('issues the token for the built-in notices resource the API lists', async () => {
    const notices = `${ISSUER}/seamless`;
    started.store.setResources(machine.client_id, [
      { identifier: notices, scopes: ['notices:send'], accessTokenTtlSeconds: null },
      { identifier: ORDERS, scopes: ['orders:read'], accessTokenTtlSeconds: null },
    ]);
    const tokens = await oidc.clientCredentialsGrant(config, {
      scope: 'notices:send',
      resource: notices,
    });
    expect(payloadOf(tokens.access_token)).toMatchObject({
      aud: notices,
      sub: machine.client_id,
      client_id: machine.client_id,
      scope: 'notices:send',
    });
  });

  it('needs the resource named once the client has several', async () => {
    started.store.setResources(machine.client_id, [
      { identifier: ORDERS, scopes: ['orders:read'], accessTokenTtlSeconds: null },
      { identifier: BILLING, scopes: ['invoices:read'], accessTokenTtlSeconds: null },
    ]);
    await expect(
      oidc.clientCredentialsGrant(config, { scope: 'invoices:read' }),
    ).rejects.toMatchObject({ error: 'invalid_target' });

    const tokens = await oidc.clientCredentialsGrant(config, {
      scope: 'invoices:read',
      resource: BILLING,
    });
    expect(payloadOf(tokens.access_token)).toMatchObject({ aud: BILLING, scope: 'invoices:read' });
  });

  it('refuses a resource the client is not linked to', async () => {
    await expect(oidc.clientCredentialsGrant(config, { resource: BILLING })).rejects.toMatchObject({
      error: 'invalid_target',
    });
  });

  it('refuses a client not registered for the grant', async () => {
    const userApp = await relyingParty(started.base, firstParty);
    await expect(oidc.clientCredentialsGrant(userApp)).rejects.toMatchObject({
      error: expect.stringMatching(/unauthorized_client|invalid_client|invalid_request/),
    });
  });
});
