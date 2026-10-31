/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import type { OidcClientMetadata } from '@seamless-auth/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEVICE_CODE_GRANT, DevicePollThrottle } from '../src/deviceFlow.js';
import { FakeBrowser, sendToEdge } from './browser.js';
import { EDGE_CONFIG, ISSUER } from './fakeApi.js';
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

const tv: OidcClientMetadata = {
  ...firstParty,
  client_id: 'first-party-tv',
  client_name: 'Living Room TV',
  application_type: 'native',
  grant_types: [DEVICE_CODE_GRANT, 'refresh_token'],
  response_types: [],
  redirect_uris: [],
};

const partnerTv: OidcClientMetadata = {
  ...firstParty,
  client_id: 'third-party-tv',
  grant_types: [DEVICE_CODE_GRANT, 'authorization_code'],
  'urn:seamless:first_party': false,
};

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

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

describe('device authorization grant', () => {
  let started: Awaited<ReturnType<typeof startEdge>>;
  let browser: FakeBrowser;
  let now: number;

  function post(path: string, form: Record<string, string>, ip?: string) {
    return sendToEdge(started.base, path, {
      method: 'POST',
      headers: { ...FORM, ...(ip ? { 'x-forwarded-for': ip } : {}) },
      body: new URLSearchParams(form).toString(),
    });
  }

  async function authorize(form: Record<string, string> = {}) {
    const response = await post('/device/auth', {
      client_id: tv.client_id,
      scope: 'openid email offline_access',
      ...form,
    });
    return { response, body: response.json<DeviceAuthorization>() };
  }

  function poll(deviceCode: string) {
    now += 6000;
    return post('/token', {
      client_id: tv.client_id,
      grant_type: DEVICE_CODE_GRANT,
      device_code: deviceCode,
    });
  }

  async function enterCode(userCode: string) {
    const input = await browser.get('/device');
    const { xsrf } = pageData(input.text)!;
    const confirm = await browser.post(
      '/device',
      FORM,
      new URLSearchParams({ xsrf: String(xsrf), user_code: userCode }).toString(),
    );
    return { confirm, page: pageData(confirm.text)! };
  }

  async function approve(userCode: string) {
    const { page } = await enterCode(userCode);
    const confirmed = await browser.post(
      '/device',
      FORM,
      new URLSearchParams({
        xsrf: String(page.xsrf),
        user_code: String(page.userCode),
        confirm: 'yes',
      }).toString(),
    );
    const landed = await follow(browser, String(confirmed.headers.location));
    signIn(browser);
    const uid = interactionUid(landed);
    let login = await browser.post(`/interaction/${uid}/login`);
    if (login.status === 409) {
      // An earlier sign-in in this browser: approving takes a fresh one (prompt=login).
      expect(login.json()).toMatchObject({ error: 'step_up_required' });
      started.store.addAccount({
        sessionId: SESSION,
        claims: { sub: USER, email: 'ada@example.com', roles: [], org_id: null },
        context: { authTime: Math.ceil(now / 1000) + 1 },
      });
      login = await browser.post(
        `/interaction/${uid}/login`,
        { 'content-type': 'application/json' },
        JSON.stringify({ afterStepUp: true }),
      );
    }
    let next = new URL(login.json<{ redirectTo: string }>().redirectTo);
    for (let hops = 0; hops < 5; hops += 1) {
      const response = await browser.get(next.href);
      if (typeof response.headers.location !== 'string') {
        return response;
      }
      next = new URL(response.headers.location, next);
    }
    throw new Error('the device approval did not finish');
  }

  beforeEach(async () => {
    started = await startEdge();
    started.store.addClient(tv);
    started.store.addClient(partnerTv);
    browser = new FakeBrowser(started.base);
    const real = Date.now();
    now = real;
    vi.spyOn(Date, 'now').mockImplementation(() => now + (performance.now() % 1));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers a device authorization with a short code and a polling interval', async () => {
    const { response, body } = await authorize();

    expect(response.status).toBe(200);
    expect(body.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(body).toMatchObject({
      verification_uri: `${ISSUER}/device`,
      verification_uri_complete: `${ISSUER}/device?user_code=${body.user_code}`,
      expires_in: 600,
      interval: 5,
    });
  });

  it('signs the device in after approval elsewhere, with no acr in any token', async () => {
    const { body } = await authorize();

    const pending = await poll(body.device_code);
    expect(pending.json()).toMatchObject({ error: 'authorization_pending' });

    // Typed the way a person would: lower case, no dash.
    const { page } = await enterCode(body.user_code.replace('-', '').toLowerCase());
    expect(page).toMatchObject({
      view: 'device_confirm',
      userCode: body.user_code,
      clientName: 'Living Room TV',
      scopes: ['openid', 'email', 'offline_access'],
    });

    const done = await approve(body.user_code);
    expect(pageData(done.text)).toEqual({ view: 'device_done', clientName: 'Living Room TV' });
    expect(started.store.events).toContainEqual(
      expect.objectContaining({ type: 'device_code_approved', clientId: tv.client_id }),
    );

    const tokens = await poll(body.device_code);
    expect(tokens.status).toBe(200);
    const issued = tokens.json<{ id_token: string; refresh_token: string }>();
    const idToken = payloadOf(issued.id_token);
    expect(idToken).toMatchObject({ sub: expect.any(String), aud: tv.client_id });
    expect(idToken).not.toHaveProperty('acr');
    expect(started.store.signed.at(-1)).toEqual({
      kind: 'id_token',
      clientId: tv.client_id,
      sessionId: SESSION,
      grantType: DEVICE_CODE_GRANT,
    });

    const refreshed = await post('/token', {
      client_id: tv.client_id,
      grant_type: 'refresh_token',
      refresh_token: issued.refresh_token,
    });
    expect(refreshed.status).toBe(200);
    expect(payloadOf(refreshed.json<{ id_token: string }>().id_token)).not.toHaveProperty('acr');
    expect(started.store.signed.at(-1)?.grantType).toBe(DEVICE_CODE_GRANT);

    // The device code works once.
    expect((await poll(body.device_code)).json()).toMatchObject({ error: 'invalid_grant' });
    const { page: again } = await enterCode(body.user_code);
    expect(again).toMatchObject({ view: 'device_input' });
    expect(['already_used', 'not_found']).toContain(again.error);
  });

  it('approves from a browser already signed in to another app', async () => {
    const config = await relyingParty(started.base, firstParty);
    const flow = await startAuthorization(config, firstParty);
    const landed = await follow(browser, flow.url.href);
    signIn(browser);
    const login = await browser.post(`/interaction/${interactionUid(landed)}/login`);
    await follow(browser, login.json<{ redirectTo: string }>().redirectTo);

    const { body } = await authorize();
    const done = await approve(body.user_code);

    expect(pageData(done.text)).toEqual({ view: 'device_done', clientName: 'Living Room TV' });
    expect((await poll(body.device_code)).status).toBe(200);
  });

  it('tells a client polling sooner than the interval to slow down, and grows it', async () => {
    const { body } = await authorize();
    const form = { client_id: tv.client_id, grant_type: DEVICE_CODE_GRANT };

    expect((await post('/token', { ...form, device_code: body.device_code })).json()).toMatchObject(
      { error: 'authorization_pending' },
    );
    now += 1000;
    expect((await post('/token', { ...form, device_code: body.device_code })).json()).toMatchObject(
      { error: 'slow_down' },
    );
    now += 6000;
    expect((await post('/token', { ...form, device_code: body.device_code })).json()).toMatchObject(
      { error: 'slow_down' },
    );
    now += 16_000;
    expect((await post('/token', { ...form, device_code: body.device_code })).json()).toMatchObject(
      { error: 'authorization_pending' },
    );
  });

  it('refuses the device when the user cancels', async () => {
    const { body } = await authorize();
    const { page } = await enterCode(body.user_code);

    const cancelled = await browser.post(
      '/device',
      FORM,
      new URLSearchParams({
        xsrf: String(page.xsrf),
        user_code: body.user_code,
        abort: 'yes',
      }).toString(),
    );

    expect(pageData(cancelled.text)).toMatchObject({ view: 'device_input', error: 'aborted' });
    expect((await poll(body.device_code)).json()).toMatchObject({ error: 'access_denied' });
    expect(started.store.events).toContainEqual(
      expect.objectContaining({ type: 'device_code_denied', clientId: tv.client_id }),
    );
  });

  it('refuses an expired code', async () => {
    const { body } = await authorize();
    now += 601_000;

    const { page } = await enterCode(body.user_code);
    expect(page).toMatchObject({ view: 'device_input' });
    expect(page.error === 'expired' || page.error === 'not_found').toBe(true);
    // The API answers nothing for an expired record, so the library cannot tell it apart.
    expect((await poll(body.device_code)).json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('shows an unknown code as not found', async () => {
    const { page } = await enterCode('BCDF-GHJK');
    expect(page).toMatchObject({ view: 'device_input', error: 'not_found', userCode: 'BCDF-GHJK' });
  });

  it('takes no acr_values or max_age, which an approval elsewhere would satisfy', async () => {
    for (const extra of [{ acr_values: 'phr' }, { max_age: '300' }] as Record<string, string>[]) {
      const { response, body } = await authorize(extra);
      expect(response.status).toBe(400);
      expect(body).toMatchObject({ error: 'invalid_request' });
    }
  });

  it('is first-party only, whatever the client metadata lists', async () => {
    started = await startEdge({ ...EDGE_CONFIG, thirdPartyClientsEnabled: true });
    started.store.addClient(partnerTv);
    const response = await post('/device/auth', {
      client_id: partnerTv.client_id,
      scope: 'openid',
    });
    expect(response.status).toBe(400);
    expect(response.json()).toEqual({
      error: 'invalid_request',
      error_description: `${DEVICE_CODE_GRANT} is not allowed for this client`,
    });
  });

  it('limits code entry per address', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      statuses.push(
        (await post('/device', { xsrf: 'x', user_code: 'BCDF-GHJK' }, '203.0.113.9')).status,
      );
    }
    expect(statuses.slice(0, 10)).not.toContain(429);
    expect(statuses[10]).toBe(429);
  });
});

describe('DevicePollThrottle', () => {
  it('holds at most ten thousand codes, dropping the oldest', () => {
    let clock = 0;
    const throttle = new DevicePollThrottle(() => clock);
    for (let i = 0; i < 10_001; i += 1) throttle.check(`code-${i}`);
    clock = 1000;
    // The oldest was dropped, so it starts again rather than being told to slow down.
    expect(() => throttle.check('code-0')).not.toThrow();
    expect(() => throttle.check('code-10000')).toThrow(/slow_down/);
  });

  it('does not track a device code that does not exist', async () => {
    const started = await startEdge();
    started.store.addClient(tv);
    const form = { client_id: tv.client_id, grant_type: DEVICE_CODE_GRANT, device_code: 'nope' };
    for (let i = 0; i < 2; i += 1) {
      const response = await sendToEdge(started.base, '/token', {
        method: 'POST',
        headers: FORM,
        body: new URLSearchParams(form).toString(),
      });
      expect(response.json()).toMatchObject({ error: 'invalid_grant' });
    }
  });

  it('keeps each device code to its own interval', () => {
    let clock = 0;
    const throttle = new DevicePollThrottle(() => clock);
    throttle.check('a');
    throttle.check('b');
    clock = 4000;
    expect(() => throttle.check('a')).toThrow(/slow_down/);
    clock = 14_000;
    expect(() => throttle.check('a')).not.toThrow();
  });
});
