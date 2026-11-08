/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import type { OidcClientMetadata } from '@seamless-auth/types';
import * as oidc from 'openid-client';
import { beforeEach, describe, expect, it } from 'vitest';

import { FakeBrowser } from './browser.js';
import type { FakeAccount } from './fakeStore.js';
import {
  firstParty,
  follow,
  interactionUid,
  relyingParty,
  SESSION,
  signIn,
  startAuthorization,
  startEdge,
  USER,
} from './harness.js';

const ORDERS = 'https://orders.example.com';

const refreshing: OidcClientMetadata = {
  ...firstParty,
  grant_types: ['authorization_code', 'refresh_token'],
};

const MEMBER: FakeAccount['claims'] = {
  sub: USER,
  email: 'ada@example.com',
  email_verified: true,
  roles: ['user'],
  org_id: 'org-1',
  permissions: ['orders:read'],
  org_roles: ['member'],
  org_permissions: ['projects:read'],
  customClaims: { tier: 'gold', limits: { seats: 5, regions: ['us', 'eu'] } },
};

const PERMISSION_CLAIMS = {
  roles: ['user'],
  org_id: 'org-1',
  permissions: ['orders:read'],
  org_roles: ['member'],
  org_permissions: ['projects:read'],
};

const CUSTOM_CLAIMS = { tier: 'gold', limits: { seats: 5, regions: ['us', 'eu'] } };

function payloadOf(token: string) {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as Record<
    string,
    unknown
  >;
}

describe('roles, permissions and custom claims (#47)', () => {
  let started: Awaited<ReturnType<typeof startEdge>>;
  let browser: FakeBrowser;
  let app: oidc.Configuration;

  function setAccount(claims: FakeAccount['claims']) {
    started.store.addAccount({ sessionId: SESSION, claims });
  }

  async function userTokens(extra: Record<string, string>) {
    const flow = await startAuthorization(app, refreshing, extra);
    let landed = await follow(browser, flow.url.href);
    signIn(browser);
    for (let step = 0; step < 3 && landed.pathname.startsWith('/interaction/'); step += 1) {
      const uid = interactionUid(landed);
      const details = await browser.get(`/interaction/${uid}/details`);
      const name = details.json<{ prompt: { name: string } }>().prompt.name;
      const done = await browser.post(`/interaction/${uid}/${name}`);
      landed = await follow(browser, done.json<{ redirectTo: string }>().redirectTo);
    }
    return oidc.authorizationCodeGrant(app, landed, {
      pkceCodeVerifier: flow.codeVerifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce,
    });
  }

  beforeEach(async () => {
    started = await startEdge();
    started.store.addClient(refreshing);
    started.store.setResources(refreshing.client_id, [
      { identifier: ORDERS, scopes: ['orders:read'], accessTokenTtlSeconds: null },
    ]);
    browser = new FakeBrowser(started.base);
    app = await relyingParty(started.base, refreshing);
    setAccount(MEMBER);
  });

  it('advertises the two scopes', () => {
    const metadata = app.serverMetadata();
    expect(metadata.scopes_supported).toEqual(
      expect.arrayContaining(['permissions', 'custom_claims']),
    );
    expect(metadata.claims_supported).toEqual(
      expect.arrayContaining(['permissions', 'org_roles', 'org_permissions']),
    );
  });

  it('puts the permission claims in the ID token and userinfo for the permissions scope', async () => {
    const tokens = await userTokens({ scope: 'openid permissions' });

    expect(tokens.claims()).toMatchObject(PERMISSION_CLAIMS);
    expect(tokens.claims()).not.toHaveProperty('tier');
    const userinfo = await oidc.fetchUserInfo(app, tokens.access_token, USER);
    expect(userinfo).toMatchObject(PERMISSION_CLAIMS);
    expect(userinfo).not.toHaveProperty('tier');
  });

  it('puts the custom claims in the ID token and userinfo for the custom_claims scope', async () => {
    const tokens = await userTokens({ scope: 'openid custom_claims' });

    expect(tokens.claims()).toMatchObject(CUSTOM_CLAIMS);
    expect(tokens.claims()).not.toHaveProperty('permissions');
    expect(await oidc.fetchUserInfo(app, tokens.access_token, USER)).toMatchObject(CUSTOM_CLAIMS);
  });

  it('releases neither without its scope', async () => {
    const tokens = await userTokens({ scope: 'openid email' });

    for (const claim of ['roles', 'permissions', 'org_roles', 'tier', 'limits']) {
      expect(tokens.claims()).not.toHaveProperty(claim);
    }
  });

  it('carries both on an access token for a resource, beside its acr', async () => {
    const tokens = await userTokens({
      resource: ORDERS,
      scope: 'openid permissions custom_claims orders:read',
    });

    expect(payloadOf(tokens.access_token)).toMatchObject({
      aud: ORDERS,
      scope: 'orders:read',
      ...PERMISSION_CLAIMS,
      ...CUSTOM_CLAIMS,
    });
    expect(payloadOf(tokens.access_token)).toHaveProperty('acr');
  });

  it('carries none on an access token whose grant has neither scope', async () => {
    const tokens = await userTokens({ resource: ORDERS, scope: 'openid orders:read' });

    const claims = payloadOf(tokens.access_token);
    for (const claim of ['roles', 'permissions', 'org_id', 'tier']) {
      expect(claims).not.toHaveProperty(claim);
    }
  });

  it('reads them again on refresh', async () => {
    const first = await userTokens({
      resource: ORDERS,
      scope: 'openid offline_access permissions custom_claims orders:read',
      prompt: 'consent',
    });
    expect(payloadOf(first.access_token)).toMatchObject({ tier: 'gold' });

    setAccount({
      ...MEMBER,
      permissions: ['orders:read', 'orders:write'],
      customClaims: { tier: 'platinum' },
    });
    const refreshed = await oidc.refreshTokenGrant(app, first.refresh_token!);

    const claims = payloadOf(refreshed.access_token);
    expect(claims).toMatchObject({
      permissions: ['orders:read', 'orders:write'],
      tier: 'platinum',
    });
    expect(claims).not.toHaveProperty('limits');
  });

  it('releases the omission marker as the API set it', async () => {
    setAccount({
      sub: USER,
      roles: ['user'],
      org_id: 'org-1',
      permissions_omitted: true,
      customClaims: { tier: 'gold' },
    });

    const tokens = await userTokens({ scope: 'openid permissions custom_claims' });

    expect(tokens.claims()).toMatchObject({ permissions_omitted: true, tier: 'gold' });
    expect(tokens.claims()).not.toHaveProperty('permissions');
  });

  it('never lets a custom claim replace a reserved or protocol claim', async () => {
    setAccount({
      ...MEMBER,
      customClaims: { tier: 'gold', email: 'victim@example.com', act: { sub: 'x' }, nonce: 'n' },
    });

    const tokens = await userTokens({ scope: 'openid email custom_claims' });

    expect(tokens.claims()).toMatchObject({ email: 'ada@example.com', tier: 'gold' });
    expect(tokens.claims()).not.toHaveProperty('act');
  });

  it('keeps the permission claims whole when a claims request names only one', async () => {
    const tokens = await userTokens({
      scope: 'openid',
      claims: JSON.stringify({ id_token: { permissions: null } }),
    });

    for (const claim of ['permissions', 'org_roles', 'org_permissions']) {
      expect(tokens.claims()).not.toHaveProperty(claim);
    }
  });

  it('fails the token request when the API will not sign what the edge asked for', async () => {
    const flow = await startAuthorization(app, refreshing, { scope: 'openid permissions' });
    let landed = await follow(browser, flow.url.href);
    signIn(browser);
    for (let step = 0; step < 3 && landed.pathname.startsWith('/interaction/'); step += 1) {
      const uid = interactionUid(landed);
      const details = await browser.get(`/interaction/${uid}/details`);
      const name = details.json<{ prompt: { name: string } }>().prompt.name;
      const done = await browser.post(`/interaction/${uid}/${name}`);
      landed = await follow(browser, done.json<{ redirectTo: string }>().redirectTo);
    }
    // The account read at the token endpoint and the values the API signs disagree.
    started.api.on(({ path }) =>
      path === '/oidc/sign'
        ? new Response(JSON.stringify({ error: 'subject_mismatch' }), {
            status: 403,
            headers: { 'content-type': 'application/json' },
          })
        : undefined,
    );

    await expect(
      oidc.authorizationCodeGrant(app, landed, {
        pkceCodeVerifier: flow.codeVerifier,
        expectedState: flow.state,
        expectedNonce: flow.nonce,
      }),
    ).rejects.toThrow();
  });
});
