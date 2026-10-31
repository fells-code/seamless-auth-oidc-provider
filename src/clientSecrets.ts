/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import { randomBytes } from 'node:crypto';

import type { Middleware } from 'koa';

import type { OidcApiClient } from './apiClient.js';
import { currentRequestContext } from './requestContext.js';

// The library's own body limit, so a body it would refuse is refused here first.
const BODY_LIMIT = 56 * 1024;

const FORM = 'application/x-www-form-urlencoded';

/** RFC 6749 section 2.3.1: Basic credentials are form-encoded before base64. */
function formDecode(value: string): string {
  return decodeURIComponent(value.replace(/\+/g, ' '));
}

function formEncode(value: string): string {
  return encodeURIComponent(value);
}

interface Presented {
  clientId: string;
  secret: string;
  via: 'basic' | 'post';
}

function fromBasic(header: string | undefined): Presented | undefined {
  const [scheme, token, extra] = (header ?? '').split(' ');
  if (scheme?.toLowerCase() !== 'basic' || !token || extra !== undefined) {
    return undefined;
  }
  const decoded = Buffer.from(token, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 1) {
    return undefined;
  }
  try {
    const clientId = formDecode(decoded.slice(0, colon));
    const secret = formDecode(decoded.slice(colon + 1));
    return secret ? { clientId, secret, via: 'basic' } : undefined;
  } catch {
    return undefined;
  }
}

async function readBody(stream: AsyncIterable<Buffer>): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of stream) {
    received += chunk.length;
    if (received > BODY_LIMIT) {
      return undefined;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, received);
}

/**
 * ADR D6: a shared secret is checked by the API, never by this service. A presented secret
 * is sent to `verify-secret`, and when the API accepts it, it is swapped in the request for a
 * one-time value that the client's metadata carries for this request only (see
 * `ApiClientAdapter`). The library compares against that value, so it never holds the real
 * secret, and a secret the API did not accept can match nothing.
 */
export function verifyClientSecrets(client: OidcApiClient): Middleware {
  return async (ctx, next) => {
    if (ctx.method !== 'POST') {
      await next();
      return;
    }

    let body: URLSearchParams | undefined;
    if (ctx.is(FORM) && ctx.req.readable) {
      const raw = await readBody(ctx.req);
      if (raw === undefined) {
        ctx.status = 413;
        ctx.body = { error: 'invalid_request', error_description: 'request entity too large' };
        return;
      }
      // The library reads a body an upstream parser already consumed from req.body.
      (ctx.req as { body?: unknown }).body = raw;
      body = new URLSearchParams(raw.toString('utf8'));
    }

    const basic = fromBasic(ctx.get('authorization') || undefined);
    const postSecret = body?.get('client_secret');
    const postClientId = body?.get('client_id');
    // Two mechanisms at once is the library's to refuse, so it gets the request untouched.
    const presented: Presented | undefined =
      basic && postSecret
        ? undefined
        : (basic ??
          (postSecret && postClientId
            ? { clientId: postClientId, secret: postSecret, via: 'post' }
            : undefined));

    if (presented && (await client.verifySecret(presented.clientId, presented.secret))) {
      const oneTime = randomBytes(32).toString('base64url');
      const context = currentRequestContext();
      if (context) {
        context.verifiedClientSecret = { clientId: presented.clientId, value: oneTime };
      }
      if (presented.via === 'basic') {
        const credentials = `${formEncode(presented.clientId)}:${formEncode(oneTime)}`;
        ctx.req.headers.authorization = `Basic ${Buffer.from(credentials).toString('base64')}`;
      } else if (body) {
        body.set('client_secret', oneTime);
        (ctx.req as { body?: unknown }).body = Buffer.from(body.toString());
      }
    }

    await next();
  };
}
