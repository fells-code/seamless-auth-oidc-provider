/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import type { OidcClientMetadata } from '@seamless-auth/types';
import * as oidc from 'openid-client';
import { beforeEach, describe, expect, it } from 'vitest';

import { pkceRequired } from '../src/pkce.js';
import { FakeBrowser } from './browser.js';
import { EDGE_CONFIG } from './fakeApi.js';
import { firstParty, follow, interactionUid, relyingParty, signIn, startEdge } from './harness.js';

const SECRET = 'opted-in-secret-that-only-the-api-can-check';

const optedOut: OidcClientMetadata = {
  ...firstParty,
  client_id: 'confidential-no-pkce',
  token_endpoint_auth_method: 'client_secret_basic',
  redirect_uris: ['https://web.example.com/callback'],
  'urn:seamless:pkce_required': false,
};

function errorOf(response: { headers: Record<string, unknown> }) {
  return new URL(String(response.headers.location)).searchParams.get('error_description');
}

describe('per-application PKCE opt-out', () => {
  let started: Awaited<ReturnType<typeof startEdge>>;

  beforeEach(async () => {
    started = await startEdge({ ...EDGE_CONFIG, allowClientSecrets: true });
    started.store.addClient(optedOut);
    started.store.setSecret(optedOut.client_id, SECRET);
  });

  function authorizationUrl(
    config: oidc.Configuration,
    client: OidcClientMetadata,
    params: Record<string, string>,
  ) {
    return oidc.buildAuthorizationUrl(config, {
      redirect_uri: client.redirect_uris[0]!,
      scope: 'openid email',
      state: 'state',
      ...params,
    });
  }

  it('lets an opted-out confidential client use the code flow with a nonce and no PKCE', async () => {
    const config = await relyingParty(started.base, optedOut, oidc.ClientSecretBasic(SECRET));
    const browser = new FakeBrowser(started.base);
    const nonce = oidc.randomNonce();

    let landed = await follow(browser, authorizationUrl(config, optedOut, { nonce }).href);
    signIn(browser);
    const login = await browser.post(`/interaction/${interactionUid(landed)}/login`);
    landed = await follow(browser, login.json<{ redirectTo: string }>().redirectTo);

    const tokens = await oidc.authorizationCodeGrant(config, landed, {
      expectedState: 'state',
      expectedNonce: nonce,
    });
    expect(tokens.claims()?.nonce).toBe(nonce);
  });

  it('requires a nonce from an opted-out client that asks for an ID token without PKCE', async () => {
    const config = await relyingParty(started.base, optedOut, oidc.ClientSecretBasic(SECRET));
    const browser = new FakeBrowser(started.base);

    const response = await browser.get(authorizationUrl(config, optedOut, {}).href);

    expect(errorOf(response)).toBe('nonce is required when PKCE is not used');
  });

  it('lets a client that also waived the nonce use the code flow with neither', async () => {
    const neither = {
      ...optedOut,
      client_id: 'confidential-no-pkce-no-nonce',
      'urn:seamless:nonce_required': false,
    };
    started.store.addClient(neither);
    started.store.setSecret(neither.client_id, SECRET);
    const config = await relyingParty(started.base, neither, oidc.ClientSecretBasic(SECRET));
    const browser = new FakeBrowser(started.base);

    let landed = await follow(browser, authorizationUrl(config, neither, {}).href);
    signIn(browser);
    const login = await browser.post(`/interaction/${interactionUid(landed)}/login`);
    landed = await follow(browser, login.json<{ redirectTo: string }>().redirectTo);

    const tokens = await oidc.authorizationCodeGrant(config, landed, { expectedState: 'state' });
    expect(tokens.claims()?.nonce).toBeUndefined();
  });

  it('still accepts PKCE from an opted-out client', async () => {
    const config = await relyingParty(started.base, optedOut, oidc.ClientSecretBasic(SECRET));
    const browser = new FakeBrowser(started.base);
    const verifier = oidc.randomPKCECodeVerifier();
    const url = authorizationUrl(config, optedOut, {
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
    });

    const landed = await follow(browser, url.href);

    expect(landed.pathname).toMatch(/^\/interaction\//);
  });

  it('keeps PKCE required for a confidential client that did not opt out', async () => {
    const required = { ...optedOut, client_id: 'confidential-pkce' };
    delete required['urn:seamless:pkce_required'];
    started.store.addClient(required);
    started.store.setSecret(required.client_id, SECRET);
    const config = await relyingParty(started.base, required, oidc.ClientSecretBasic(SECRET));
    const browser = new FakeBrowser(started.base);

    const response = await browser.get(
      authorizationUrl(config, required, { nonce: oidc.randomNonce() }).href,
    );

    expect(errorOf(response)).toMatch(/requires PKCE/);
  });

  it('ignores an opt-out on a public client', async () => {
    const publicClient = {
      ...firstParty,
      client_id: 'public-no-pkce',
      'urn:seamless:pkce_required': false,
      'urn:seamless:nonce_required': false,
    };
    started.store.addClient(publicClient);
    const config = await relyingParty(started.base, publicClient);
    const browser = new FakeBrowser(started.base);

    const response = await browser.get(
      authorizationUrl(config, publicClient, { nonce: oidc.randomNonce() }).href,
    );

    expect(errorOf(response)).toMatch(/requires PKCE/);
  });
});

describe('pkceRequired', () => {
  const ctx = (params: Record<string, string>) =>
    ({ oidc: { params } }) as unknown as Parameters<typeof pkceRequired>[0];
  const client = { clientAuthMethod: 'client_secret_basic', 'urn:seamless:pkce_required': false };

  it('requires PKCE when an opted-out client does not ask for an ID token', () => {
    expect(pkceRequired(ctx({ scope: 'email', nonce: 'n' }), client)).toBe(true);
  });

  it('treats an empty nonce as none', () => {
    expect(() => pkceRequired(ctx({ scope: 'openid', nonce: '' }), client)).toThrow(
      expect.objectContaining({ error_description: 'nonce is required when PKCE is not used' }),
    );
  });

  it('requires PKCE when there is no client', () => {
    expect(pkceRequired(ctx({ scope: 'openid' }), undefined)).toBe(true);
  });
});
