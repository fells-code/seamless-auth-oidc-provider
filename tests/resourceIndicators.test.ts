/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import * as oidc from 'openid-client';
import { beforeEach, describe, expect, it } from 'vitest';

import { FakeBrowser } from './browser.js';
import { EDGE_CONFIG, ISSUER } from './fakeApi.js';
import {
  firstParty,
  follow,
  interactionUid,
  relyingParty,
  SESSION,
  signIn,
  startAuthorization,
  startEdge,
  thirdParty,
  USER,
} from './harness.js';

const ORDERS = 'https://orders.example.com';

function decodeJwt(token: string) {
  const [header, payload] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(header!, 'base64url').toString()) as Record<string, unknown>,
    payload: JSON.parse(Buffer.from(payload!, 'base64url').toString()) as Record<string, unknown>,
  };
}

describe('access tokens for a named API', () => {
  let browser: FakeBrowser;
  let started: Awaited<ReturnType<typeof startEdge>>;
  let config: oidc.Configuration;

  async function authorize(extra: Record<string, string>) {
    const flow = await startAuthorization(config, firstParty, extra);
    const next = await follow(browser, flow.url.href);
    if (next.pathname.startsWith('/interaction/')) {
      signIn(browser);
      const login = await browser.post(`/interaction/${interactionUid(next)}/login`);
      const callback = await follow(browser, login.json<{ redirectTo: string }>().redirectTo);
      return { flow, callback };
    }
    return { flow, callback: next };
  }

  async function redeem(flow: Awaited<ReturnType<typeof startAuthorization>>, callback: URL) {
    return oidc.authorizationCodeGrant(config, callback, {
      pkceCodeVerifier: flow.codeVerifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce,
    });
  }

  beforeEach(async () => {
    started = await startEdge();
    started.store.setResources(firstParty.client_id, [
      { identifier: ORDERS, scopes: ['orders:read'], accessTokenTtlSeconds: 300 },
    ]);
    browser = new FakeBrowser(started.base);
    config = await relyingParty(started.base, firstParty);
  });

  it('issues an RFC 9068 JWT whose audience is the resource', async () => {
    const { flow, callback } = await authorize({
      resource: ORDERS,
      scope: 'openid email orders:read orders:write',
    });
    const tokens = await redeem(flow, callback);
    const { header, payload } = decodeJwt(tokens.access_token);
    expect(header).toMatchObject({ typ: 'at+jwt', alg: 'RS256', kid: 'active' });
    expect(payload).toMatchObject({
      iss: ISSUER,
      aud: ORDERS,
      sub: USER,
      client_id: firstParty.client_id,
      scope: 'orders:read',
    });
    expect(typeof payload.jti).toBe('string');
    expect(Number(payload.exp) - Number(payload.iat)).toBe(300);
    expect([300 - 1, 300]).toContain(tokens.expires_in);
    expect(started.store.signed).toContainEqual({
      kind: 'access_token',
      clientId: firstParty.client_id,
      sessionId: SESSION,
      grantType: 'authorization_code',
    });
    // The ID token still identifies the user to the app itself.
    expect(tokens.claims()).toMatchObject({ aud: firstParty.client_id, sub: USER });
  });

  it('keeps an opaque userinfo token when no resource is named', async () => {
    const { flow, callback } = await authorize({ scope: 'openid email orders:read' });
    const tokens = await redeem(flow, callback);
    expect(tokens.access_token.split('.')).toHaveLength(1);
    expect([600 - 1, 600]).toContain(tokens.expires_in);
    const userinfo = await oidc.fetchUserInfo(config, tokens.access_token, USER);
    expect(userinfo).toMatchObject({ sub: USER });
  });

  it('refuses a resource the client is not allowed', async () => {
    const flow = await startAuthorization(config, firstParty, {
      resource: 'https://payroll.example.com',
    });
    const response = await browser.get(flow.url.href);
    const location = new URL(String(response.headers.location));
    expect(location.searchParams.get('error')).toBe('invalid_target');
  });

  it('refuses an access token for the resource at userinfo', async () => {
    const { flow, callback } = await authorize({ resource: ORDERS, scope: 'openid orders:read' });
    const tokens = await redeem(flow, callback);
    await expect(oidc.fetchUserInfo(config, tokens.access_token, USER)).rejects.toThrow();
  });
});

describe('third-party consent for a resource', () => {
  it('lists the resource scopes the client asks for', async () => {
    const started = await startEdge({ ...EDGE_CONFIG, thirdPartyClientsEnabled: true });
    started.store.setResources(thirdParty.client_id, [
      { identifier: ORDERS, scopes: ['orders:read'], accessTokenTtlSeconds: null },
    ]);
    const browser = new FakeBrowser(started.base);
    const config = await relyingParty(started.base, thirdParty);
    const flow = await startAuthorization(config, thirdParty, {
      resource: ORDERS,
      scope: 'openid orders:read',
    });
    const uid = interactionUid(await follow(browser, flow.url.href));
    signIn(browser);
    const login = await browser.post(`/interaction/${uid}/login`);
    const consentUid = interactionUid(
      await follow(browser, login.json<{ redirectTo: string }>().redirectTo),
    );
    const details = await browser.get(`/interaction/${consentUid}/details`);
    expect(details.json()).toMatchObject({
      prompt: {
        name: 'consent',
        missingResourceScopes: [{ resource: ORDERS, scopes: ['orders:read'] }],
      },
    });

    const consent = await browser.post(`/interaction/${consentUid}/consent`);
    const callback = await follow(browser, consent.json<{ redirectTo: string }>().redirectTo);
    const tokens = await oidc.authorizationCodeGrant(config, callback, {
      pkceCodeVerifier: flow.codeVerifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce,
    });
    expect(decodeJwt(tokens.access_token).payload).toMatchObject({
      aud: ORDERS,
      scope: 'orders:read',
      exp: expect.any(Number),
    });
  });
});
