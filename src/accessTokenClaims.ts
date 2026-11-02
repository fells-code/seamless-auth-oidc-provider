/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import type { KoaContextWithOIDC } from 'oidc-provider';

import { isDeviceGrant } from './deviceFlow.js';
import { currentRequestContext } from './requestContext.js';

interface IssuedToken {
  kind?: unknown;
  gty?: unknown;
  resourceServer?: unknown;
}

interface AuthContextSource {
  acr?: string | undefined;
  amr?: string[] | undefined;
  authTime?: number | undefined;
}

/**
 * ADR 0002 N7: a user's access token for a resource carries `acr`, `amr` and `auth_time`
 * (RFC 9068 section 2.2.1), so a resource server can require step-up from the token alone.
 * They come from the code or refresh token the grant redeems, the same values the ID token
 * states, which the adapter took from the API's auth context. Introspection returns them too,
 * because the library stores these claims with the token.
 *
 * A device-flow token states none (ADR 0001 D10), a client credentials token has no user, and
 * an opaque token for userinfo gains nothing.
 */
export function accessTokenAuthContext(
  ctx: KoaContextWithOIDC | undefined,
  token: IssuedToken,
): Record<string, unknown> | undefined {
  if (
    !ctx?.oidc ||
    token.kind !== 'AccessToken' ||
    !token.resourceServer ||
    isDeviceGrant(token) ||
    currentRequestContext()?.deviceFlow
  ) {
    return undefined;
  }
  const entities = ctx.oidc.entities as {
    RefreshToken?: AuthContextSource;
    AuthorizationCode?: AuthContextSource;
  };
  const source = entities.RefreshToken ?? entities.AuthorizationCode;
  if (!source) {
    return undefined;
  }
  return {
    ...(source.acr ? { acr: source.acr } : {}),
    ...(source.amr && source.amr.length > 0 ? { amr: [...source.amr] } : {}),
    ...(typeof source.authTime === 'number' ? { auth_time: source.authTime } : {}),
  };
}
