/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import type { AddressInfo } from 'node:net';

import type { OidcClientMetadata } from '@seamless-auth/types';
import express from 'express';
import * as oidc from 'openid-client';
import { afterEach } from 'vitest';

import { createOidcEdge } from '../src/createOidcEdge.js';
import type { FakeBrowser } from './browser.js';
import { edgeFetch, firstPartyCookie } from './browser.js';
import {
  API_URL,
  createFakeApi,
  EDGE_CONFIG,
  ISSUER,
  json,
  SERVICE_SECRET,
  UI_FIXTURE_DIR,
} from './fakeApi.js';
import { createFakeStore } from './fakeStore.js';

export const ADAPTER_SECRET = 'adapter-cookie-secret-that-is-at-least-32-chars';
export const ACCESS_COOKIE = '__Host-seamless-access';
export const USER = '6f1c1d0e-7a51-4b8e-9c3f-2d4e5f6a7b8c';
export const SESSION = '0b6a3c2d-1e4f-4a5b-8c7d-9e0f1a2b3c4d';
export const REDIRECT = 'https://app.example.com/callback';

export const firstParty: OidcClientMetadata = {
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

export const otherFirstParty: OidcClientMetadata = {
  ...firstParty,
  client_id: 'first-party-calendar',
  client_name: 'Example Calendar',
  redirect_uris: ['https://calendar.example.com/callback'],
};

export const thirdParty: OidcClientMetadata = {
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

export async function startEdge(config = EDGE_CONFIG) {
  const api = createFakeApi();
  const store = createFakeStore();
  api.on((request) =>
    request.path === '/oidc/config' ? json(200, config) : store.handle(request),
  );
  store.addClient(firstParty);
  store.addClient(otherFirstParty);
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
    uiDir: UI_FIXTURE_DIR,
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

export async function relyingParty(base: string, client: OidcClientMetadata) {
  const fetch = edgeFetch(base);
  const config = await oidc.discovery(new URL(ISSUER), client.client_id, undefined, oidc.None(), {
    [oidc.customFetch]: fetch,
  });
  config[oidc.customFetch] = fetch;
  return config;
}

export async function startAuthorization(
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
export async function follow(browser: FakeBrowser, url: string): Promise<URL> {
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

export function interactionUid(url: URL): string {
  const uid = url.pathname.split('/')[2];
  if (!url.pathname.startsWith('/interaction/') || !uid) {
    throw new Error(`Not an interaction: ${url.href}`);
  }
  return uid;
}

export function signIn(browser: FakeBrowser, sessionId = SESSION, recovery = false) {
  browser.cookies.set(
    ACCESS_COOKIE,
    firstPartyCookie(ADAPTER_SECRET, { sub: USER, sessionId, recovery }),
  );
}
