/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import type Provider from 'oidc-provider';
import { errors, type KoaContextWithOIDC } from 'oidc-provider';

/** `response_mode` from a request object's payload, read without verifying anything. */
function requestObjectResponseMode(request: unknown): unknown {
  if (typeof request !== 'string') {
    return undefined;
  }
  const parts = request.split('.');
  if (parts.length !== 3) {
    return undefined;
  }
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    return typeof payload === 'object' && payload !== null && 'response_mode' in payload
      ? payload.response_mode
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Request objects are not supported, so a request carrying one is refused with
 * request_not_supported. An RP that put `response_mode=form_post` only inside the object
 * (OIDC Core 6.3.3 lets its values supersede the query's) expects the refusal by form post.
 *
 * The library emits `authorization.error` before it picks how to deliver the error, so this
 * sets `response_mode` then. Nothing else is read from the object, and nothing from it is
 * delivered: the library still sends the error only to the request's own redirect_uri, and
 * only once it has checked that URI is registered for the client, or renders the error page.
 */
export function formPostRefusedRequestObjects(provider: Provider) {
  provider.on('authorization.error', (ctx: KoaContextWithOIDC, error: Error) => {
    const params = ctx.oidc?.params;
    if (
      ctx.oidc?.route === 'authorization' &&
      error instanceof errors.RequestNotSupported &&
      params &&
      requestObjectResponseMode(params.request) === 'form_post'
    ) {
      params.response_mode = 'form_post';
    }
  });
}
