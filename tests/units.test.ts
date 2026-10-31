/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import type { KoaContextWithOIDC } from 'oidc-provider';
import { describe, expect, it } from 'vitest';

import { OidcApiClient } from '../src/apiClient.js';
import { EdgeConfigCache } from '../src/configCache.js';
import { OidcProviderDisabledError } from '../src/errors.js';
import { readFirstPartySession } from '../src/firstPartySession.js';
import { buildProviderConfiguration, loadExistingGrant } from '../src/providerConfig.js';
import { bindSession } from '../src/requestContext.js';
import { ApiSigningKey } from '../src/signingKey.js';
import { firstPartyCookie } from './browser.js';
import { API_URL, createFakeApi, EDGE_CONFIG, json, rsaKey, SERVICE_SECRET } from './fakeApi.js';

const renderPage = async () => ({ html: '', headers: {} });

const SECRET = 'adapter-cookie-secret-that-is-at-least-32-chars';

describe('EdgeConfigCache', () => {
  it('re-reads the config once it is stale, with one request at a time', async () => {
    const api = createFakeApi();
    let enabled = true;
    api.on(({ path }) =>
      path === '/oidc/config'
        ? json(200, { ...EDGE_CONFIG, thirdPartyClientsEnabled: enabled })
        : undefined,
    );
    const client = new OidcApiClient({
      apiUrl: API_URL,
      serviceSecret: SERVICE_SECRET,
      fetch: api.fetch,
    });
    let now = 0;
    const cache = new EdgeConfigCache(client, EDGE_CONFIG, { ttlMs: 1000, now: () => now });

    expect((await cache.get()).thirdPartyClientsEnabled).toBe(false);
    expect(api.requests).toHaveLength(0);

    now = 1000;
    const [a, b] = await Promise.all([cache.get(), cache.get()]);
    expect(a.thirdPartyClientsEnabled).toBe(true);
    expect(b).toBe(a);
    expect(api.requests).toHaveLength(1);

    enabled = false;
    now = 1500;
    expect((await cache.get()).thirdPartyClientsEnabled).toBe(true);
  });

  it('fails closed once the API turns the provider off', async () => {
    const api = createFakeApi();
    api.on(({ path }) => (path === '/oidc/config' ? json(404, { error: 'Not Found' }) : undefined));
    const client = new OidcApiClient({
      apiUrl: API_URL,
      serviceSecret: SERVICE_SECRET,
      fetch: api.fetch,
    });
    const cache = new EdgeConfigCache(client, EDGE_CONFIG, { ttlMs: 0 });
    await expect(cache.get()).rejects.toBeInstanceOf(OidcProviderDisabledError);
  });
});

describe('readFirstPartySession', () => {
  it('reads the user and session from the adapter cookie', () => {
    const cookie = firstPartyCookie(SECRET, { sub: 'u1', sessionId: 's1' });
    expect(readFirstPartySession(cookie, SECRET)).toEqual({
      session: { userId: 'u1', sessionId: 's1' },
    });
  });

  it('refuses a missing, forged or session-less cookie', () => {
    expect(readFirstPartySession(undefined, SECRET).rejection).toEqual({
      status: 401,
      error: 'login_required',
    });
    const forged = firstPartyCookie('another-secret-that-is-at-least-32-chars!', {
      sub: 'u1',
      sessionId: 's1',
    });
    expect(readFirstPartySession(forged, SECRET).rejection?.status).toBe(401);
    const noSession = firstPartyCookie(SECRET, { sub: 'u1' });
    expect(readFirstPartySession(noSession, SECRET).rejection).toEqual({
      status: 401,
      error: 'login_required',
    });
  });
});

describe('bindSession', () => {
  it('needs a request context', () => {
    expect(() => bindSession('s1')).toThrow(/outside a request context/);
  });
});

describe('loadExistingGrant', () => {
  it('has nothing to load without a client', async () => {
    const ctx = { oidc: {} } as unknown as KoaContextWithOIDC;
    await expect(loadExistingGrant(ctx)).resolves.toBeUndefined();
  });
});

describe('clientBasedCORS', () => {
  const client = new OidcApiClient({ apiUrl: API_URL, serviceSecret: SERVICE_SECRET });
  const { jwk } = rsaKey('k');
  const configuration = buildProviderConfiguration({
    client,
    renderPage,
    config: EDGE_CONFIG,
    configCache: new EdgeConfigCache(client, EDGE_CONFIG),
    signingKeys: [new ApiSigningKey({ ...jwk, kid: 'k', alg: 'RS256' }, client, true)],
    cookieKeys: [],
  });
  const cors = configuration.clientBasedCORS!;
  const ctx = (route: string) => ({ oidc: { route } }) as unknown as KoaContextWithOIDC;
  const rp = (clientAuthMethod: string) =>
    ({ clientAuthMethod, redirectUris: ['https://app.example.com/cb'] }) as never;

  it('allows a public client or userinfo from a redirect origin only', () => {
    expect(cors(ctx('token'), 'https://app.example.com', rp('none'))).toBe(true);
    expect(cors(ctx('userinfo'), 'https://app.example.com', rp('private_key_jwt'))).toBe(true);
    expect(cors(ctx('token'), 'https://app.example.com', rp('private_key_jwt'))).toBe(false);
    expect(cors(ctx('token'), 'https://evil.example.net', rp('none'))).toBe(false);
    expect(cors(ctx('token'), 'null', rp('none'))).toBe(false);
  });
});
