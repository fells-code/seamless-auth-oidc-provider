/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import type { OidcClientMetadata } from '@seamless-auth/types';
import * as oidc from 'openid-client';
import { beforeEach, describe, expect, it } from 'vitest';

import { FakeBrowser, sendToEdge } from './browser.js';
import {
  firstParty,
  follow,
  interactionUid,
  REDIRECT,
  relyingParty,
  signIn,
  startAuthorization,
  startEdge,
} from './harness.js';

const desktop: OidcClientMetadata = {
  ...firstParty,
  client_id: 'desktop-app',
  client_name: 'Desktop App',
  application_type: 'native',
  redirect_uris: ['http://127.0.0.1/callback', 'http://[::1]/callback', 'com.example.app:/oauth'],
};

/** The error the provider sent back to the client, in the query or the fragment. */
function errorOf(response: { headers: Record<string, unknown> }) {
  const location = new URL(String(response.headers.location));
  return (
    location.searchParams.get('error') ?? new URLSearchParams(location.hash.slice(1)).get('error')
  );
}

describe('native and desktop clients (RFC 8252)', () => {
  let started: Awaited<ReturnType<typeof startEdge>>;
  let browser: FakeBrowser;
  let config: oidc.Configuration;

  async function signInAt(redirectUri: string) {
    const flow = await startAuthorization(config, desktop, { redirect_uri: redirectUri });
    const uid = interactionUid(await follow(browser, flow.url.href));
    signIn(browser);
    const login = await browser.post(`/interaction/${uid}/login`);
    const callback = await follow(browser, login.json<{ redirectTo: string }>().redirectTo);
    return { flow, callback };
  }

  beforeEach(async () => {
    started = await startEdge();
    started.store.addClient(desktop);
    browser = new FakeBrowser(started.base);
    config = await relyingParty(started.base, desktop);
  });

  it('returns to a loopback redirect on whatever port the app picked', async () => {
    const redirectUri = 'http://127.0.0.1:53124/callback';
    const { flow, callback } = await signInAt(redirectUri);
    expect(`${callback.origin}${callback.pathname}`).toBe(redirectUri);
    const tokens = await oidc.authorizationCodeGrant(config, callback, {
      pkceCodeVerifier: flow.codeVerifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce,
    });
    expect(tokens.claims()).toMatchObject({ aud: desktop.client_id });
  });

  it('accepts the IPv6 loopback and a private-use scheme', async () => {
    const ipv6 = await signInAt('http://[::1]:61000/callback');
    expect(ipv6.callback.host).toBe('[::1]:61000');
    browser = new FakeBrowser(started.base);
    const scheme = await signInAt('com.example.app:/oauth');
    expect(scheme.callback.protocol).toBe('com.example.app:');
  });

  it('refuses a redirect that differs in host, path or scheme', async () => {
    for (const redirectUri of [
      'http://localhost:53124/callback',
      'http://127.0.0.1:53124/other',
      'https://127.0.0.1:53124/callback',
      'http://127.0.0.2:53124/callback',
      'com.example.other:/oauth',
    ]) {
      const flow = await startAuthorization(config, desktop, { redirect_uri: redirectUri });
      const response = await browser.get(flow.url.href);
      expect(response.status, redirectUri).toBe(400);
      expect(response.text, redirectUri).toContain('redirect_uri');
    }
  });

  it('never ignores the port for a web client', async () => {
    const flow = await startAuthorization(
      await relyingParty(started.base, firstParty),
      firstParty,
      {
        redirect_uri: 'https://app.example.com:8443/callback',
      },
    );
    expect((await browser.get(flow.url.href)).status).toBe(400);
  });
});

describe('OAuth 2.1 and RFC 9700 defaults', () => {
  let started: Awaited<ReturnType<typeof startEdge>>;
  let browser: FakeBrowser;
  let config: oidc.Configuration;

  beforeEach(async () => {
    started = await startEdge();
    browser = new FakeBrowser(started.base);
    config = await relyingParty(started.base, firstParty);
  });

  it('offers only the code flow, S256 and the authorization response iss', () => {
    expect(config.serverMetadata()).toMatchObject({
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
    });
    expect(config.serverMetadata().grant_types_supported).not.toContain('password');
    expect(config.serverMetadata().grant_types_supported).not.toContain('implicit');
  });

  it('refuses implicit, hybrid and plain PKCE requests', async () => {
    const requests: Record<string, string>[] = [
      { response_type: 'token' },
      { response_type: 'id_token' },
      { response_type: 'code id_token' },
      { code_challenge_method: 'plain', code_challenge: 'x'.repeat(43) },
    ];
    for (const extra of requests) {
      const flow = await startAuthorization(config, firstParty, extra);
      const error = errorOf(await browser.get(flow.url.href));
      expect(error, JSON.stringify(extra)).toMatch(/unsupported_response_type|invalid_request/);
    }
  });

  it('refuses the password grant', async () => {
    const token = await sendToEdge(started.base, '/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: firstParty.client_id,
        username: 'ada',
        password: 'x',
      }).toString(),
    });
    expect(token.json()).toMatchObject({ error: 'unsupported_grant_type' });
  });

  it('accepts a code once, and revokes what it issued when it comes back', async () => {
    const flow = await startAuthorization(config, firstParty);
    const uid = interactionUid(await follow(browser, flow.url.href));
    signIn(browser);
    const login = await browser.post(`/interaction/${uid}/login`);
    const callback = await follow(browser, login.json<{ redirectTo: string }>().redirectTo);
    expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT);
    expect(callback.searchParams.get('iss')).toBe(config.serverMetadata().issuer);

    const options = {
      pkceCodeVerifier: flow.codeVerifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce,
    };
    const tokens = await oidc.authorizationCodeGrant(config, callback, options);
    await expect(oidc.authorizationCodeGrant(config, callback, options)).rejects.toMatchObject({
      error: 'invalid_grant',
    });
    await expect(
      oidc.fetchUserInfo(config, tokens.access_token, tokens.claims()!.sub),
    ).rejects.toThrow();
  });
});
