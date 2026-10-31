/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import type { KoaContextWithOIDC } from 'oidc-provider';

import type { OidcApiClient } from './apiClient.js';
import { currentRequestContext } from './requestContext.js';

/**
 * A rotated refresh token presented again means two parties hold it, and so does one that
 * a concurrent refresh consumed first (the API's consume answers which call won). The library revokes the
 * grant; this ends the first-party session it was issued under too (ADR D3), so whoever has
 * the copy cannot carry on through the user's other apps.
 */
async function revokeGrant(ctx: KoaContextWithOIDC, grantId: string) {
  const { provider } = ctx.oidc;
  try {
    await Promise.all([
      provider.AccessToken.revokeByGrantId(grantId),
      provider.RefreshToken.revokeByGrantId(grantId),
      provider.Grant.adapter.destroy(grantId),
    ]);
  } catch (error) {
    console.error(`[oidc-provider] could not revoke a reused code's grant: ${String(error)}`);
  }
}

export function revokeSessionOnRefreshReuse(client: OidcApiClient) {
  return async (ctx: KoaContextWithOIDC, next: () => Promise<unknown>) => {
    await next();
    const entities = ctx.oidc?.entities;
    const context = currentRequestContext();
    if (ctx.oidc?.route !== 'token' || !context) {
      return;
    }
    // A code redeemed by a concurrent request: as the library does for a sequential reuse,
    // everything issued under its grant goes.
    const lost = context.lostConsume;
    if (lost && lost.model !== 'RefreshToken' && lost.grantId) {
      await revokeGrant(ctx, lost.grantId);
    }
    const reused =
      lost?.model === 'RefreshToken' ||
      (Boolean(entities?.RefreshToken?.consumed) && !entities?.RotatedRefreshToken);
    if (!reused || !context.sessionId) {
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
