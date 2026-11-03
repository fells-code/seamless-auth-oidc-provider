/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import type { AddressInfo } from 'node:net';

import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { createOidcEdge } from '../src/createOidcEdge.js';
import { parseEnv } from '../src/env.js';
import { currentRequestContext } from '../src/requestContext.js';
import { sendToEdge } from './browser.js';
import { API_URL, createFakeApi, SERVICE_SECRET, UI_FIXTURE_DIR } from './fakeApi.js';

const valid = {
  SEAMLESS_API_URL: 'http://auth:5312',
  SEAMLESS_OIDC_SERVICE_TOKEN: SERVICE_SECRET,
  SEAMLESS_COOKIE_SECRET: 'cookie-secret-that-is-at-least-32-characters',
  OIDC_COOKIE_KEYS: 'first-cookie-key-at-least-32-characters',
};

const servers: { close: () => void }[] = [];

afterEach(() => {
  servers.splice(0).forEach((server) => server.close());
});

/** Boots the edge the way server.ts does, with `trust proxy` taken from TRUST_PROXY. */
async function boot(trustProxy: string) {
  const env = parseEnv({ ...valid, TRUST_PROXY: trustProxy });
  const api = createFakeApi();
  const edge = await createOidcEdge({
    apiUrl: API_URL,
    serviceSecret: SERVICE_SECRET,
    cookieKeys: env.OIDC_COOKIE_KEYS,
    adapterCookieSecret: env.SEAMLESS_COOKIE_SECRET,
    fetchAdapterManifest: false,
    uiDir: UI_FIXTURE_DIR,
    trustProxy: env.TRUST_PROXY !== false,
    fetch: api.fetch,
  });
  let clientIp: string | undefined;
  edge.provider.use(async (_ctx, next) => {
    clientIp = currentRequestContext()?.clientIp;
    await next();
  });
  const app = express();
  app.set('trust proxy', env.TRUST_PROXY);
  app.use(edge.router);
  const server = app.listen(0);
  servers.push(server);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    async clientIpFor(forwardedFor: string) {
      clientIp = undefined;
      const reply = await sendToEdge(base, '/jwks', {
        headers: { 'x-forwarded-for': forwardedFor },
      });
      expect(reply.status).toBe(200);
      return clientIp;
    },
  };
}

describe('TRUST_PROXY', () => {
  it('takes a hop count, for a CDN in front of a load balancer', async () => {
    expect(parseEnv({ ...valid, TRUST_PROXY: '2' }).TRUST_PROXY).toBe(2);
    // The load balancer is the socket peer and appended the CDN node; the CDN appended the
    // user's address after whatever the client sent.
    const edge = await boot('2');
    expect(await edge.clientIpFor('192.0.2.66, 198.51.100.7, 203.0.113.10')).toBe('198.51.100.7');
  });

  it('takes a list of trusted proxy addresses and subnets', async () => {
    expect(parseEnv({ ...valid, TRUST_PROXY: '127.0.0.1, 10.0.0.0/8' }).TRUST_PROXY).toEqual([
      '127.0.0.1',
      '10.0.0.0/8',
    ]);
    const edge = await boot('127.0.0.1, 10.0.0.0/8');
    expect(await edge.clientIpFor('192.0.2.66, 198.51.100.7, 10.1.2.3')).toBe('198.51.100.7');
  });
});
