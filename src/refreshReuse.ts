/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import type { KoaContextWithOIDC } from 'oidc-provider';

import type { OidcApiClient } from './apiClient.js';
import { currentRequestContext } from './requestContext.js';

/**
 * A rotated refresh token presented again means two parties hold it. The library revokes the
 * grant; this ends the first-party session it was issued under too (ADR D3), so whoever has
 * the copy cannot carry on through the user's other apps.
 */
export function revokeSessionOnRefreshReuse(client: OidcApiClient) {
  return async (ctx: KoaContextWithOIDC, next: () => Promise<unknown>) => {
    await next();
    const entities = ctx.oidc?.entities;
    const reused =
      ctx.oidc?.route === 'token' &&
      Boolean(entities?.RefreshToken?.consumed) &&
      !entities?.RotatedRefreshToken;
    const context = currentRequestContext();
    if (!reused || !context?.sessionId) {
      return;
    }
    try {
      await client.revokeSession(context.sessionId, {
        reason: 'refresh_token_reuse',
        correlationId: context.correlationId,
      });
    } catch (error) {
      console.error(
        `[oidc-provider] could not revoke session after refresh token reuse: ${String(error)}`,
      );
    }
  };
}
