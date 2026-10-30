/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import { describe, expect, it } from 'vitest';

import { OidcApiClient, routePath } from '../src/apiClient.js';
import { OidcApiError, OidcSignRefusedError } from '../src/errors.js';
import { runWithRequestContext } from '../src/requestContext.js';
import { API_URL, createFakeApi, json, SERVICE_SECRET } from './fakeApi.js';

function decodeJwtPayload(token: string): Record<string, unknown> {
  const [, payload] = token.split('.');
  return JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8'));
}

describe('routePath', () => {
  it('encodes parameters', () => {
    expect(routePath('/oidc/payloads/:model/:id', { model: 'Grant', id: 'a/b' })).toBe(
      '/oidc/payloads/Grant/a%2Fb',
    );
  });

  it('refuses a missing parameter', () => {
    expect(() => routePath('/oidc/clients/:id')).toThrow(/Missing path parameter id/);
  });
});

describe('OidcApiClient', () => {
  function setup() {
    const api = createFakeApi();
    const client = new OidcApiClient({
      apiUrl: `${API_URL}/`,
      serviceSecret: SERVICE_SECRET,
      fetch: api.fetch,
    });
    return { api, client };
  }

  it('authenticates with a short-lived service token and reuses it', async () => {
    const { api, client } = setup();
    await client.config();
    await client.config();

    const [first, second] = api.requests;
    const token = first?.headers.get('x-seamless-service-token') ?? '';
    expect(first?.headers.get('authorization')).toBeNull();
    expect(second?.headers.get('x-seamless-service-token')).toBe(token);

    const claims = decodeJwtPayload(token);
    expect(claims).toMatchObject({
      iss: 'seamless-portal-api',
      aud: 'seamless-auth',
      sub: 'seamless-oidc-provider',
    });
    expect(Number(claims.exp) - Number(claims.iat)).toBe(60);
  });

  it('forwards the browser context only inside a request', async () => {
    const { api, client } = setup();
    await client.config();
    await runWithRequestContext(
      { correlationId: 'c1', clientIp: '203.0.113.9', userAgent: 'Browser/1.0' },
      () => client.config(),
    );

    expect(api.requests[0]?.headers.get('x-seamless-client-ip')).toBeNull();
    expect(api.requests[1]?.headers.get('x-seamless-client-ip')).toBe('203.0.113.9');
    expect(api.requests[1]?.headers.get('x-seamless-client-user-agent')).toBe('Browser/1.0');
  });

  it('returns undefined on 404 for lookups', async () => {
    const { client } = setup();
    await expect(client.findPayload('Grant', 'missing')).resolves.toBeUndefined();
    await expect(client.findPayloadByUid('Session', 'missing')).resolves.toBeUndefined();
    await expect(client.findPayloadByUserCode('DeviceCode', 'x')).resolves.toBeUndefined();
    await expect(client.client('missing')).resolves.toBeUndefined();
    await expect(client.account('missing')).resolves.toBeUndefined();
    await expect(client.authContext('missing')).resolves.toBeUndefined();
    await expect(client.verifySecret('missing', 'secret')).resolves.toBe(false);
  });

  it('treats 404 as done for idempotent writes', async () => {
    const { api, client } = setup();
    await client.consumePayload('AuthorizationCode', 'c1');
    await client.destroyPayload('Session', 's1');
    await client.revokePayloadsByGrant('AccessToken', 'g1');
    await client.revokeSession('s1', { reason: 'refresh_token_reuse' });
    expect(api.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /oidc/payloads/AuthorizationCode/c1/consume',
      'DELETE /oidc/payloads/Session/s1',
      'DELETE /oidc/payloads/AccessToken/by-grant/g1',
      'POST /oidc/sessions/s1/revoke',
    ]);
  });

  it('throws on other failures', async () => {
    const { api, client } = setup();
    api.on(() => json(500));
    await expect(
      client.event({
        type: 'token_issued',
        correlationId: 'c1',
        occurredAt: new Date().toISOString(),
      }),
    ).rejects.toBeInstanceOf(OidcApiError);
    await expect(client.jwks()).rejects.toBeInstanceOf(OidcApiError);
  });

  it('rejects a response with the wrong shape', async () => {
    const { api, client } = setup();
    api.on(({ path }) => (path === '/oidc/jwks' ? json(200, { keys: 'nope' }) : undefined));
    await expect(client.jwks()).rejects.toThrow(/Unexpected response shape/);
  });

  it('rejects a JWKS that carries a private key', async () => {
    const { api, client } = setup();
    api.on(({ path }) =>
      path === '/oidc/jwks'
        ? json(200, { activeKid: 'k', keys: [{ kty: 'RSA', kid: 'k', alg: 'RS256', d: 'x' }] })
        : undefined,
    );
    await expect(client.jwks()).rejects.toThrow(/Unexpected response shape/);
  });

  it('upserts and reads payloads', async () => {
    const { api, client } = setup();
    api.on(({ method, path }) => {
      if (method === 'PUT') return json(200, { created: true });
      if (path === '/oidc/payloads/Grant/g1') {
        return json(200, {
          payload: { accountId: 'u1' },
          expiresAt: '2026-10-30T12:00:00.000Z',
          consumedAt: null,
        });
      }
      return undefined;
    });
    await expect(
      client.upsertPayload('Grant', 'g1', { payload: {}, expiresIn: 60 }),
    ).resolves.toEqual({ created: true });
    await expect(client.findPayload('Grant', 'g1')).resolves.toMatchObject({
      payload: { accountId: 'u1' },
    });
    expect(api.requests[0]?.body).toEqual({ payload: {}, expiresIn: 60 });
    expect(api.requests[0]?.headers.get('content-type')).toBe('application/json');
  });

  it('verifies a secret', async () => {
    const { api, client } = setup();
    api.on(({ path }) =>
      path === '/oidc/clients/app/verify-secret' ? json(200, { valid: true }) : undefined,
    );
    await expect(client.verifySecret('app', 's')).resolves.toBe(true);
    expect(api.requests[0]?.body).toEqual({ secret: 's' });
  });

  describe('sign', () => {
    const request = {
      kind: 'id_token' as const,
      kid: 'active',
      clientId: 'app',
      sessionId: 's1',
      signingInput: 'eyJ.eyJ',
    };

    it('raises the refusal code', async () => {
      const { api, client } = setup();
      api.on(({ path }) =>
        path === '/oidc/sign' ? json(403, { error: 'session_revoked' }) : undefined,
      );
      const error = await client.sign(request).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OidcSignRefusedError);
      expect((error as OidcSignRefusedError).code).toBe('session_revoked');
    });

    it('raises an API error for an unrecognised failure', async () => {
      const { api, client } = setup();
      api.on(({ path }) => (path === '/oidc/sign' ? json(502) : undefined));
      await expect(client.sign(request)).rejects.toBeInstanceOf(OidcApiError);
    });

    it('rejects a malformed success body', async () => {
      const { api, client } = setup();
      api.on(({ path }) => (path === '/oidc/sign' ? json(200, { kid: 'a' }) : undefined));
      await expect(client.sign(request)).rejects.toThrow(/Unexpected response shape/);
    });
  });
});
