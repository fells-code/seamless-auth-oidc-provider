/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import { describe, expect, it } from 'vitest';

import { OidcApiClient } from '../src/apiClient.js';
import { parseEnv } from '../src/env.js';
import { OidcContractMismatchError, OidcProviderDisabledError } from '../src/errors.js';
import { checkApiCompatibility } from '../src/startup.js';
import { API_URL, createFakeApi, ISSUER, json, SERVICE_SECRET } from './fakeApi.js';

function setup() {
  const api = createFakeApi();
  const client = new OidcApiClient({
    apiUrl: API_URL,
    serviceSecret: SERVICE_SECRET,
    fetch: api.fetch,
  });
  return { api, client };
}

describe('checkApiCompatibility', () => {
  it('returns the API config, including the issuer', async () => {
    const { client } = setup();
    await expect(checkApiCompatibility(client)).resolves.toMatchObject({ issuer: ISSUER });
  });

  it('refuses to start while the provider is disabled', async () => {
    const { api, client } = setup();
    api.on(({ path }) => (path === '/oidc/config' ? json(404) : undefined));
    await expect(checkApiCompatibility(client)).rejects.toBeInstanceOf(OidcProviderDisabledError);
  });

  it('refuses another contract version', async () => {
    const { api, client } = setup();
    api.on(({ path }) =>
      path === '/oidc/config'
        ? json(200, {
            contractVersion: 999,
            issuer: ISSUER,
            appName: 'x',
            allowClientSecrets: false,
            thirdPartyClientsEnabled: false,
          })
        : undefined,
    );
    await expect(checkApiCompatibility(client)).rejects.toBeInstanceOf(OidcContractMismatchError);
  });
});

describe('parseEnv', () => {
  const valid = {
    SEAMLESS_API_URL: 'http://auth:5312',
    SEAMLESS_SERVICE_TOKEN: SERVICE_SECRET,
    SEAMLESS_COOKIE_SECRET: 'cookie-secret-that-is-at-least-32-characters',
    OIDC_COOKIE_KEYS:
      'first-cookie-key-at-least-32-characters, second-cookie-key-at-least-32-chars',
  };

  it('parses defaults and cookie keys', () => {
    expect(parseEnv(valid)).toMatchObject({
      PORT: 5314,
      TRUST_PROXY: false,
      OIDC_COOKIE_KEYS: [
        'first-cookie-key-at-least-32-characters',
        'second-cookie-key-at-least-32-chars',
      ],
    });
    expect(parseEnv({ ...valid, TRUST_PROXY: 'true', PORT: '8080' })).toMatchObject({
      PORT: 8080,
      TRUST_PROXY: true,
    });
  });

  it('names the invalid fields without echoing values', () => {
    expect(() =>
      parseEnv({ ...valid, OIDC_COOKIE_KEYS: 'short', SEAMLESS_SERVICE_TOKEN: 'x' }),
    ).toThrow(/SEAMLESS_SERVICE_TOKEN, OIDC_COOKIE_KEYS/);
    try {
      parseEnv({ ...valid, SEAMLESS_SERVICE_TOKEN: 'leaky' });
    } catch (error) {
      expect(String(error)).not.toContain('leaky');
    }
  });
});
