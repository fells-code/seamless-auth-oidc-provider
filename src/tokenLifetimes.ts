/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import type { KoaContextWithOIDC } from 'oidc-provider';

import { DEFAULT_ACCESS_TOKEN_TTL } from './resourceServers.js';

export const CLIENT_TTL_PROPERTIES = {
  accessToken: 'urn:seamless:access_token_ttl',
  idToken: 'urn:seamless:id_token_ttl',
  refreshToken: 'urn:seamless:refresh_token_ttl',
} as const;

export const DEFAULT_ID_TOKEN_TTL = 600;
export const DEFAULT_REFRESH_TOKEN_TTL = 14 * 24 * 60 * 60;

type ClientLike = Record<string, unknown> & {
  applicationType?: string;
  clientAuthMethod?: string;
};

function clientTtl(client: ClientLike | undefined, property: string): number | undefined {
  const value = client?.[property];
  return typeof value === 'number' && value > 0 ? value : undefined;
}

/** The resource's lifetime, the application's, or the default: the shortest that is set. */
export function accessTokenTtl(
  _ctx: KoaContextWithOIDC,
  token: { resourceServer?: { accessTokenTTL?: number } },
  client: ClientLike,
): number {
  const ttls = [
    token.resourceServer?.accessTokenTTL,
    clientTtl(client, CLIENT_TTL_PROPERTIES.accessToken),
  ].filter((ttl): ttl is number => ttl !== undefined);
  return ttls.length > 0 ? Math.min(...ttls) : DEFAULT_ACCESS_TOKEN_TTL;
}

export function idTokenTtl(_ctx: KoaContextWithOIDC, _token: unknown, client: ClientLike): number {
  return clientTtl(client, CLIENT_TTL_PROPERTIES.idToken) ?? DEFAULT_ID_TOKEN_TTL;
}

/** At least as long as the application's refresh tokens, which the grant must outlive. */
export function grantLifetime(client: unknown): number {
  return Math.max(
    DEFAULT_REFRESH_TOKEN_TTL,
    clientTtl(client as ClientLike | undefined, CLIENT_TTL_PROPERTIES.refreshToken) ?? 0,
  );
}

export function grantTtl(ctx: KoaContextWithOIDC | undefined): number {
  return grantLifetime(ctx?.oidc?.client);
}

/**
 * The application's lifetime, or the library's 14 days. As the library does, a rotated token
 * for a browser app that cannot bind it to a key keeps what was left of the one it replaces,
 * so rotating never extends how long a stolen chain lives.
 */
export function refreshTokenTtl(
  ctx: KoaContextWithOIDC | undefined,
  token: { isSenderConstrained: () => boolean },
  client: ClientLike,
): number {
  const rotated = ctx?.oidc?.entities.RotatedRefreshToken;
  if (
    rotated &&
    client.applicationType === 'web' &&
    client.clientAuthMethod === 'none' &&
    !token.isSenderConstrained()
  ) {
    return rotated.remainingTTL;
  }
  return clientTtl(client, CLIENT_TTL_PROPERTIES.refreshToken) ?? DEFAULT_REFRESH_TOKEN_TTL;
}
