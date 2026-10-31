/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import type { KoaContextWithOIDC } from 'oidc-provider';
import { errors } from 'oidc-provider';

export const PKCE_REQUIRED_PROPERTY = 'urn:seamless:pkce_required';
export const NONCE_REQUIRED_PROPERTY = 'urn:seamless:nonce_required';

type ClientLike = Record<string, unknown> & { clientAuthMethod?: string };

/**
 * ADR D1, amended. PKCE is required unless the API marked a confidential client as opted
 * out (RFC 9700 section 2.1.1). A public client is never opted out, whatever its metadata
 * says. The library only asks when a code request has no `code_challenge`, so this is
 * where an opted-out client's `nonce` stands in for PKCE. A nonce only binds an ID token,
 * so a request without `openid` still needs PKCE. An admin may also waive the nonce, which
 * leaves `state` and client authentication as the only defence against code injection.
 */
export function pkceRequired(ctx: KoaContextWithOIDC, client: ClientLike | undefined): boolean {
  if (!client || client.clientAuthMethod === 'none' || client[PKCE_REQUIRED_PROPERTY] !== false) {
    return true;
  }
  const params = ctx.oidc.params as { scope?: unknown; nonce?: unknown } | undefined;
  const asksForIdToken =
    typeof params?.scope === 'string' && params.scope.split(' ').includes('openid');
  if (!asksForIdToken) return true;
  if (client[NONCE_REQUIRED_PROPERTY] === false) return false;
  if (typeof params?.nonce !== 'string' || params.nonce === '') {
    throw new errors.InvalidRequest('nonce is required when PKCE is not used');
  }
  return false;
}
