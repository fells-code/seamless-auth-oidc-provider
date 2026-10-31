/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import { generateKeyPairSync, type KeyObject, sign as cryptoSign } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { OIDC_EDGE_CONTRACT_VERSION } from '@seamless-auth/types';

export const API_URL = 'http://api.test';
export const UI_FIXTURE_DIR = fileURLToPath(new URL('./fixtures/ui/', import.meta.url));
export const ISSUER = 'https://login.example.com';
export const SERVICE_SECRET = 'service-secret-that-is-at-least-32-characters';

export interface RecordedRequest {
  method: string;
  path: string;
  search: string;
  headers: Headers;
  body: unknown;
}

type TestJwk = Record<string, string> & { kty: string; kid: string; alg: string; use: 'sig' };

type Handler = (request: RecordedRequest) => Response | undefined;

export function json(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
  });
}

export function rsaKey(kid: string): { privateKey: KeyObject; jwk: TestJwk } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const exported = publicKey.export({ format: 'jwk' }) as Record<string, string>;
  return { privateKey, jwk: { ...exported, kty: 'RSA', kid, alg: 'RS256', use: 'sig' } };
}

export const EDGE_CONFIG = {
  contractVersion: OIDC_EDGE_CONTRACT_VERSION,
  issuer: ISSUER,
  appName: 'Example',
  allowClientSecrets: false,
  thirdPartyClientsEnabled: false,
};

/** A stand-in for the API's /oidc/* routes that signs with a real key. */
export function createFakeApi() {
  const requests: RecordedRequest[] = [];
  const active = rsaKey('active');
  const previous = rsaKey('previous');
  const handlers: Handler[] = [];

  const defaults: Handler = ({ method, path, body }) => {
    if (method === 'GET' && path === '/oidc/config') {
      return json(200, EDGE_CONFIG);
    }
    if (method === 'GET' && path === '/oidc/jwks') {
      return json(200, { activeKid: 'active', keys: [previous.jwk, active.jwk] });
    }
    if (method === 'POST' && path === '/oidc/sign') {
      const { signingInput } = body as { signingInput: string };
      const signature = cryptoSign('sha256', Buffer.from(signingInput), active.privateKey);
      return json(200, { kid: 'active', signature: signature.toString('base64url') });
    }
    return json(404, { error: 'not_found' });
  };

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const request: RecordedRequest = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      search: url.search,
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    requests.push(request);
    for (const handler of handlers) {
      const response = handler(request);
      if (response) {
        return response;
      }
    }
    return defaults(request) ?? json(404);
  };

  return {
    fetch,
    requests,
    active,
    previous,
    on(handler: Handler) {
      handlers.unshift(handler);
    },
  };
}
