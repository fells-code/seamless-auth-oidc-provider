/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import type { KoaContextWithOIDC } from 'oidc-provider';
import { afterEach, describe, expect, it } from 'vitest';

import { OidcApiClient } from '../src/apiClient.js';
import { createOidcEdge } from '../src/createOidcEdge.js';
import { buildProviderConfiguration, createFindAccount } from '../src/providerConfig.js';
import { currentRequestContext, runWithRequestContext } from '../src/requestContext.js';
import { ApiSigningKey } from '../src/signingKey.js';
import { API_URL, createFakeApi, ISSUER, json, rsaKey, SERVICE_SECRET } from './fakeApi.js';

const options = {
  apiUrl: API_URL,
  serviceSecret: SERVICE_SECRET,
  cookieKeys: ['provider-cookie-key-that-is-at-least-32-chars'],
  adapterCookieSecret: 'adapter-cookie-secret-that-is-at-least-32-chars',
  fetchAdapterManifest: false,
};

const servers: { close: () => void }[] = [];

afterEach(() => {
  servers.splice(0).forEach((server) => server.close());
});

async function serve(app: express.Express): Promise<string> {
  const server = app.listen(0);
  servers.push(server);
  await new Promise((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

interface Reply {
  status: number;
  body: unknown;
}

function call(
  base: string,
  path: string,
  {
    method = 'GET',
    host = new URL(ISSUER).host,
    headers = {},
  }: {
    method?: string;
    host?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      `${base}${path}`,
      { method, headers: { 'x-forwarded-proto': 'https', ...headers, host } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => {
          let body: unknown = text;
          try {
            body = JSON.parse(text);
          } catch {
            // not JSON
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

type Discovery = Record<string, unknown> & {
  grant_types_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  token_endpoint_auth_signing_alg_values_supported: string[];
};

async function boot() {
  const api = createFakeApi();
  const edge = await createOidcEdge({ ...options, fetch: api.fetch, trustProxy: true });
  const app = express();
  app.set('trust proxy', true);
  app.use(edge.router);
  return { api, edge, base: await serve(app) };
}

describe('createOidcEdge', () => {
  it('boots with the issuer from the API', async () => {
    const { edge } = await boot();
    expect(edge.issuer).toBe(ISSUER);
    expect(edge.provider.issuer).toBe(ISSUER);
  });

  it('publishes the locked configuration in discovery', async () => {
    const { base } = await boot();
    const reply = await call(base, '/.well-known/openid-configuration');
    expect(reply.status).toBe(200);
    const discovery = reply.body as Discovery;

    expect(discovery).toMatchObject({
      issuer: ISSUER,
      jwks_uri: `${ISSUER}/jwks`,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      id_token_signing_alg_values_supported: ['RS256'],
      acr_values_supported: ['phr', 'phrh'],
    });
    expect(discovery.grant_types_supported).not.toContain('implicit');
    expect(discovery.token_endpoint_auth_methods_supported).not.toContain('client_secret_jwt');
    expect(discovery.token_endpoint_auth_signing_alg_values_supported).not.toContain('HS256');
    expect(discovery).not.toHaveProperty('registration_endpoint');
    expect(discovery).not.toHaveProperty('device_authorization_endpoint');
  });

  it('publishes the API keys, active first, with no private members', async () => {
    const { api, base } = await boot();
    const jwks = (await call(base, '/jwks')).body as { keys: Record<string, string>[] };
    expect(jwks.keys.map((key) => key.kid)).toEqual(['active', 'previous']);
    expect(jwks.keys[0]).toMatchObject({ kty: 'RSA', n: api.active.jwk.n, e: api.active.jwk.e });
    for (const key of jwks.keys) {
      expect(key).not.toHaveProperty('d');
    }
  });

  it('refuses POST to the authorization endpoint', async () => {
    const { base } = await boot();
    const reply = await call(base, '/authorize', { method: 'POST' });
    expect(reply.status).toBeGreaterThanOrEqual(400);
    expect(reply.status).toBeLessThan(500);
  });

  it('refuses requests for another host', async () => {
    const { base } = await boot();
    const reply = await call(base, '/.well-known/openid-configuration', { host: 'evil.example' });
    expect(reply.status).toBe(421);
  });

  it('refuses plain HTTP for an https issuer', async () => {
    const { base } = await boot();
    const reply = await call(base, '/jwks', { headers: { 'x-forwarded-proto': 'http' } });
    expect(reply.status).toBe(421);
  });

  it('runs every provider request inside a request context', async () => {
    const { edge, base } = await boot();
    let seen: ReturnType<typeof currentRequestContext>;
    edge.provider.use(async (_ctx, next) => {
      seen = currentRequestContext();
      await next();
    });
    await call(base, '/jwks', { headers: { 'user-agent': 'Probe/1.0' } });
    expect(seen).toMatchObject({ userAgent: 'Probe/1.0' });
    expect(seen?.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen?.clientIp).toBeTruthy();
  });

  it('mounts the provider under an issuer path', async () => {
    const api = createFakeApi();
    api.on(({ path }) =>
      path === '/oidc/config'
        ? json(200, {
            contractVersion: 1,
            issuer: `${ISSUER}/oidc`,
            appName: 'x',
            allowClientSecrets: false,
            thirdPartyClientsEnabled: false,
          })
        : undefined,
    );
    const edge = await createOidcEdge({
      ...options,
      fetch: api.fetch,
      apiIssuer: 'http://auth:5312',
      serviceTokenKid: 'kid-1',
      trustProxy: true,
    });
    expect(edge.provider.proxy).toBe(true);
    const app = express();
    app.set('trust proxy', true);
    app.use(edge.router);
    const base = await serve(app);
    const discovery = (await call(base, '/oidc/.well-known/openid-configuration'))
      .body as Discovery;
    expect(discovery.issuer).toBe(`${ISSUER}/oidc`);
  });
});

describe('buildProviderConfiguration', () => {
  const client = new OidcApiClient({ apiUrl: API_URL, serviceSecret: SERVICE_SECRET });
  const config = {
    contractVersion: 1,
    issuer: ISSUER,
    appName: 'x',
    allowClientSecrets: false,
    thirdPartyClientsEnabled: false,
  };

  it('needs a signing key with a supported alg', () => {
    expect(() =>
      buildProviderConfiguration({ client, config, signingKeys: [], cookieKeys: [] }),
    ).toThrow(/No provider signing key/);
  });

  it('refuses an active key with an unsupported alg', () => {
    const { jwk } = rsaKey('weak');
    const key = new ApiSigningKey({ ...jwk, kid: 'weak', alg: 'RS1' }, client, true);
    expect(() =>
      buildProviderConfiguration({ client, config, signingKeys: [key], cookieKeys: [] }),
    ).toThrow(/unsupported alg RS1/);
  });

  it('requires PKCE for every client and rotates refresh tokens', () => {
    const { jwk } = rsaKey('k');
    const configuration = buildProviderConfiguration({
      client,
      config,
      signingKeys: [new ApiSigningKey({ ...jwk, kid: 'k', alg: 'RS256' }, client, true)],
      cookieKeys: [],
    });
    const ctx = {} as KoaContextWithOIDC;
    expect(configuration.pkce?.required?.(ctx, {} as never)).toBe(true);
    expect(configuration.rotateRefreshToken).toBe(true);
  });
});

describe('createFindAccount', () => {
  const ctx = { oidc: { client: { clientId: 'app' } } } as unknown as KoaContextWithOIDC;
  const inSession = <T>(fn: () => T) =>
    runWithRequestContext({ correlationId: 'c1', sessionId: 's1' }, fn);

  it('releases account claims and drops an empty org', async () => {
    const api = createFakeApi();
    api.on(({ path }) =>
      path === '/oidc/accounts/u1'
        ? json(200, {
            sub: 'u1',
            email: 'a@example.com',
            email_verified: true,
            roles: ['user'],
            org_id: null,
          })
        : path === '/oidc/accounts/u2'
          ? json(200, { sub: 'u2', roles: [], org_id: 'org-1' })
          : undefined,
    );
    const client = new OidcApiClient({
      apiUrl: API_URL,
      serviceSecret: SERVICE_SECRET,
      fetch: api.fetch,
    });
    const findAccount = createFindAccount(client);

    const account = await inSession(() => findAccount(ctx, 'u1'));
    expect(api.requests.at(-1)?.search).toBe('?clientId=app&sessionId=s1');
    expect(account?.accountId).toBe('u1');
    expect(await account?.claims('id_token', 'openid', {}, [])).toEqual({
      sub: 'u1',
      email: 'a@example.com',
      email_verified: true,
      roles: ['user'],
    });
    const withOrg = await inSession(() => findAccount(ctx, 'u2'));
    expect(await withOrg?.claims('userinfo', 'openid', {}, [])).toMatchObject({ org_id: 'org-1' });
    expect(await inSession(() => findAccount(ctx, 'missing'))).toBeUndefined();
  });

  it('asks for nothing without a session and a client to bind to', async () => {
    const api = createFakeApi();
    const client = new OidcApiClient({
      apiUrl: API_URL,
      serviceSecret: SERVICE_SECRET,
      fetch: api.fetch,
    });
    const findAccount = createFindAccount(client);

    expect(await findAccount(ctx, 'u1')).toBeUndefined();
    expect(await inSession(() => findAccount({} as KoaContextWithOIDC, 'u1'))).toBeUndefined();
    expect(api.requests).toHaveLength(0);
  });
});
