/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import { sign as cryptoSign } from 'node:crypto';

import * as oidc from 'openid-client';
import { beforeEach, describe, expect, it } from 'vitest';

import { FakeBrowser, sendToEdge } from './browser.js';
import { json, rsaKey } from './fakeApi.js';
import {
  firstParty,
  follow,
  interactionUid,
  relyingParty,
  signIn,
  startAuthorization,
  startEdge,
} from './harness.js';

function headerOf(token: string) {
  return JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString()) as {
    kid?: string;
  };
}

describe('provider key rotation', () => {
  let started: Awaited<ReturnType<typeof startEdge>>;
  let config: oidc.Configuration;
  const next = rsaKey('next');

  /** What the API does once its active key changes: it signs only with the new one. */
  function rotate() {
    started.api.on((request) => {
      if (request.method === 'GET' && request.path === '/oidc/jwks') {
        return json(200, { activeKid: 'next', keys: [next.jwk, started.api.active.jwk] });
      }
      if (request.method === 'POST' && request.path === '/oidc/sign') {
        const body = request.body as { kid: string; signingInput: string };
        if (body.kid !== 'next') {
          return json(403, { error: 'unknown_key' });
        }
        const refused = started.store.handle(request);
        if (refused) {
          return refused;
        }
        const signature = cryptoSign('sha256', Buffer.from(body.signingInput), next.privateKey);
        return json(200, { kid: 'next', signature: signature.toString('base64url') });
      }
      return undefined;
    });
  }

  async function signInOnce() {
    const browser = new FakeBrowser(started.base);
    const flow = await startAuthorization(config, firstParty);
    const uid = interactionUid(await follow(browser, flow.url.href));
    signIn(browser);
    const login = await browser.post(`/interaction/${uid}/login`);
    const callback = await follow(browser, login.json<{ redirectTo: string }>().redirectTo);
    return oidc.authorizationCodeGrant(config, callback, {
      pkceCodeVerifier: flow.codeVerifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce,
    });
  }

  beforeEach(async () => {
    started = await startEdge();
    config = await relyingParty(started.base, firstParty);
  });

  it('reloads the keys when the API answers unknown_key', async () => {
    expect(headerOf((await signInOnce()).id_token!).kid).toBe('active');
    rotate();

    // The request that meets the rotation may fail; the edge must not stay on the old key.
    await signInOnce().catch(() => undefined);
    const tokens = await signInOnce();
    expect(headerOf(tokens.id_token!).kid).toBe('next');

    const jwks = (await sendToEdge(started.base, '/jwks')).json<{ keys: { kid: string }[] }>();
    expect(jwks.keys.map((key) => key.kid)).toContain('next');
  });
});
