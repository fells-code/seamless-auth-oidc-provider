/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import type { OidcAuthContext, OidcClientMetadata } from '@seamless-auth/types';
import * as oidc from 'openid-client';
import { beforeEach, describe, expect, it } from 'vitest';

import { FakeBrowser, firstPartyCookie } from './browser.js';
import { json } from './fakeApi.js';
import {
  ACCESS_COOKIE,
  ADAPTER_SECRET,
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

const desktop: OidcClientMetadata = {
  ...firstParty,
  client_id: 'desktop-app',
  client_name: 'Desktop App',
  application_type: 'native',
  redirect_uris: ['http://127.0.0.1/callback', 'com.example.app:/oauth'],
};

const LOOPBACK = 'http://127.0.0.1:53124/callback';

/**
 * RFC 8252 section 8.6: anything on the device can listen on a loopback port or claim a
 * private-use scheme, so a native client's request is confirmed by the user, first-party or
 * not. Each test plays the hosted page's automatic posts, which a person never clicked.
 */
describe('first-party native clients (RFC 8252 section 8.6)', () => {
  let started: Awaited<ReturnType<typeof startEdge>>;
  let browser: FakeBrowser;
  let config: oidc.Configuration;

  beforeEach(async () => {
    started = await startEdge();
    started.store.addClient(desktop);
    browser = new FakeBrowser(started.base);
    config = await relyingParty(started.base, desktop);
  });

  it('asks a signed-in user to confirm before a code goes to the app', async () => {
    signIn(browser);
    const flow = await startAuthorization(config, desktop, { redirect_uri: LOOPBACK });
    const uid = interactionUid(await follow(browser, flow.url.href));

    const login = await browser.post(`/interaction/${uid}/login`);
    expect(login.status).toBe(200);
    const next = await follow(browser, login.json<{ redirectTo: string }>().redirectTo);
    expect(next.pathname).toMatch(/^\/interaction\//);

    const confirmUid = interactionUid(next);
    const details = await browser.get(`/interaction/${confirmUid}/details`);
    expect(details.json()).toMatchObject({
      prompt: { name: 'consent', reasons: expect.arrayContaining(['native_client_prompt']) },
      client: { id: desktop.client_id, firstParty: true },
    });

    const automatic = await browser.post(`/interaction/${confirmUid}/consent`);
    expect(automatic.status).toBe(403);
    expect(automatic.json()).toEqual({ error: 'confirmation_required' });

    const confirmed = await browser.post(
      `/interaction/${confirmUid}/consent`,
      { 'content-type': 'application/json' },
      JSON.stringify({ confirmed: true }),
    );
    expect(confirmed.status).toBe(200);
    const callback = await follow(browser, confirmed.json<{ redirectTo: string }>().redirectTo);
    expect(`${callback.origin}${callback.pathname}`).toBe(LOOPBACK);
    const tokens = await oidc.authorizationCodeGrant(config, callback, {
      pkceCodeVerifier: flow.codeVerifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce,
    });
    expect(tokens.claims()).toMatchObject({ aud: desktop.client_id });
  });

  it('refuses an automatic consent for a request that rides the provider session', async () => {
    signIn(browser);
    const web = await relyingParty(started.base, firstParty);
    const first = await startAuthorization(web, firstParty);
    const uid = interactionUid(await follow(browser, first.url.href));
    const login = await browser.post(`/interaction/${uid}/login`);
    await follow(browser, login.json<{ redirectTo: string }>().redirectTo);

    const flow = await startAuthorization(config, desktop, { redirect_uri: LOOPBACK });
    const confirmUid = interactionUid(await follow(browser, flow.url.href));
    const details = await browser.get(`/interaction/${confirmUid}/details`);
    expect(details.json()).toMatchObject({
      prompt: { name: 'consent', reasons: expect.arrayContaining(['native_client_prompt']) },
      client: { firstParty: true },
    });

    const automatic = await browser.post(`/interaction/${confirmUid}/consent`);
    expect(automatic.json()).toEqual({ error: 'confirmation_required' });
    expect(automatic.status).toBe(403);
  });

  it('does not ask for a first-party web client', async () => {
    signIn(browser);
    const web = await relyingParty(started.base, firstParty);
    const flow = await startAuthorization(web, firstParty);
    const uid = interactionUid(await follow(browser, flow.url.href));
    const login = await browser.post(`/interaction/${uid}/login`);
    const callback = await follow(browser, login.json<{ redirectTo: string }>().redirectTo);
    expect(callback.origin).toBe('https://app.example.com');
  });
});

/**
 * ADR 0003 X8: the confirmation names the client and the account. Someone approving a sign-in
 * started by a program on their machine has to see which account it would use.
 */
describe('the account on a native client confirmation', () => {
  const ACCOUNT_LOOKUP = `/oidc/accounts/${USER}`;
  let started: Awaited<ReturnType<typeof startEdge>>;
  let browser: FakeBrowser;
  let config: oidc.Configuration;

  beforeEach(async () => {
    started = await startEdge();
    started.store.addClient(desktop);
    browser = new FakeBrowser(started.base);
    config = await relyingParty(started.base, desktop);
  });

  async function signedInConfirmation() {
    signIn(browser);
    const flow = await startAuthorization(config, desktop, { redirect_uri: LOOPBACK });
    const uid = interactionUid(await follow(browser, flow.url.href));
    const login = await browser.post(`/interaction/${uid}/login`);
    return interactionUid(await follow(browser, login.json<{ redirectTo: string }>().redirectTo));
  }

  async function accountOn(uid: string, from = browser) {
    const details = await from.get(`/interaction/${uid}/details`);
    expect(details.status).toBe(200);
    return details.json<{ account?: unknown }>().account;
  }

  it('names the account after a sign-in, uncached', async () => {
    const uid = await signedInConfirmation();
    const details = await browser.get(`/interaction/${uid}/details`);
    expect(details.json()).toMatchObject({
      prompt: { reasons: expect.arrayContaining(['native_client_prompt']) },
      account: { identifier: 'ada@example.com' },
    });
    expect(details.headers['cache-control']).toBe('no-store');
  });

  it('names the account on a request that rides the provider session', async () => {
    signIn(browser);
    const web = await relyingParty(started.base, firstParty);
    const first = await startAuthorization(web, firstParty);
    const firstUid = interactionUid(await follow(browser, first.url.href));
    const login = await browser.post(`/interaction/${firstUid}/login`);
    await follow(browser, login.json<{ redirectTo: string }>().redirectTo);

    const flow = await startAuthorization(config, desktop, { redirect_uri: LOOPBACK });
    const uid = interactionUid(await follow(browser, flow.url.href));
    expect(await accountOn(uid)).toEqual({ identifier: 'ada@example.com' });
  });

  it('asks about the session the interaction belongs to, not a newer one in the cookie', async () => {
    const uid = await signedInConfirmation();
    browser.cookies.set(
      ACCESS_COOKIE,
      firstPartyCookie(ADAPTER_SECRET, {
        sub: USER,
        sessionId: '1c7b4d3e-2f50-4b6c-9d8e-0f1a2b3c4d5e',
      }),
    );
    expect(await accountOn(uid)).toEqual({ identifier: 'ada@example.com' });
    const lookup = started.api.requests.findLast(({ path }) => path === ACCOUNT_LOOKUP);
    expect(new URLSearchParams(lookup?.search).get('sessionId')).toBe(SESSION);
  });

  it('falls back to the phone number for an account with no email', async () => {
    started.store.addAccount({
      sessionId: SESSION,
      claims: { sub: USER, phone_number: '+15550100', roles: ['user'], org_id: null },
    });
    const uid = await signedInConfirmation();
    expect(await accountOn(uid)).toEqual({ identifier: '+15550100' });
  });

  it('tells a browser without the interaction nothing', async () => {
    const uid = await signedInConfirmation();
    const other = new FakeBrowser(started.base);
    signIn(other);
    const details = await other.get(`/interaction/${uid}/details`);
    expect(details.status).toBe(404);
    expect(details.text).not.toContain('ada@example.com');
  });

  it('does not name an account to a browser without its first-party session', async () => {
    const uid = await signedInConfirmation();
    browser.cookies.delete(ACCESS_COOKIE);
    expect(await accountOn(uid)).toBeNull();
  });

  it('does not name an account to a browser signed in as someone else', async () => {
    const uid = await signedInConfirmation();
    browser.cookies.set(
      ACCESS_COOKIE,
      firstPartyCookie(ADAPTER_SECRET, {
        sub: '2d8c5e4f-3a61-4c7d-8e9f-1a2b3c4d5e6f',
        sessionId: SESSION,
      }),
    );
    expect(await accountOn(uid)).toBeNull();
  });

  it('does not name an account to a recovery session', async () => {
    const uid = await signedInConfirmation();
    signIn(browser, SESSION, true);
    expect(await accountOn(uid)).toBeNull();
  });

  it('answers without an account when the API has none to give', async () => {
    const uid = await signedInConfirmation();
    started.api.on(({ path }) => (path === ACCOUNT_LOOKUP ? json(404) : undefined));
    expect(await accountOn(uid)).toBeNull();
  });

  it('answers without an account when the API fails', async () => {
    const uid = await signedInConfirmation();
    started.api.on(({ path }) => (path === ACCOUNT_LOOKUP ? json(500) : undefined));
    expect(await accountOn(uid)).toBeNull();
  });

  it('answers without an account when the API describes someone else', async () => {
    const uid = await signedInConfirmation();
    started.api.on(({ path }) =>
      path === ACCOUNT_LOOKUP
        ? json(200, { sub: 'someone-else', email: 'eve@example.com', roles: [], org_id: null })
        : undefined,
    );
    expect(await accountOn(uid)).toBeNull();
  });

  it('answers without an account when the API knows no identifier for it', async () => {
    const uid = await signedInConfirmation();
    started.api.on(({ path }) =>
      path === ACCOUNT_LOOKUP ? json(200, { sub: USER, roles: [], org_id: null }) : undefined,
    );
    expect(await accountOn(uid)).toBeNull();
  });

  it('has no account to name before a sign-in', async () => {
    signIn(browser);
    const flow = await startAuthorization(config, desktop, { redirect_uri: LOOPBACK });
    const uid = interactionUid(await follow(browser, flow.url.href));
    expect(await accountOn(uid)).toBeNull();
    expect(started.api.requests.some(({ path }) => path === ACCOUNT_LOOKUP)).toBe(false);
  });
});

/**
 * Each authorization a native client finishes gets its own grant. Revoking a refresh token ends
 * its whole grant (RFC 7009 section 2.1), so an app that revokes the token a new sign-in replaced
 * must not end the new one, and a grant a sign-out ended must not stop the next sign-in.
 */
describe('grants for a first-party native client', () => {
  const nativeApp: OidcClientMetadata = {
    ...desktop,
    grant_types: ['authorization_code', 'refresh_token'],
  };
  let started: Awaited<ReturnType<typeof startEdge>>;
  let browser: FakeBrowser;
  let config: oidc.Configuration;

  beforeEach(async () => {
    started = await startEdge();
    started.store.addClient(nativeApp);
    browser = new FakeBrowser(started.base);
    config = await relyingParty(started.base, nativeApp);
    signIn(browser);
  });

  function account(context: Partial<OidcAuthContext>) {
    started.store.addAccount({
      sessionId: SESSION,
      claims: { sub: USER, email: 'ada@example.com', roles: [], org_id: null },
      context,
    });
  }

  async function confirmation(extra: Record<string, string> = {}) {
    const flow = await startAuthorization(config, nativeApp, {
      redirect_uri: LOOPBACK,
      scope: 'openid email offline_access',
      prompt: 'consent',
      ...extra,
    });
    let at = await follow(browser, flow.url.href);
    const asked = await browser.get(`/interaction/${interactionUid(at)}/details`);
    if (asked.json<{ prompt: { name: string } }>().prompt.name === 'login') {
      const uid = interactionUid(at);
      let login = await browser.post(`/interaction/${uid}/login`);
      if (login.status === 409) {
        expect(login.json()).toMatchObject({ error: 'step_up_required' });
        account({ acr: 'phr', amr: ['swk', 'user'], authTime: Math.floor(Date.now() / 1000) });
        login = await browser.post(
          `/interaction/${uid}/login`,
          { 'content-type': 'application/json' },
          JSON.stringify({ afterStepUp: true }),
        );
      }
      expect(login.status).toBe(200);
      at = await follow(browser, login.json<{ redirectTo: string }>().redirectTo);
    }
    return { flow, uid: interactionUid(at) };
  }

  async function signInToApp(extra: Record<string, string> = {}) {
    const { flow, uid } = await confirmation(extra);
    const confirmed = await browser.post(
      `/interaction/${uid}/consent`,
      { 'content-type': 'application/json' },
      JSON.stringify({ confirmed: true }),
    );
    expect(confirmed.status).toBe(200);
    const callback = await follow(browser, confirmed.json<{ redirectTo: string }>().redirectTo);
    return oidc.authorizationCodeGrant(config, callback, {
      pkceCodeVerifier: flow.codeVerifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce,
    });
  }

  it('keeps a new sign-in when the app revokes the refresh token it replaced', async () => {
    account({ acr: 'phr', amr: ['swk', 'user'], authTime: Math.floor(Date.now() / 1000) - 600 });
    const first = await signInToApp();
    // A step-up, as a desktop app asks for one before a sensitive route.
    const second = await signInToApp({ acr_values: 'phr', max_age: '30' });
    expect(second.refresh_token).toBeDefined();

    await oidc.tokenRevocation(config, first.refresh_token!, {
      token_type_hint: 'refresh_token',
    });

    const refreshed = await oidc.refreshTokenGrant(config, second.refresh_token!);
    expect(refreshed.access_token).toBeDefined();
  });

  it('names the account on the next sign-in after a sign-out ended the grant', async () => {
    const first = await signInToApp();
    await oidc.tokenRevocation(config, first.refresh_token!, {
      token_type_hint: 'refresh_token',
    });

    const { uid } = await confirmation();
    const details = await browser.get(`/interaction/${uid}/details`);
    expect(details.json()).toMatchObject({ account: { identifier: 'ada@example.com' } });
  });
});
