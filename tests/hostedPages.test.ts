/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import type { AddressInfo } from 'node:net';

import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { OidcApiClient } from '../src/apiClient.js';
import { EdgeConfigCache } from '../src/configCache.js';
import { contentSecurityPolicy, createHostedPagesRouter, inlineJson } from '../src/hostedPages.js';
import { FakeBrowser, sendToEdge } from './browser.js';
import {
  API_URL,
  createFakeApi,
  EDGE_CONFIG,
  json,
  SERVICE_SECRET,
  UI_FIXTURE_DIR,
} from './fakeApi.js';
import { firstParty, relyingParty, startAuthorization, startEdge } from './harness.js';

const servers: { close: () => void }[] = [];

afterEach(() => {
  servers.splice(0).forEach((server) => server.close());
});

function nonceFrom(csp: string): string {
  const match = /'nonce-([^']+)'/.exec(csp);
  if (!match?.[1]) {
    throw new Error(`No nonce in ${csp}`);
  }
  return match[1];
}

describe('hosted pages', () => {
  it('serve the SPA with a strict CSP and a fresh nonce on every load', async () => {
    const { base } = await startEdge();
    const first = await sendToEdge(base, '/interaction/abc');
    const second = await sendToEdge(base, '/login');

    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toMatch(/text\/html/);
    const csp = String(first.headers['content-security-policy']);
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.headers['x-frame-options']).toBe('DENY');
    expect(first.headers['referrer-policy']).toBe('no-referrer');

    const nonce = nonceFrom(csp);
    expect(first.text).toContain(`<meta name="seamless-csp-nonce" content="${nonce}" />`);
    expect(nonceFrom(String(second.headers['content-security-policy']))).not.toBe(nonce);
    expect(first.text).toContain('<title>Sign in to Example</title>');
    expect(first.text).toContain('{"appName":"Example"}');
  });

  it('serve hashed assets as immutable, and nothing else under /assets', async () => {
    const { base } = await startEdge();
    const asset = await sendToEdge(base, '/assets/app.js');
    expect(asset.status).toBe(200);
    expect(asset.headers['cache-control']).toContain('immutable');
    expect(asset.headers['x-content-type-options']).toBe('nosniff');
    expect((await sendToEdge(base, '/assets/missing.js')).status).toBe(404);
  });

  it('take branding from config at serve time, so a config write changes them', async () => {
    const api = createFakeApi();
    let appName = 'Before';
    api.on(({ path }) =>
      path === '/oidc/config' ? json(200, { ...EDGE_CONFIG, appName }) : undefined,
    );
    const client = new OidcApiClient({
      apiUrl: API_URL,
      serviceSecret: SERVICE_SECRET,
      fetch: api.fetch,
    });
    const app = express();
    app.use(
      createHostedPagesRouter({
        uiDir: UI_FIXTURE_DIR,
        configCache: new EdgeConfigCache(client, { ...EDGE_CONFIG, appName }, { ttlMs: 0 }),
      }),
    );
    const server = app.listen(0);
    servers.push(server);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    expect((await sendToEdge(base, '/login')).text).toContain('Sign in to Before');
    appName = 'After </script><script>alert(1)</script>';
    const page = (await sendToEdge(base, '/login')).text;
    expect(page).toContain('Sign in to After &lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(page).not.toContain('<script>alert(1)');
    expect(page).toContain('\\u003c/script\\u003e');
  });

  it('refuse a template without the head placeholder', () => {
    const client = new OidcApiClient({ apiUrl: API_URL, serviceSecret: SERVICE_SECRET });
    expect(() =>
      createHostedPagesRouter({
        uiDir: new URL('./fixtures/', import.meta.url).pathname,
        configCache: new EdgeConfigCache(client, EDGE_CONFIG),
      }),
    ).toThrow();
  });
});

describe('inlineJson', () => {
  it('cannot close the script element it sits in', () => {
    expect(inlineJson({ a: '</script>&\u2028\u2029' })).toBe(
      '{"a":"\\u003c/script\\u003e\\u0026\\u2028\\u2029"}',
    );
  });
});

describe('contentSecurityPolicy', () => {
  it('only lets styles with the nonce run inline', () => {
    expect(contentSecurityPolicy('n0nce')).toContain("style-src 'self' 'nonce-n0nce'");
  });
});

describe('the adapter routes', () => {
  it('refuse a cross-site or sibling-subdomain state change', async () => {
    const { base } = await startEdge();
    const browser = new FakeBrowser(base);
    const blocked = await browser.post('/auth/logout', {
      origin: 'https://app.example.com',
      'sec-fetch-site': 'same-site',
    });
    expect(blocked.status).toBe(403);
    expect(blocked.json()).toEqual({ error: 'cross_origin_request_blocked' });

    const allowed = await browser.post('/auth/logout');
    expect(allowed.status).not.toBe(403);
  });
});

describe('the resume cookie', () => {
  it('is __Host- with Path=/, and only resumes the authorization it names', async () => {
    const { base } = await startEdge();
    const browser = new FakeBrowser(base);
    const config = await relyingParty(base, firstParty);

    const first = await startAuthorization(config, firstParty);
    const started = await browser.get(first.url.href);
    const setCookie = ([] as string[]).concat(started.headers['set-cookie'] ?? []);
    const resume = setCookie.filter((line) => line.startsWith('__Host-oidc_resume'));
    expect(resume).toHaveLength(2);
    for (const line of resume) {
      expect(line).toMatch(/; path=\/(;|$)/i);
      expect(line).toMatch(/; secure/i);
      expect(line).not.toMatch(/domain=/i);
    }
    const firstUid = new URL(String(started.headers.location), 'https://x').pathname.split('/')[2];

    const second = await startAuthorization(config, firstParty);
    await browser.get(second.url.href);

    const stale = await browser.get(`/authorize/${firstUid}`);
    expect(stale.status).toBe(400);
    expect(stale.text).toContain('authorization request has expired');
  });
});
