/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import { verify } from 'node:crypto';

import type { Adapter, AdapterPayload, KoaContextWithOIDC } from 'oidc-provider';

import { currentRequestContext } from './requestContext.js';
import type { ApiSigningKey } from './signingKey.js';

function decode(segment: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Maps a JWT access token this provider signed back to its `jti`. Only RS256, the one alg the
 * API signs with, and only after the signature checks out against a published provider key.
 */
export function createJwtAccessTokenLookup(keys: readonly ApiSigningKey[], issuer: string) {
  return (value: string): string | undefined => {
    const [header, payload, signature, extra] = value.split('.');
    if (!header || !payload || !signature || extra !== undefined) {
      return undefined;
    }
    const parsedHeader = decode(header);
    if (parsedHeader?.typ !== 'at+jwt' || parsedHeader.alg !== 'RS256') {
      return undefined;
    }
    const key = keys.find((candidate) => candidate.kid === parsedHeader.kid);
    if (
      !key ||
      !verify(
        'sha256',
        Buffer.from(`${header}.${payload}`),
        key.keyObject(),
        Buffer.from(signature, 'base64url'),
      )
    ) {
      return undefined;
    }
    const claims = decode(payload);
    return claims?.iss === issuer && typeof claims.jti === 'string' && claims.jti
      ? claims.jti
      : undefined;
  };
}

// The library's own limit for these bodies.
const BODY_LIMIT = 56 * 1024;

// Matches no stored token (stored ids are never dotted) and does not parse as a JWT, so the
// library answers it as any unknown token: inactive, or revoked with nothing to revoke.
const UNKNOWN_TOKEN = 'unknown.token';

async function readBody(stream: AsyncIterable<Buffer>): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > BODY_LIMIT) {
      return undefined;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The library refuses JWTs at introspection and revocation, because it looks tokens up by the
 * presented value and stores a JWT access token under its `jti`. A resource server holding a
 * JWT is the one that most needs to see a revoked session, so the `token` parameter is swapped
 * for the `jti` of a JWT this provider signed before the library reads the body.
 */
export function acceptJwtAccessTokens(
  lookup: (value: string) => string | undefined,
  paths: string[],
) {
  const routes = new Set(paths);
  return async (ctx: KoaContextWithOIDC, next: () => Promise<unknown>) => {
    if (
      ctx.method !== 'POST' ||
      !routes.has(ctx.path) ||
      !ctx.is('application/x-www-form-urlencoded')
    ) {
      return next();
    }
    const request = ctx.req as typeof ctx.req & { body?: unknown };
    // verifyClientSecrets may have read the body already and left it here.
    const body = request.readable
      ? await readBody(request)
      : Buffer.isBuffer(request.body) || typeof request.body === 'string'
        ? request.body.toString()
        : undefined;
    if (body === undefined) {
      ctx.status = 413;
      ctx.body = { error: 'invalid_request', error_description: 'request entity too large' };
      return undefined;
    }
    const params = new URLSearchParams(body);
    const token = params.get('token');
    if (token?.includes('.')) {
      const jti = lookup(token);
      params.set('token', jti ?? UNKNOWN_TOKEN);
      const context = currentRequestContext();
      if (jti && context) {
        context.verifiedJwtTokenId = jti;
      }
    }
    // The library reads an already consumed body from here.
    request.body = params.toString();
    return next();
  };
}

interface StoredTokenClass {
  adapter: Adapter;
  IN_PAYLOAD: readonly string[];
}

/**
 * The library keeps no record of a JWT access token, so nothing could revoke one or report it
 * inactive once its session ends. This stores one under the `jti`, bound to the session like
 * every other record, and marked `jwt` so that only a request presenting the verified JWT
 * itself can load it (the `jti` alone is not a bearer token).
 */
export async function storeJwtAccessToken(
  _ctx: unknown,
  token: object,
  jwt: { payload: Record<string, unknown> },
): Promise<void> {
  const record = token as Record<string, unknown>;
  const { adapter, IN_PAYLOAD } = token.constructor as unknown as StoredTokenClass;
  const { jti, iat, exp } = jwt.payload;
  const now = Math.floor(Date.now() / 1000);
  if (typeof jti !== 'string' || typeof exp !== 'number' || exp <= now) {
    throw new Error('A JWT access token without a jti or a future exp cannot be stored');
  }
  const payload: AdapterPayload = { format: 'jwt' };
  for (const key of IN_PAYLOAD) {
    if (record[key] !== undefined) {
      payload[key] = record[key];
    }
  }
  Object.assign(payload, { jti, iat, exp });
  await adapter.upsert(jti, payload, exp - now);
}
