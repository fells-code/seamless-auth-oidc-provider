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
