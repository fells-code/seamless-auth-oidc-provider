/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import type { OidcClientMetadata } from '@seamless-auth/types';
import * as oidc from 'openid-client';
import { beforeEach, describe, expect, it } from 'vitest';

import { FakeBrowser } from './browser.js';
import {
  firstParty,
  follow,
  interactionUid,
  relyingParty,
  signIn,
  startAuthorization,
  startEdge,
} from './harness.js';

const ORDERS = 'https://orders.example.com';

const shortLived: OidcClientMetadata = {
  ...firstParty,
  client_id: 'first-party-short',
  token_endpoint_auth_method: 'none',
  application_type: 'native',
  redirect_uris: ['http://127.0.0.1/callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  'urn:seamless:access_token_ttl': 120,
  'urn:seamless:id_token_ttl': 90,
  'urn:seamless:refresh_token_ttl': 3600,
};

function payloadOf(token: string) {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as Record<
    string,
    number
  >;
}

describe('per-application token lifetimes', () => {
  let started: Awaited<ReturnType<typeof startEdge>>;

  async function signInAs(client: OidcClientMetadata, extra: Record<string, string> = {}) {
    const browser = new FakeBrowser(started.base);
    const config = await relyingParty(started.base, client);
    const flow = await startAuthorization(config, client, {
      scope: 'openid email offline_access',
      prompt: 'consent',
      ...extra,
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
    const tokens = await oidc.authorizationCodeGrant(config, landed, {
      pkceCodeVerifier: flow.codeVerifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce,
    });
    return { tokens, config };
  }

  function refreshRecordTtl() {
    const records = [...started.store.records.values()].filter((r) => r.model === 'RefreshToken');
    const latest = records.at(-1)!;
    return Math.round((latest.expiresAt - Date.now()) / 1000);
  }

  beforeEach(async () => {
    started = await startEdge();
    started.store.addClient(shortLived);
  });

  it("applies the application's ID, access and refresh token lifetimes", async () => {
    const { tokens } = await signInAs(shortLived);

    const idToken = payloadOf(tokens.id_token!);
    expect(idToken.exp! - idToken.iat!).toBe(90);
    expect(tokens.expires_in).toBeGreaterThanOrEqual(119);
    expect(tokens.expires_in).toBeLessThanOrEqual(120);
    expect(refreshRecordTtl()).toBeGreaterThan(3590);
    expect(refreshRecordTtl()).toBeLessThanOrEqual(3600);
  });

  it('keeps the defaults for an application without its own', async () => {
    const plain = { ...shortLived, client_id: 'first-party-plain' };
    delete plain['urn:seamless:access_token_ttl'];
    delete plain['urn:seamless:id_token_ttl'];
    delete plain['urn:seamless:refresh_token_ttl'];
    started.store.addClient(plain);

    const { tokens } = await signInAs(plain);

    const idToken = payloadOf(tokens.id_token!);
    expect(idToken.exp! - idToken.iat!).toBe(600);
    expect(tokens.expires_in).toBeGreaterThanOrEqual(599);
    expect(refreshRecordTtl()).toBeGreaterThan(14 * 86_400 - 10);
  });

  it("takes the shorter of the resource's and the application's access token lifetime", async () => {
    started.store.setResources(shortLived.client_id, [
      { identifier: ORDERS, scopes: ['orders:read'], accessTokenTtlSeconds: 300 },
    ]);
    const { tokens } = await signInAs(shortLived, {
      resource: ORDERS,
      scope: 'openid orders:read',
    });
    const access = payloadOf(tokens.access_token);
    expect(access.exp! - access.iat!).toBe(120);

    const longer = {
      ...shortLived,
      client_id: 'first-party-long',
      'urn:seamless:access_token_ttl': 900,
    };
    started.store.addClient(longer);
    started.store.setResources(longer.client_id, [
      { identifier: ORDERS, scopes: ['orders:read'], accessTokenTtlSeconds: 300 },
    ]);
    const second = await signInAs(longer, { resource: ORDERS, scope: 'openid orders:read' });
    const forResource = payloadOf(second.tokens.access_token);
    expect(forResource.exp! - forResource.iat!).toBe(300);
  });
});
