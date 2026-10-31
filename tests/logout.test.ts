/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import type { OidcClientMetadata } from '@seamless-auth/types';
import * as oidc from 'openid-client';
import { beforeEach, describe, expect, it } from 'vitest';

import { FakeBrowser } from './browser.js';
import { ISSUER } from './fakeApi.js';
import {
  ACCESS_COOKIE,
  firstParty,
  follow,
  interactionUid,
  relyingParty,
  SESSION,
  signIn,
  startAuthorization,
  startEdge,
} from './harness.js';

const POST_LOGOUT = 'https://app.example.com/signed-out';
const BACKCHANNEL = 'https://app.example.com/backchannel';

const loggingOut: OidcClientMetadata = {
  ...firstParty,
  client_id: 'first-party-logout',
  post_logout_redirect_uris: [POST_LOGOUT],
  backchannel_logout_uri: BACKCHANNEL,
  backchannel_logout_session_required: true,
};

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

function pageData(html: string) {
  const match = /<script type="application\/json" id="seamless-page">(.*?)<\/script>/.exec(html);
  return match ? (JSON.parse(match[1]!) as Record<string, unknown>) : undefined;
}

function payloadOf(token: string) {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as Record<
    string,
    unknown
  >;
}

describe('RP-initiated logout', () => {
  let browser: FakeBrowser;
  let started: Awaited<ReturnType<typeof startEdge>>;
  let config: oidc.Configuration;
  let idToken: string;

  beforeEach(async () => {
    started = await startEdge();
    started.store.addClient(loggingOut);
    browser = new FakeBrowser(started.base);
    config = await relyingParty(started.base, loggingOut);

    const flow = await startAuthorization(config, loggingOut);
    let landed = await follow(browser, flow.url.href);
    signIn(browser);
    const login = await browser.post(`/interaction/${interactionUid(landed)}/login`);
    landed = await follow(browser, login.json<{ redirectTo: string }>().redirectTo);
    const tokens = await oidc.authorizationCodeGrant(config, landed, {
      pkceCodeVerifier: flow.codeVerifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce,
    });
    idToken = tokens.id_token!;
  });

  async function confirmPage(params: Record<string, string>) {
    const response = await browser.get(`/session/end?${new URLSearchParams(params)}`);
    expect(response.status).toBe(200);
    return { response, page: pageData(response.text)! };
  }

  it('advertises logout in discovery and puts sid in the ID token', () => {
    const metadata = config.serverMetadata();
    expect(metadata.end_session_endpoint).toBe(`${ISSUER}/session/end`);
    expect(metadata.backchannel_logout_supported).toBe(true);
    expect(metadata.backchannel_logout_session_supported).toBe(true);
    expect(typeof payloadOf(idToken).sid).toBe('string');
  });

  it('asks before signing out, on the hosted page', async () => {
    const { response, page } = await confirmPage({
      id_token_hint: idToken,
      post_logout_redirect_uri: POST_LOGOUT,
    });

    expect(page).toEqual({
      view: 'logout',
      action: `${ISSUER}/session/end/confirm`,
      xsrf: expect.any(String),
      clientName: 'Example App',
    });
    expect(response.headers['content-security-policy']).toContain(
      "form-action 'self' https://app.example.com",
    );
    expect(started.store.revokedSessions).toEqual([]);
  });

  it('ends the first-party session and returns to the app', async () => {
    const { page } = await confirmPage({
      id_token_hint: idToken,
      post_logout_redirect_uri: POST_LOGOUT,
      state: 'bye',
    });
    const before = started.api.requests.length;

    const done = await browser.post(
      '/session/end/confirm',
      FORM,
      new URLSearchParams({ xsrf: String(page.xsrf), logout: 'yes' }).toString(),
    );

    expect(done.status).toBe(303);
    expect(done.headers.location).toBe(`${POST_LOGOUT}?state=bye`);
    expect(started.store.revokedSessions).toEqual([
      { sessionId: SESSION, reason: 'provider_logout' },
    ]);
    expect(started.store.events).toContainEqual(
      expect.objectContaining({
        type: 'end_session',
        sessionId: SESSION,
        clientId: loggingOut.client_id,
        metadata: { scope: 'session' },
      }),
    );
    expect(browser.cookies.has(ACCESS_COOKIE)).toBe(false);
    // The API tells the apps. Nothing here posts a logout token or asks for one signed.
    const after = started.api.requests.slice(before);
    expect(after.some((request) => request.path === '/oidc/sign')).toBe(false);

    const again = await follow(browser, (await startAuthorization(config, loggingOut)).url.href);
    expect(again.pathname).toMatch(/^\/interaction\//);
  });

  it('can sign out of the asking app only, keeping the session', async () => {
    const { page } = await confirmPage({ id_token_hint: idToken });

    const done = await browser.post(
      '/session/end/confirm',
      FORM,
      new URLSearchParams({ xsrf: String(page.xsrf) }).toString(),
    );

    expect(done.status).toBe(303);
    expect(started.store.revokedSessions).toEqual([]);
    expect(started.store.events).toContainEqual(
      expect.objectContaining({ type: 'end_session', metadata: { scope: 'client' } }),
    );
    expect(browser.cookies.has(ACCESS_COOKIE)).toBe(true);
  });

  it('refuses a confirmation without the page xsrf value', async () => {
    await confirmPage({ id_token_hint: idToken });

    const done = await browser.post(
      '/session/end/confirm',
      FORM,
      new URLSearchParams({ xsrf: 'guess', logout: 'yes' }).toString(),
    );

    expect(done.status).toBe(400);
    expect(started.store.revokedSessions).toEqual([]);
  });

  it('shows the signed-out page when the app gives no return address', async () => {
    const { page } = await confirmPage({ client_id: loggingOut.client_id });
    const done = await browser.post(
      '/session/end/confirm',
      FORM,
      new URLSearchParams({ xsrf: String(page.xsrf), logout: 'yes' }).toString(),
    );
    const location = new URL(String(done.headers.location));
    expect(location.pathname).toBe('/session/end/success');

    const success = await browser.get(location.href);
    expect(pageData(success.text)).toEqual({ view: 'signed_out', clientName: null });
  });
});
