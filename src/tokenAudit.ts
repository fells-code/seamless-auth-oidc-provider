/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import type { KoaContextWithOIDC } from 'oidc-provider';

import type { OidcApiClient } from './apiClient.js';
import { currentRequestContext } from './requestContext.js';

const REVOCABLE = ['RefreshToken', 'AccessToken', 'ClientCredentials'] as const;

/** Records a token an app revoked (RFC 7009) in the API's audit log. */
export function auditRevocations(client: OidcApiClient) {
  return async (ctx: KoaContextWithOIDC, next: () => Promise<unknown>) => {
    await next();
    if (ctx.oidc?.route !== 'revocation' || ctx.status !== 200) {
      return;
    }
    const entities = ctx.oidc.entities as Record<
      string,
      { clientId?: string; accountId?: string; grantId?: string } | undefined
    >;
    const kind = REVOCABLE.find((name) => entities[name]);
    const token = kind ? entities[kind] : undefined;
    const context = currentRequestContext();
    if (!kind || !token || !context) {
      return;
    }
    try {
      await client.event({
        type: 'token_revoked',
        correlationId: context.correlationId,
        occurredAt: new Date().toISOString(),
        ...(token.clientId ? { clientId: token.clientId } : {}),
        ...(token.accountId && context.sessionId
          ? { userId: token.accountId, sessionId: context.sessionId }
          : {}),
        ...(token.grantId ? { grantId: token.grantId } : {}),
        metadata: { tokenType: kind },
      });
    } catch (error) {
      console.error(`[oidc-provider] could not record a token revocation: ${String(error)}`);
    }
  };
}
