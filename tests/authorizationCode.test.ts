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
  otherFirstParty,
  REDIRECT,
  relyingParty,
  SESSION,
  signIn,
  startAuthorization,
  startEdge,
  thirdParty,
  USER,
} from './harness.js';

describe('authorization code with PKCE', () => {
  let browser: FakeBrowser;
  let started: Awaited<ReturnType<typeof startEdge>>;

  beforeEach(async () => {
    started = await startEdge();
    browser = new FakeBrowser(started.base);
  });

  it('publishes discovery for the locked configuration', async () => {
    const config = await relyingParty(started.base, firstParty);
    const metadata = config.serverMetadata();
    expect(metadata).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      userinfo_endpoint: `${ISSUER}/userinfo`,
      jwks_uri: `${ISSUER}/jwks`,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      acr_values_supported: ['phr', 'phrh'],
      id_token_signing_alg_values_supported: ['RS256'],
    });
    expect(metadata.token_endpoint_auth_methods_supported).not.toContain('client_secret_jwt');
  });

  it('signs a first-party user in through a generic RP', async () => {
    const config = await relyingParty(started.base, firstParty);
    const { url, codeVerifier, state, nonce } = await startAuthorization(config, firstParty);

    const interaction = await follow(browser, url.href);
    const uid = interactionUid(interaction);

    const details = await browser.get(`/interaction/${uid}/details`);
    expect(details.json()).toMatchObject({
      prompt: { name: 'login' },
      client: { id: firstParty.client_id, firstParty: true, redirectHost: 'app.example.com' },
      scopes: ['openid', 'email'],
    });

    expect((await browser.post(`/interaction/${uid}/login`)).status).toBe(401);
    signIn(browser);
    const login = await browser.post(`/interaction/${uid}/login`);
    expect(login.status).toBe(200);

    const callback = await follow(browser, login.json<{ redirectTo: string }>().redirectTo);
    expect(callback.origin + callback.pathname).toBe(REDIRECT);

    const tokens = await oidc.authorizationCodeGrant(config, callback, {
      pkceCodeVerifier: codeVerifier,
      expectedState: state,
      expectedNonce: nonce,
    });
    const claims = tokens.claims();
    expect(claims).toMatchObject({
      iss: ISSUER,
      sub: USER,
      aud: firstParty.client_id,
      email: 'ada@example.com',
      email_verified: true,
      acr: 'phrh',
      amr: ['hwk', 'user', 'mfa'],
    });
    expect(claims?.roles).toBeUndefined();

    const userinfo = await oidc.fetchUserInfo(config, tokens.access_token, USER);
    expect(userinfo).toMatchObject({ sub: USER, email: 'ada@example.com' });

    // Every record the flow wrote and every token the API signed names the session.
    expect(started.store.signed).toEqual([
      { kind: 'id_token', clientId: firstParty.client_id, sessionId: SESSION },
    ]);
    const bound = [...started.store.records.values()].filter((r) =>
      ['Grant', 'Session', 'AuthorizationCode', 'AccessToken'].includes(r.model),
    );
    expect(bound.length).toBeGreaterThanOrEqual(4);
    expect(bound.every((record) => record.sessionId === SESSION)).toBe(true);

    // A second authorization rides the provider session with no interaction.
    const again = await startAuthorization(config, firstParty);
    const silent = await follow(browser, again.url.href);
    expect(silent.origin + silent.pathname).toBe(REDIRECT);
  });

  it('signs the same browser in to a second first-party app with no interaction', async () => {
    const config = await relyingParty(started.base, firstParty);
    const { url } = await startAuthorization(config, firstParty);
    const uid = interactionUid(await follow(browser, url.href));
    signIn(browser);
    const login = await browser.post(`/interaction/${uid}/login`);
    await follow(browser, login.json<{ redirectTo: string }>().redirectTo);

    const otherConfig = await relyingParty(started.base, otherFirstParty);
    const other = await startAuthorization(otherConfig, otherFirstParty);
    const callback = await follow(browser, other.url.href);
    expect(callback.origin + callback.pathname).toBe(otherFirstParty.redirect_uris[0]);
    const tokens = await oidc.authorizationCodeGrant(otherConfig, callback, {
      pkceCodeVerifier: other.codeVerifier,
      expectedState: other.state,
      expectedNonce: other.nonce,
    });
    expect(tokens.claims()).toMatchObject({
      sub: USER,
      aud: otherFirstParty.client_id,
      email: 'ada@example.com',
      acr: 'phrh',
    });
    const grants = [...started.store.records.values()].filter((r) => r.model === 'Grant');
    expect(new Set(grants.map((g) => g.payload.clientId))).toEqual(
      new Set([firstParty.client_id, otherFirstParty.client_id]),
    );
    expect(grants.every((g) => g.sessionId === SESSION)).toBe(true);
  });

  it('refuses PKCE-less requests', async () => {
    const config = await relyingParty(started.base, firstParty);
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: REDIRECT,
      scope: 'openid',
      state: 'x',
    });
    const response = await browser.get(url.href);
    const location = new URL(String(response.headers.location));
    expect(location.searchParams.get('error')).toBe('invalid_request');
  });

  it('refuses a recovery session', async () => {
    const config = await relyingParty(started.base, firstParty);
    const { url } = await startAuthorization(config, firstParty);
    const uid = interactionUid(await follow(browser, url.href));
    signIn(browser, SESSION, true);
    const login = await browser.post(`/interaction/${uid}/login`);
    expect(login.status).toBe(403);
    expect(login.json()).toEqual({ error: 'enrollment_required' });
  });

  it('leaves no grant behind when the API refuses the session', async () => {
    started.store.addAccount({
      sessionId: SESSION,
      claims: { sub: USER, roles: [], org_id: null },
      context: { recovery: true },
    });
    const config = await relyingParty(started.base, firstParty);
    const { url } = await startAuthorization(config, firstParty);
    const uid = interactionUid(await follow(browser, url.href));
    signIn(browser);
    const login = await browser.post(`/interaction/${uid}/login`);
    expect(login.json()).toEqual({ error: 'enrollment_required' });
    const grants = [...started.store.records.values()].filter((r) => r.model === 'Grant');
    expect(grants).toEqual([]);
  });

  it('refuses a cross-origin or sibling-subdomain request', async () => {
    const config = await relyingParty(started.base, firstParty);
    const { url } = await startAuthorization(config, firstParty);
    const uid = interactionUid(await follow(browser, url.href));
    signIn(browser);
    const crossOrigin: Record<string, string>[] = [
      { origin: 'https://app.example.com', 'sec-fetch-site': 'same-site' },
      { origin: 'https://evil.example.net', 'sec-fetch-site': 'cross-site' },
      { origin: 'https://app.example.com' },
      { 'sec-fetch-site': 'same-site' },
    ];
    for (const headers of crossOrigin) {
      const blocked = await browser.post(`/interaction/${uid}/login`, headers);
      expect(blocked.status).toBe(403);
    }
    const noSignals = await browser.post(`/interaction/${uid}/login`, {
      origin: '',
      'sec-fetch-site': '',
    });
    expect(noSignals.status).toBe(403);
  });

  it('refuses a page acting on another interaction', async () => {
    const config = await relyingParty(started.base, firstParty);
    const { url } = await startAuthorization(config, firstParty);
    await follow(browser, url.href);
    signIn(browser);
    const stale = await browser.post('/interaction/not-this-one/login');
    expect(stale.status).toBe(409);
    expect(stale.json()).toEqual({ error: 'interaction_mismatch' });
  });

  it('asks for a step-up when prompt=login', async () => {
    started.store.addAccount({
      sessionId: SESSION,
      claims: { sub: USER, roles: [], org_id: null },
      context: { authTime: Math.floor(Date.now() / 1000) - 3600 },
    });
    const config = await relyingParty(started.base, firstParty);
    const { url } = await startAuthorization(config, firstParty, { prompt: 'login' });
    const uid = interactionUid(await follow(browser, url.href));
    signIn(browser);
    const login = await browser.post(`/interaction/${uid}/login`);
    expect(login.status).toBe(409);
    expect(login.json()).toEqual({ error: 'step_up_required', methods: ['passkey'] });
  });

  it('lets the user abort', async () => {
    const config = await relyingParty(started.base, firstParty);
    const { url } = await startAuthorization(config, firstParty);
    const uid = interactionUid(await follow(browser, url.href));
    const abort = await browser.post(`/interaction/${uid}/abort`);
    const callback = await follow(browser, abort.json<{ redirectTo: string }>().redirectTo);
    expect(callback.searchParams.get('error')).toBe('access_denied');
  });

  it('answers an expired interaction plainly', async () => {
    const details = await browser.get('/interaction/gone/details');
    expect(details.status).toBe(404);
    expect(details.json()).toEqual({ error: 'interaction_expired' });
  });
});

describe('third-party clients', () => {
  it('do not exist while the instance has them off', async () => {
    const { base } = await startEdge();
    const browser = new FakeBrowser(base);
    const response = await browser.get(
      `/authorize?client_id=${thirdParty.client_id}&response_type=code&scope=openid`,
    );
    expect(response.status).toBe(400);
    expect(response.text).toContain('invalid_client');
  });

  it('show consent after sign-in, and again on the next authorization', async () => {
    const { base } = await startEdge({ ...EDGE_CONFIG, thirdPartyClientsEnabled: true });
    const browser = new FakeBrowser(base);
    const config = await relyingParty(base, thirdParty);
    const { url, codeVerifier, state, nonce } = await startAuthorization(config, thirdParty);

    const uid = interactionUid(await follow(browser, url.href));
    signIn(browser);
    const login = await browser.post(`/interaction/${uid}/login`);
    const consentPage = await follow(browser, login.json<{ redirectTo: string }>().redirectTo);
    const consentUid = interactionUid(consentPage);

    const details = await browser.get(`/interaction/${consentUid}/details`);
    expect(details.json()).toMatchObject({
      prompt: { name: 'consent', missingScopes: ['openid', 'email'] },
      client: { name: 'Partner App', firstParty: false, redirectHost: 'partner.example.net' },
    });

    expect((await browser.post(`/interaction/${uid}/consent`)).status).toBe(409);
    const consent = await browser.post(`/interaction/${consentUid}/consent`);
    const callback = await follow(browser, consent.json<{ redirectTo: string }>().redirectTo);
    const tokens = await oidc.authorizationCodeGrant(config, callback, {
      pkceCodeVerifier: codeVerifier,
      expectedState: state,
      expectedNonce: nonce,
    });
    expect(tokens.claims()).toMatchObject({ sub: USER, email: 'ada@example.com' });

    const again = await startAuthorization(config, thirdParty);
    const next = await follow(browser, again.url.href);
    const nextDetails = await browser.get(`/interaction/${interactionUid(next)}/details`);
    expect(nextDetails.json()).toMatchObject({ prompt: { name: 'consent' } });
  });
});
