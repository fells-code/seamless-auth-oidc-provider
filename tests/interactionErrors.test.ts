/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { FakeBrowser } from './browser.js';
import { json } from './fakeApi.js';
import {
  firstParty,
  follow,
  interactionUid,
  relyingParty,
  SESSION,
  signIn,
  startAuthorization,
  startEdge,
} from './harness.js';

describe('an API failure while finishing login', () => {
  let started: Awaited<ReturnType<typeof startEdge>>;
  let browser: FakeBrowser;

  beforeEach(async () => {
    started = await startEdge();
    browser = new FakeBrowser(started.base);
    started.api.on(({ path }) =>
      /^\/oidc\/sessions\/[^/]+\/auth-context$/.test(path) ? json(500) : undefined,
    );
  });

  async function login() {
    const config = await relyingParty(started.base, firstParty);
    const flow = await startAuthorization(config, firstParty);
    const uid = interactionUid(await follow(browser, flow.url.href));
    signIn(browser);
    return browser.post(`/interaction/${uid}/login`);
  }

  it('removes the grant it saved before reading the auth context', async () => {
    await login();
    const grants = [...started.store.records.values()].filter(
      (record) => record.model === 'Grant' && record.sessionId === SESSION,
    );
    expect(grants).toEqual([]);
  });

  it('answers JSON with no stack trace', async () => {
    const response = await login();
    expect(response.status).toBe(500);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.json()).toEqual({ error: 'server_error' });
    expect(response.text).not.toMatch(/at .*\.(ts|js):\d+/);
  });
});

describe('the edge error handler', () => {
  it('keeps a client error from a body parser as JSON', async () => {
    const started = await startEdge();
    const browser = new FakeBrowser(started.base);
    const config = await relyingParty(started.base, firstParty);
    const flow = await startAuthorization(config, firstParty);
    const uid = interactionUid(await follow(browser, flow.url.href));
    const response = await browser.post(
      `/interaction/${uid}/login`,
      { 'content-type': 'application/json' },
      '{not json',
    );
    expect(response.status).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_request' });
  });
});
