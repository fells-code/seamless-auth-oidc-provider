/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import type { AddressInfo } from 'node:net';

import type { OidcClientMetadata } from '@seamless-auth/types';
import express from 'express';
import * as oidc from 'openid-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createOidcEdge } from '../src/createOidcEdge.js';
import { satisfiesFreshness } from '../src/interactions.js';
import { edgeFetch, FakeBrowser, firstPartyCookie } from './browser.js';
import { API_URL, createFakeApi, EDGE_CONFIG, ISSUER, json, SERVICE_SECRET } from './fakeApi.js';
import { createFakeStore } from './fakeStore.js';

const ADAPTER_SECRET = 'adapter-cookie-secret-that-is-at-least-32-chars';
const ACCESS_COOKIE = '__Host-seamless-access';
const USER = '6f1c1d0e-7a51-4b8e-9c3f-2d4e5f6a7b8c';
const SESSION = '0b6a3c2d-1e4f-4a5b-8c7d-9e0f1a2b3c4d';
const REDIRECT = 'https://app.example.com/callback';

const firstParty: OidcClientMetadata = {
  client_id: 'first-party-spa',
  client_name: 'Example App',
  application_type: 'web',
  token_endpoint_auth_method: 'none',
  grant_types: ['authorization_code'],
  response_types: ['code'],
  redirect_uris: [REDIRECT],
  post_logout_redirect_uris: [],
  'urn:seamless:first_party': true,
};

const thirdParty: OidcClientMetadata = {
  ...firstParty,
  client_id: 'third-party-spa',
  client_name: 'Partner App',
  redirect_uris: ['https://partner.example.net/callback'],
  'urn:seamless:first_party': false,
};

const servers: { close: () => void }[] = [];

afterEach(() => {
  servers.splice(0).forEach((server) => server.close());
});

async function startEdge(config = EDGE_CONFIG) {
  const api = createFakeApi();
  const store = createFakeStore();
  api.on((request) =>
    request.path === '/oidc/config' ? json(200, config) : store.handle(request),
  );
  store.addClient(firstParty);
  store.addClient(thirdParty);
  store.addAccount({
    sessionId: SESSION,
    claims: {
      sub: USER,
      email: 'ada@example.com',
      email_verified: true,
      roles: ['user'],
      org_id: null,
    },
  });

  const edge = await createOidcEdge({
    apiUrl: API_URL,
    serviceSecret: SERVICE_SECRET,
    cookieKeys: ['provider-cookie-key-that-is-at-least-32-chars'],
    adapterCookieSecret: ADAPTER_SECRET,
    fetchAdapterManifest: false,
    trustProxy: true,
    fetch: api.fetch,
  });
  const app = express();
  app.set('trust proxy', true);
  app.use(edge.router);
  const server = app.listen(0);
  servers.push(server);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { api, store, base, edge };
}

async function relyingParty(base: string, client: OidcClientMetadata) {
  const fetch = edgeFetch(base);
  const config = await oidc.discovery(new URL(ISSUER), client.client_id, undefined, oidc.None(), {
    [oidc.customFetch]: fetch,
  });
  config[oidc.customFetch] = fetch;
  return config;
}

async function startAuthorization(
  config: oidc.Configuration,
  client: OidcClientMetadata,
  extra: Record<string, string> = {},
) {
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const url = oidc.buildAuthorizationUrl(config, {
    redirect_uri: client.redirect_uris[0]!,
    scope: 'openid email',
    code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: 'S256',
    state,
    nonce,
    ...extra,
  });
  return { url, codeVerifier, state, nonce };
}

/** Follows redirects on the issuer's origin and returns where the browser leaves it. */
async function follow(browser: FakeBrowser, url: string): Promise<URL> {
  let current = new URL(url, ISSUER);
  for (let hops = 0; hops < 10; hops += 1) {
    if (current.origin !== new URL(ISSUER).origin || current.pathname.startsWith('/interaction/')) {
      return current;
    }
    const response = await browser.get(current.href);
    const location = response.headers.location;
    if (typeof location !== 'string') {
      throw new Error(`No redirect from ${current.pathname}: ${response.status} ${response.text}`);
    }
    current = new URL(location, current);
  }
  throw new Error('Too many redirects');
}

function interactionUid(url: URL): string {
  const uid = url.pathname.split('/')[2];
  if (!url.pathname.startsWith('/interaction/') || !uid) {
    throw new Error(`Not an interaction: ${url.href}`);
  }
  return uid;
}

function signIn(browser: FakeBrowser, sessionId = SESSION, recovery = false) {
  browser.cookies.set(
    ACCESS_COOKIE,
    firstPartyCookie(ADAPTER_SECRET, { sub: USER, sessionId, recovery }),
  );
}

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

  it('asks for a fresh sign-in when prompt=login', async () => {
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
    expect(login.json()).toEqual({ error: 'reauthentication_required' });
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

describe('satisfiesFreshness', () => {
  const interaction = (reasons: string[], params: Record<string, unknown> = {}) =>
    ({ iat: 1000, prompt: { name: 'login', reasons, details: {} }, params }) as never;

  it('needs an authentication after the request for prompt=login', () => {
    expect(satisfiesFreshness(interaction(['login_prompt']), 999, 1100)).toBe(false);
    expect(satisfiesFreshness(interaction(['login_prompt']), 1000, 1100)).toBe(true);
  });

  it('honours max_age', () => {
    expect(satisfiesFreshness(interaction([], { max_age: '60' }), 1000, 1100)).toBe(false);
    expect(satisfiesFreshness(interaction([], { max_age: 200 }), 1000, 1100)).toBe(true);
    expect(satisfiesFreshness(interaction(['no_session']), 0, 1100)).toBe(true);
  });
});
