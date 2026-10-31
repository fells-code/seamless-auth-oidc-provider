/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import type { OidcAuthContext } from '@seamless-auth/types';
import * as oidc from 'openid-client';
import { beforeEach, describe, expect, it } from 'vitest';

import { authRequirements, stepUpMethods, unmetRequirements } from '../src/authRequirements.js';
import { FakeBrowser } from './browser.js';
import {
  firstParty,
  follow,
  interactionUid,
  REDIRECT,
  relyingParty,
  SESSION,
  signIn,
  startAuthorization,
  startEdge,
  USER,
} from './harness.js';

const now = () => Math.floor(Date.now() / 1000);

describe('step-up through the authorization endpoint', () => {
  let browser: FakeBrowser;
  let started: Awaited<ReturnType<typeof startEdge>>;
  let config: oidc.Configuration;

  function setContext(context: Partial<OidcAuthContext>) {
    started.store.addAccount({
      sessionId: SESSION,
      claims: { sub: USER, email: 'ada@example.com', roles: [], org_id: null },
      context,
    });
  }

  async function signInFirst() {
    const { url } = await startAuthorization(config, firstParty);
    const uid = interactionUid(await follow(browser, url.href));
    signIn(browser);
    const login = await browser.post(`/interaction/${uid}/login`);
    expect(login.status).toBe(200);
    await follow(browser, login.json<{ redirectTo: string }>().redirectTo);
  }

  function postLogin(uid: string, body?: unknown) {
    return browser.post(
      `/interaction/${uid}/login`,
      body === undefined ? {} : { 'content-type': 'application/json' },
      body === undefined ? undefined : JSON.stringify(body),
    );
  }

  async function redeem(
    callback: URL,
    flow: Awaited<ReturnType<typeof startAuthorization>>,
  ): Promise<Record<string, unknown>> {
    const tokens = await oidc.authorizationCodeGrant(config, callback, {
      pkceCodeVerifier: flow.codeVerifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce,
    });
    return tokens.claims() as Record<string, unknown>;
  }

  beforeEach(async () => {
    started = await startEdge();
    browser = new FakeBrowser(started.base);
    config = await relyingParty(started.base, firstParty);
  });

  it('rides the session when its acr already meets acr_values', async () => {
    await signInFirst();
    const flow = await startAuthorization(config, firstParty, { acr_values: 'phr' });
    const callback = await follow(browser, flow.url.href);
    expect(callback.origin + callback.pathname).toBe(REDIRECT);
    expect(await redeem(callback, flow)).toMatchObject({ acr: 'phrh' });
  });

  it('steps a phr session up to phrh and copies the new context', async () => {
    setContext({ acr: 'phr', amr: ['swk', 'user'], authTime: now() - 600 });
    await signInFirst();

    const flow = await startAuthorization(config, firstParty, { acr_values: 'phrh' });
    const uid = interactionUid(await follow(browser, flow.url.href));
    const needed = await postLogin(uid);
    expect(needed.status).toBe(409);
    expect(needed.json()).toEqual({ error: 'step_up_required', methods: ['passkey'] });

    const steppedAt = now();
    setContext({ acr: 'phrh', amr: ['hwk', 'user', 'mfa'], authTime: steppedAt });
    const login = await postLogin(uid, { afterStepUp: true });
    expect(login.status).toBe(200);
    const callback = await follow(browser, login.json<{ redirectTo: string }>().redirectTo);
    expect(await redeem(callback, flow)).toMatchObject({
      acr: 'phrh',
      amr: ['hwk', 'user', 'mfa'],
      auth_time: steppedAt,
    });
  });

  it('ends the request when the step-up still falls short', async () => {
    setContext({ acr: 'phr', amr: ['swk', 'user'] });
    await signInFirst();

    const flow = await startAuthorization(config, firstParty, { acr_values: 'phrh' });
    const uid = interactionUid(await follow(browser, flow.url.href));
    const login = await postLogin(uid, { afterStepUp: true });
    expect(login.status).toBe(200);
    const callback = await follow(browser, login.json<{ redirectTo: string }>().redirectTo);
    expect(callback.searchParams.get('error')).toBe('unmet_authentication_requirements');
    const grants = [...started.store.records.values()].filter(
      (r) => r.model === 'Grant' && r.payload.clientId === firstParty.client_id,
    );
    expect(grants.length).toBe(1);
  });

  it('asks for freshness on a stale session and offers TOTP when it has no acr', async () => {
    setContext({ acr: null, amr: ['otp'], authTime: now() - 3600 });
    await signInFirst();

    const flow = await startAuthorization(config, firstParty, { max_age: '300' });
    const uid = interactionUid(await follow(browser, flow.url.href));
    const needed = await postLogin(uid);
    expect(needed.json()).toEqual({ error: 'step_up_required', methods: ['passkey', 'totp'] });

    const steppedAt = now();
    setContext({ acr: null, amr: ['otp', 'mfa'], authTime: steppedAt });
    const login = await postLogin(uid, { afterStepUp: true });
    const callback = await follow(browser, login.json<{ redirectTo: string }>().redirectTo);
    const claims = await redeem(callback, flow);
    expect(claims).toMatchObject({ auth_time: steppedAt, amr: ['otp', 'mfa'] });
    expect(claims.acr).toBeUndefined();
  });

  it('carries a step-up made elsewhere into the next silent authorization', async () => {
    setContext({ acr: 'phr', amr: ['swk', 'user'], authTime: now() - 600 });
    await signInFirst();
    const steppedAt = now();
    setContext({ acr: 'phrh', amr: ['hwk', 'user', 'mfa'], authTime: steppedAt });

    const flow = await startAuthorization(config, firstParty);
    const callback = await follow(browser, flow.url.href);
    expect(await redeem(callback, flow)).toMatchObject({ acr: 'phrh', auth_time: steppedAt });
  });

  it('sends an ended session back to sign-in', async () => {
    await signInFirst();
    setContext({ active: false });
    const flow = await startAuthorization(config, firstParty);
    const next = await follow(browser, flow.url.href);
    expect(next.pathname.startsWith('/interaction/')).toBe(true);
  });
});

describe('authRequirements', () => {
  it('takes the weakest known acr from acr_values', () => {
    expect(authRequirements({ acr_values: 'phrh phr' })).toEqual({ acr: 'phr' });
    expect(authRequirements({ acr_values: 'urn:other phrh' })).toEqual({ acr: 'phrh' });
    expect(authRequirements({ acr_values: 'urn:other' })).toEqual({});
  });

  it('reads max_age and prompt=login', () => {
    expect(authRequirements({ max_age: '0', prompt: 'login consent' })).toEqual({
      maxAge: 0,
      reauthenticate: true,
    });
    expect(authRequirements({ max_age: 'soon' })).toEqual({});
  });
});

describe('unmetRequirements', () => {
  it('ranks phrh above phr', () => {
    expect(unmetRequirements({ acr: 'phr' }, { acr: 'phrh', authTime: 0 })).toBeUndefined();
    expect(unmetRequirements({ acr: 'phrh' }, { acr: 'phr', authTime: 0 })).toEqual({
      acr: true,
      freshness: false,
    });
    expect(unmetRequirements({ acr: 'phr' }, { acr: null, authTime: 0 })?.acr).toBe(true);
  });

  it('honours max_age, and counts an authentication during the interaction', () => {
    expect(
      unmetRequirements({ maxAge: 60 }, { acr: null, authTime: 1000 }, undefined, 1100),
    ).toEqual({ acr: false, freshness: true });
    expect(
      unmetRequirements({ maxAge: 200 }, { acr: null, authTime: 1000 }, undefined, 1100),
    ).toBeUndefined();
    expect(
      unmetRequirements({ maxAge: 0 }, { acr: null, authTime: 1000 }, 990, 1100),
    ).toBeUndefined();
  });

  it('needs an authentication since the interaction began for prompt=login', () => {
    const state = { acr: null, authTime: 999 };
    expect(unmetRequirements({ reauthenticate: true }, state, 1000)?.freshness).toBe(true);
    expect(unmetRequirements({ reauthenticate: true }, state, 999)).toBeUndefined();
    expect(unmetRequirements({ reauthenticate: true }, state)?.freshness).toBe(true);
  });
});

describe('stepUpMethods', () => {
  it('offers TOTP only for freshness on a session without an acr', () => {
    expect(stepUpMethods({ acr: false, freshness: true }, { acr: null, authTime: 0 })).toEqual([
      'passkey',
      'totp',
    ]);
    expect(stepUpMethods({ acr: false, freshness: true }, { acr: 'phr', authTime: 0 })).toEqual([
      'passkey',
    ]);
    expect(stepUpMethods({ acr: true, freshness: false }, { acr: null, authTime: 0 })).toEqual([
      'passkey',
    ]);
  });
});
