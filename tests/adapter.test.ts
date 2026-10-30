/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import { describe, expect, it } from 'vitest';

import {
  ApiClientAdapter,
  ApiPayloadAdapter,
  createApiAdapterFactory,
  ReplayDetectedError,
  UnsupportedModelError,
} from '../src/adapter.js';
import { OidcApiClient } from '../src/apiClient.js';
import { runWithRequestContext } from '../src/requestContext.js';
import { API_URL, createFakeApi, json, SERVICE_SECRET } from './fakeApi.js';

function setup() {
  const api = createFakeApi();
  const client = new OidcApiClient({
    apiUrl: API_URL,
    serviceSecret: SERVICE_SECRET,
    fetch: api.fetch,
  });
  return { api, client };
}

const record = (consumedAt: string | null) =>
  json(200, {
    payload: { jti: 'c1', kind: 'AuthorizationCode' },
    sessionId: null,
    expiresAt: '2026-10-30T12:00:00.000Z',
    consumedAt,
  });

describe('ApiPayloadAdapter', () => {
  it('upserts with the linked session from the request context', async () => {
    const { api, client } = setup();
    api.on(({ method }) => (method === 'PUT' ? json(200, { created: true }) : undefined));
    const adapter = new ApiPayloadAdapter('Grant', client);

    await runWithRequestContext({ correlationId: 'c', sessionId: 'sess-1' }, () =>
      adapter.upsert('g1', { accountId: 'u1' }, 59.4),
    );
    await adapter.upsert('g2', { accountId: 'u1' }, 30);

    expect(api.requests[0]).toMatchObject({
      method: 'PUT',
      path: '/oidc/payloads/Grant/g1',
      body: { payload: { accountId: 'u1' }, expiresIn: 60, sessionId: 'sess-1' },
    });
    expect(api.requests[1]?.body).toEqual({ payload: { accountId: 'u1' }, expiresIn: 30 });
  });

  it('refuses a record without an expiry', async () => {
    const { client } = setup();
    await expect(new ApiPayloadAdapter('Grant', client).upsert('g1', {})).rejects.toBeInstanceOf(
      UnsupportedModelError,
    );
  });

  it('fails closed when a replay detection record already exists', async () => {
    const { api, client } = setup();
    api.on(({ method }) => (method === 'PUT' ? json(200, { created: false }) : undefined));
    await expect(
      new ApiPayloadAdapter('ReplayDetection', client).upsert('j1', { iss: 'x' }, 60),
    ).rejects.toBeInstanceOf(ReplayDetectedError);
    await expect(
      new ApiPayloadAdapter('Grant', client).upsert('g1', {}, 60),
    ).resolves.toBeUndefined();
  });

  it('maps consumedAt to the library consumed flag', async () => {
    const { api, client } = setup();
    api.on(({ path }) =>
      path.endsWith('/c1')
        ? record('2026-10-30T11:00:00.000Z')
        : path.endsWith('/c2')
          ? record(null)
          : undefined,
    );
    const adapter = new ApiPayloadAdapter('AuthorizationCode', client);

    expect(await adapter.find('c1')).toMatchObject({
      jti: 'c1',
      consumed: Date.parse('2026-10-30T11:00:00.000Z') / 1000,
    });
    expect(await adapter.find('c2')).not.toHaveProperty('consumed');
    expect(await adapter.find('missing')).toBeUndefined();
  });

  it('finds by user code and uid', async () => {
    const { api, client } = setup();
    api.on(({ path }) => (path.includes('/by-') ? record(null) : undefined));
    await expect(
      new ApiPayloadAdapter('DeviceCode', client).findByUserCode('ABCD'),
    ).resolves.toMatchObject({ jti: 'c1' });
    await expect(new ApiPayloadAdapter('Session', client).findByUid('u1')).resolves.toMatchObject({
      jti: 'c1',
    });
    expect(api.requests.map((r) => r.path)).toEqual([
      '/oidc/payloads/DeviceCode/by-user-code/ABCD',
      '/oidc/payloads/Session/by-uid/u1',
    ]);
  });

  it('consumes, destroys and revokes by grant', async () => {
    const { api, client } = setup();
    const adapter = new ApiPayloadAdapter('RefreshToken', client);
    await adapter.consume('r1');
    await adapter.destroy('r1');
    await adapter.revokeByGrantId('g1');
    expect(api.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /oidc/payloads/RefreshToken/r1/consume',
      'DELETE /oidc/payloads/RefreshToken/r1',
      'DELETE /oidc/payloads/RefreshToken/by-grant/g1',
    ]);
  });

  it('refuses models the API does not store', async () => {
    const { api, client } = setup();
    const adapter = new ApiPayloadAdapter('RegistrationAccessToken', client);
    await expect(adapter.find('x')).rejects.toBeInstanceOf(UnsupportedModelError);
    await expect(adapter.upsert('x', {}, 60)).rejects.toBeInstanceOf(UnsupportedModelError);
    expect(api.requests).toHaveLength(0);
  });
});

describe('ApiClientAdapter', () => {
  const metadata = {
    client_id: 'app',
    client_name: 'App',
    application_type: 'web',
    token_endpoint_auth_method: 'private_key_jwt',
    grant_types: ['authorization_code'],
    response_types: ['code'],
    redirect_uris: ['https://app.example.com/callback'],
    post_logout_redirect_uris: [],
    jwks_uri: 'https://app.example.com/jwks',
    'urn:seamless:first_party': true,
  };

  it('reads clients from the registry', async () => {
    const { api, client } = setup();
    api.on(({ path }) => (path === '/oidc/clients/app' ? json(200, metadata) : undefined));
    const adapter = new ApiClientAdapter(client);
    await expect(adapter.find('app')).resolves.toMatchObject({ client_id: 'app' });
    await expect(adapter.find('other')).resolves.toBeUndefined();
  });

  it('never writes clients', async () => {
    const { client } = setup();
    const adapter = new ApiClientAdapter(client);
    for (const call of [
      () => adapter.upsert(),
      () => adapter.findByUserCode(),
      () => adapter.findByUid(),
      () => adapter.consume(),
      () => adapter.destroy(),
      () => adapter.revokeByGrantId(),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(UnsupportedModelError);
    }
  });
});

describe('createApiAdapterFactory', () => {
  it('routes Client to the registry and the rest to payload storage', () => {
    const { client } = setup();
    const factory = createApiAdapterFactory(client);
    expect(factory('Client')).toBeInstanceOf(ApiClientAdapter);
    expect(factory('Session')).toBeInstanceOf(ApiPayloadAdapter);
  });
});
