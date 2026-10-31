/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import type { OidcClientResource } from '@seamless-auth/types';
import {
  type AsymmetricSigningAlgorithm,
  type Client,
  errors,
  type KoaContextWithOIDC,
  type ResourceServer,
} from 'oidc-provider';

import type { OidcApiClient } from './apiClient.js';

export const DEFAULT_ACCESS_TOKEN_TTL = 600;

/**
 * RFC 8707 and RFC 9068: a token for a resource is a JWT whose `aud` is the resource's
 * identifier, carrying only scopes the client is allowed there. The API keeps the links and
 * `/oidc/sign` checks the same ones, so this only decides what to ask it to sign.
 */
export function createResourceServerInfo(
  client: OidcApiClient,
  signingAlg: AsymmetricSigningAlgorithm,
) {
  // The library asks once per indicator, sometimes several times in one request.
  const perRequest = new WeakMap<KoaContextWithOIDC, Promise<OidcClientResource[]>>();

  function resourcesFor(ctx: KoaContextWithOIDC, clientId: string) {
    let pending = perRequest.get(ctx);
    if (!pending) {
      pending = client.clientResources(clientId);
      perRequest.set(ctx, pending);
    }
    return pending;
  }

  return async (
    ctx: KoaContextWithOIDC,
    indicator: string,
    oidcClient: Client,
  ): Promise<ResourceServer> => {
    const resources = await resourcesFor(ctx, oidcClient.clientId);
    const resource = resources.find((candidate) => candidate.identifier === indicator);
    if (!resource) {
      throw new errors.InvalidTarget();
    }
    return {
      audience: resource.identifier,
      scope: resource.scopes.join(' '),
      accessTokenTTL: resource.accessTokenTtlSeconds ?? DEFAULT_ACCESS_TOKEN_TTL,
      accessTokenFormat: 'jwt',
      jwt: { sign: { alg: signingAlg } },
    };
  };
}
