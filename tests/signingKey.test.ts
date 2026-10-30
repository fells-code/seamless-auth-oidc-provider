/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import { createPublicKey, verify } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { OidcApiClient } from '../src/apiClient.js';
import { runWithRequestContext } from '../src/requestContext.js';
import { classifyToken, signingKeysFrom, UnsignableTokenError } from '../src/signingKey.js';
import { API_URL, createFakeApi, SERVICE_SECRET } from './fakeApi.js';

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

function setup() {
  const api = createFakeApi();
  const client = new OidcApiClient({
    apiUrl: API_URL,
    serviceSecret: SERVICE_SECRET,
    fetch: api.fetch,
  });
  return { api, client };
}

describe('classifyToken', () => {
  it('classifies ID tokens by audience', () => {
    expect(classifyToken({ alg: 'RS256' }, { aud: 'app' }, 's1')).toEqual({
      kind: 'id_token',
      clientId: 'app',
    });
    expect(classifyToken({}, { aud: ['app', 'other'] }, 's1')).toEqual({
      kind: 'id_token',
      clientId: 'app',
    });
    expect(classifyToken({}, { aud: ['x'], azp: 'app' }, 's1')).toEqual({
      kind: 'id_token',
      clientId: 'app',
    });
  });

  it('classifies access tokens', () => {
    expect(classifyToken({ typ: 'at+jwt' }, { client_id: 'app', sub: 'u1' }, 's1')).toEqual({
      kind: 'access_token',
      clientId: 'app',
    });
    expect(classifyToken({ typ: 'at+jwt' }, { client_id: 'svc', sub: 'svc' }, undefined)).toEqual({
      kind: 'client_credentials',
      clientId: 'svc',
    });
  });

  it('refuses logout tokens, unknown types and missing clients', () => {
    expect(() => classifyToken({ typ: 'logout+jwt' }, {}, 's1')).toThrow(UnsignableTokenError);
    expect(() => classifyToken({ typ: 'JWT' }, {}, 's1')).toThrow(/unexpected typ/);
    expect(() => classifyToken({ typ: 'at+jwt' }, { sub: 'u1' }, 's1')).toThrow(/client_id/);
    expect(() => classifyToken({}, { aud: [] }, 's1')).toThrow(/audience/);
  });
});

describe('signingKeysFrom', () => {
  it('puts the active key first and marks the rest published only', async () => {
    const { api, client } = setup();
    const keys = signingKeysFrom(await client.jwks(), client);
    expect(keys.map((key) => [key.kid, key.active])).toEqual([
      ['active', true],
      ['previous', false],
    ]);
    expect(keys[0]?.alg).toBe('RS256');
    expect(keys[0]?.kty).toBe('RSA');
    expect(keys[0]?.n).toBe(api.active.jwk.n);
  });

  it('refuses a JWKS without its active key', () => {
    const { client } = setup();
    expect(() => signingKeysFrom({ activeKid: 'gone', keys: [] }, client)).toThrow(
      /not in its JWKS/,
    );
  });
});

describe('ApiSigningKey.sign', () => {
  it('signs through the API with the linked session', async () => {
    const { api, client } = setup();
    const [active] = signingKeysFrom(await client.jwks(), client);
    const input = `${b64({ alg: 'RS256' })}.${b64({ aud: 'app', sub: 'u1' })}`;

    const signature = await runWithRequestContext({ correlationId: 'c', sessionId: 's1' }, () =>
      active!.sign(Buffer.from(input)),
    );

    expect(api.requests.at(-1)?.body).toEqual({
      kind: 'id_token',
      kid: 'active',
      clientId: 'app',
      sessionId: 's1',
      signingInput: input,
    });
    const publicKey = createPublicKey({ key: api.active.jwk, format: 'jwk' });
    expect(verify('sha256', Buffer.from(input), publicKey, Buffer.from(signature))).toBe(true);
  });

  it('refuses to sign with a key that is not active', async () => {
    const { client } = setup();
    const [, previous] = signingKeysFrom(await client.jwks(), client);
    await expect(previous!.sign(Buffer.from('a.b'))).rejects.toThrow(/not active/);
  });

  it('refuses malformed input and a mismatched alg before calling the API', async () => {
    const { api, client } = setup();
    const [active] = signingKeysFrom(await client.jwks(), client);
    const calls = api.requests.length;
    await expect(active!.sign(Buffer.from('a.b.c'))).rejects.toThrow(/malformed/);
    await expect(active!.sign(Buffer.from(b64({ alg: 'RS256' })))).rejects.toThrow(/malformed/);
    await expect(active!.sign(Buffer.from(`${b64([1])}.${b64({})}`))).rejects.toThrow(/malformed/);
    await expect(active!.sign(Buffer.from(`${b64({ alg: 'PS256' })}.${b64({})}`))).rejects.toThrow(
      /does not match/,
    );
    expect(api.requests.length).toBe(calls);
  });
});
