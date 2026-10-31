/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import { randomUUID, webcrypto } from 'node:crypto';

import type { OidcClientMetadata } from '@seamless-auth/types';
import * as oidc from 'openid-client';
import { describe, expect, it } from 'vitest';

import { FakeBrowser, sendToEdge } from './browser.js';
import { EDGE_CONFIG, ISSUER } from './fakeApi.js';
import {
  firstParty,
  follow,
  interactionUid,
  relyingParty,
  signIn,
  startAuthorization,
  startEdge,
} from './harness.js';

const SECRET = 'opted-in-secret-that-only-the-api-can-check';
const WEB_CALLBACK = 'https://web.example.com/callback';

async function signingKey() {
  const { privateKey, publicKey } = await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = await webcrypto.subtle.exportKey('jwk', publicKey);
  const kid = randomUUID();
  return {
    privateKey,
    kid,
    publicJwk: {
      kty: 'EC',
      crv: 'P-256',
      x: jwk.x!,
      y: jwk.y!,
      kid,
      alg: 'ES256',
      use: 'sig' as const,
    },
  };
}

function confidential(
  clientId: string,
  method: OidcClientMetadata['token_endpoint_auth_method'],
  extra: Partial<OidcClientMetadata> = {},
): OidcClientMetadata {
  return {
    ...firstParty,
    client_id: clientId,
    client_name: clientId,
    token_endpoint_auth_method: method,
    redirect_uris: [WEB_CALLBACK],
    ...extra,
  };
}

/** A code for the client, signing in first unless the browser's provider session covers it. */
async function signedIn(
  browser: FakeBrowser,
  config: oidc.Configuration,
  client: OidcClientMetadata,
) {
  const flow = await startAuthorization(config, client);
  let landed = await follow(browser, flow.url.href);
  if (landed.pathname.startsWith('/interaction/')) {
    signIn(browser);
    const login = await browser.post(`/interaction/${interactionUid(landed)}/login`);
    landed = await follow(browser, login.json<{ redirectTo: string }>().redirectTo);
  }
  return { ...flow, callback: landed };
}

function base64url(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

async function assertion(clientId: string, key: Awaited<ReturnType<typeof signingKey>>) {
  const now = Math.floor(Date.now() / 1000);
  const input = `${base64url({ alg: 'ES256', kid: key.kid })}.${base64url({
    iss: clientId,
    sub: clientId,
    aud: ISSUER,
    jti: randomUUID(),
    iat: now,
    exp: now + 60,
  })}`;
  const signature = await webcrypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key.privateKey,
    Buffer.from(input),
  );
  return `${input}.${Buffer.from(signature).toString('base64url')}`;
}

describe('discovery', () => {
  it('offers private_key_jwt and none, and shared secrets only when the instance allows them', async () => {
    const off = await startEdge();
    const offMetadata = (await relyingParty(off.base, firstParty)).serverMetadata();
    expect(new Set(offMetadata.token_endpoint_auth_methods_supported)).toEqual(
      new Set(['none', 'private_key_jwt']),
    );

    const on = await startEdge({ ...EDGE_CONFIG, allowClientSecrets: true });
    const onMetadata = (await relyingParty(on.base, firstParty)).serverMetadata();
    expect(new Set(onMetadata.token_endpoint_auth_methods_supported)).toEqual(
      new Set(['none', 'private_key_jwt', 'client_secret_basic', 'client_secret_post']),
    );
    for (const metadata of [offMetadata, onMetadata]) {
      expect(metadata.token_endpoint_auth_methods_supported).not.toContain('client_secret_jwt');
      expect(
        (metadata.token_endpoint_auth_signing_alg_values_supported ?? []).some((alg) =>
          alg.startsWith('HS'),
        ),
      ).toBe(false);
      expect(
        (metadata.id_token_signing_alg_values_supported ?? []).some((alg) => alg.startsWith('HS')),
      ).toBe(false);
    }
  });
});

describe('private_key_jwt', () => {
  it('authenticates a confidential client with a signed assertion, once', async () => {
    const key = await signingKey();
    const client = confidential('confidential-web', 'private_key_jwt', {
      jwks: { keys: [key.publicJwk] },
    });
    const { base, store } = await startEdge();
    store.addClient(client);
    const browser = new FakeBrowser(base);
    const config = await relyingParty(
      base,
      client,
      oidc.PrivateKeyJwt({ key: key.privateKey, kid: key.kid }),
    );

    const first = await signedIn(browser, config, client);
    const tokens = await oidc.authorizationCodeGrant(config, first.callback, {
      pkceCodeVerifier: first.codeVerifier,
      expectedState: first.state,
      expectedNonce: first.nonce,
    });
    expect(tokens.claims()?.aud).toBe(client.client_id);

    // Replaying one assertion: the second use is refused before the grant is looked at.
    const second = await signedIn(browser, config, client);
    const third = await signedIn(browser, config, client);
    const replayed = await assertion(client.client_id, key);
    const exchange = (flow: typeof second) =>
      sendToEdge(base, '/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: flow.callback.searchParams.get('code') ?? '',
          redirect_uri: WEB_CALLBACK,
          code_verifier: flow.codeVerifier,
          client_id: client.client_id,
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          client_assertion: replayed,
        }).toString(),
      });
    expect((await exchange(second)).status).toBe(200);
    const again = await exchange(third);
    expect(again.status).toBe(401);
    expect(again.json()).toMatchObject({ error: 'invalid_client' });
  });

  it('refuses an assertion signed by a key the client did not register', async () => {
    const registered = await signingKey();
    const other = await signingKey();
    const client = confidential('confidential-web', 'private_key_jwt', {
      jwks: { keys: [registered.publicJwk] },
    });
    const { base, store } = await startEdge();
    store.addClient(client);
    const config = await relyingParty(
      base,
      client,
      oidc.PrivateKeyJwt({ key: other.privateKey, kid: registered.kid }),
    );
    const flow = await signedIn(new FakeBrowser(base), config, client);
    await expect(
      oidc.authorizationCodeGrant(config, flow.callback, {
        pkceCodeVerifier: flow.codeVerifier,
        expectedState: flow.state,
        expectedNonce: flow.nonce,
      }),
    ).rejects.toMatchObject({ error: 'invalid_client' });
  });
});

describe('shared secrets', () => {
  const basicClient = confidential('secret-basic', 'client_secret_basic');
  const postClient = confidential('secret-post', 'client_secret_post');

  async function secretsOn() {
    const started = await startEdge({ ...EDGE_CONFIG, allowClientSecrets: true });
    started.store.addClient(basicClient);
    started.store.addClient(postClient);
    started.store.setSecret(basicClient.client_id, SECRET);
    started.store.setSecret(postClient.client_id, SECRET);
    return started;
  }

  it('work for an opted-in client, checked by the API, over Basic and in the body', async () => {
    const { base, store } = await secretsOn();
    for (const [client, auth] of [
      [basicClient, oidc.ClientSecretBasic(SECRET)],
      [postClient, oidc.ClientSecretPost(SECRET)],
    ] as const) {
      const config = await relyingParty(base, client, auth);
      const flow = await signedIn(new FakeBrowser(base), config, client);
      const tokens = await oidc.authorizationCodeGrant(config, flow.callback, {
        pkceCodeVerifier: flow.codeVerifier,
        expectedState: flow.state,
        expectedNonce: flow.nonce,
      });
      expect(tokens.claims()?.aud).toBe(client.client_id);
    }
    expect(store.verified).toEqual([
      { clientId: basicClient.client_id, secret: SECRET },
      { clientId: postClient.client_id, secret: SECRET },
    ]);
  });

  it('refuse a secret the API does not accept', async () => {
    const { base } = await secretsOn();
    for (const [client, auth] of [
      [basicClient, oidc.ClientSecretBasic('wrong')],
      [postClient, oidc.ClientSecretPost('wrong')],
    ] as const) {
      const config = await relyingParty(base, client, auth);
      const flow = await signedIn(new FakeBrowser(base), config, client);
      await expect(
        oidc.authorizationCodeGrant(config, flow.callback, {
          pkceCodeVerifier: flow.codeVerifier,
          expectedState: flow.state,
          expectedNonce: flow.nonce,
        }),
      ).rejects.toMatchObject({ status: 401 });
    }
  });

  it('refuse a client that is not opted in, whatever it presents', async () => {
    const { base, store } = await startEdge({ ...EDGE_CONFIG, allowClientSecrets: true });
    store.addClient(basicClient);
    const config = await relyingParty(base, basicClient, oidc.ClientSecretBasic(SECRET));
    const flow = await signedIn(new FakeBrowser(base), config, basicClient);
    await expect(
      oidc.authorizationCodeGrant(config, flow.callback, {
        pkceCodeVerifier: flow.codeVerifier,
        expectedState: flow.state,
        expectedNonce: flow.nonce,
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('do not exist on an instance that does not allow them', async () => {
    const { base, store } = await startEdge();
    store.addClient(basicClient);
    const response = await new FakeBrowser(base).get(
      `/authorize?client_id=${basicClient.client_id}&response_type=code&scope=openid`,
    );
    expect(response.status).toBe(400);
    expect(response.text).toContain('invalid_client');
  });

  it('leave two mechanisms at once to the library to refuse', async () => {
    const { base, store } = await secretsOn();
    const response = await sendToEdge(base, '/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${basicClient.client_id}:${SECRET}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'x',
        client_id: basicClient.client_id,
        client_secret: SECRET,
      }).toString(),
    });
    expect(response.status).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_request' });
    expect(store.verified).toEqual([]);
  });

  it('refuse an oversized body before reading it all', async () => {
    const { base } = await secretsOn();
    const response = await sendToEdge(base, '/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `grant_type=authorization_code&pad=${'a'.repeat(60 * 1024)}`,
    });
    expect(response.status).toBe(413);
  });
});
