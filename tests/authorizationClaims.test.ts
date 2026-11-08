/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import type { OidcClientMetadata } from '@seamless-auth/types';
import * as oidc from 'openid-client';
import { beforeEach, describe, expect, it } from 'vitest';

import { FakeBrowser } from './browser.js';
import { json } from './fakeApi.js';
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

  async function authorized(extra: Record<string, string>) {
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
    return {
      redeem: () =>
        oidc.authorizationCodeGrant(app, landed, {
          pkceCodeVerifier: flow.codeVerifier,
          expectedState: flow.state,
          expectedNonce: flow.nonce,
        }),
    };
  }

  /** The account changes right after the edge reads it, before the API signs. */
  function changeAfterNextRead(changed: FakeAccount['claims']) {
    let armed = true;
    started.api.on((request) => {
      if (!armed || request.path !== `/oidc/accounts/${USER}`) {
        return undefined;
      }
      armed = false;
      const response = started.store.handle(request);
      setAccount(changed);
      return response;
    });
  }

  /** openid-client answers a 5xx with the raw response as the cause. */
  async function tokenError(pending: Promise<unknown>) {
    const error = await pending.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    const response = (error as { cause?: Response } | undefined)?.cause;
    if (!(response instanceof Response)) {
      throw new Error('expected the token request to fail with a response');
    }
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  function refusals() {
    return started.api.requests.filter((request) => request.path === '/oidc/sign').length;
  }

  function accountReads() {
    return started.api.requests.filter((request) => request.path === `/oidc/accounts/${USER}`)
      .length;
  }

  const PROMOTED: FakeAccount['claims'] = {
    ...MEMBER,
    org_roles: ['owner'],
    org_permissions: ['projects:read', 'projects:write'],
    customClaims: { tier: 'platinum' },
  };

  it('reads the account again and signs once more when a role changed since the read', async () => {
    const { redeem } = await authorized({ scope: 'openid permissions custom_claims' });
    changeAfterNextRead(PROMOTED);
    const readsBefore = accountReads();
    const signsBefore = refusals();

    const tokens = await redeem();

    expect(tokens.claims()).toMatchObject({
      org_roles: ['owner'],
      org_permissions: ['projects:read', 'projects:write'],
      tier: 'platinum',
    });
    expect(tokens.claims()).not.toHaveProperty('limits');
    // One read for the token request, one after the refusal; one refused sign, one signed.
    expect(accountReads() - readsBefore).toBe(2);
    expect(refusals() - signsBefore).toBe(2);
  });

  it('does the same for an access token for a resource', async () => {
    const { redeem } = await authorized({
      resource: ORDERS,
      scope: 'openid permissions custom_claims orders:read',
    });
    changeAfterNextRead(PROMOTED);

    const tokens = await redeem();

    expect(payloadOf(tokens.access_token)).toMatchObject({
      aud: ORDERS,
      org_roles: ['owner'],
      tier: 'platinum',
    });
    expect(payloadOf(tokens.access_token)).not.toHaveProperty('limits');
    expect(tokens.claims()).toMatchObject({ org_roles: ['owner'], tier: 'platinum' });
  });

  it('fails with server_error when the claims still do not match after one retry', async () => {
    const { redeem } = await authorized({ scope: 'openid permissions' });
    started.api.on(({ path }) =>
      path === '/oidc/sign' ? json(403, { error: 'claims_mismatch' }) : undefined,
    );
    const signsBefore = refusals();

    expect(await tokenError(redeem())).toEqual({
      status: 500,
      body: {
        error: 'server_error',
        error_description: 'the account changed while the token was being issued, try again',
      },
    });
    expect(refusals() - signsBefore).toBe(2);
  });

  it('fails with server_error when the API no longer describes the account', async () => {
    const { redeem } = await authorized({ scope: 'openid permissions' });
    let reads = 0;
    started.api.on((request) => {
      if (request.path === '/oidc/sign') {
        return json(403, { error: 'claims_mismatch' });
      }
      if (request.path === `/oidc/accounts/${USER}` && (reads += 1) > 1) {
        return json(404, { error: 'Not Found' });
      }
      return undefined;
    });

    expect(await tokenError(redeem())).toMatchObject({
      status: 500,
      body: {
        error: 'server_error',
        error_description: expect.stringContaining('account changed'),
      },
    });
  });

  it('retries no other refusal', async () => {
    const { redeem } = await authorized({ scope: 'openid permissions' });
    started.api.on(({ path }) =>
      path === '/oidc/sign' ? json(403, { error: 'subject_mismatch' }) : undefined,
    );
    const readsBefore = accountReads();
    const signsBefore = refusals();

    // The library's own answer for an unexpected failure, unchanged.
    expect(await tokenError(redeem())).toEqual({
      status: 500,
      body: { error: 'server_error', error_description: 'oops! something went wrong' },
    });
    expect(refusals() - signsBefore).toBe(1);
    expect(accountReads() - readsBefore).toBe(1);
  });
});
