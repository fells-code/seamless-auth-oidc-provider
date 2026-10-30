/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import type { OidcEdgeConfigResponse } from '@seamless-auth/types';
import type { Configuration, FindAccount } from 'oidc-provider';

import { createApiAdapterFactory } from './adapter.js';
import type { OidcApiClient } from './apiClient.js';
import { currentRequestContext } from './requestContext.js';
import type { ApiSigningKey } from './signingKey.js';

export const PROVIDER_COOKIE_NAMES = {
  session: '__Host-oidc_session',
  interaction: '__Host-oidc_interaction',
  // The library sets this cookie's Path to the authorization endpoint, and a __Host-
  // cookie must have Path=/, so it cannot take that prefix.
  // TODO(#3): move the resume cookie to Path=/ so it can be __Host- too.
  resume: '__Secure-oidc_resume',
} as const;

const ASYMMETRIC_ALGS = ['RS256', 'PS256', 'ES256', 'Ed25519', 'EdDSA'] as const;

type AsymmetricAlg = (typeof ASYMMETRIC_ALGS)[number];

function isAsymmetricAlg(alg: string): alg is AsymmetricAlg {
  return (ASYMMETRIC_ALGS as readonly string[]).includes(alg);
}

export interface ProviderConfigurationInput {
  client: OidcApiClient;
  config: OidcEdgeConfigResponse;
  signingKeys: ApiSigningKey[];
  cookieKeys: string[];
}

export function createFindAccount(client: OidcApiClient): FindAccount {
  return async (ctx, sub) => {
    // The API releases claims only for the session and client this request serves.
    const clientId = ctx.oidc?.client?.clientId;
    const sessionId = currentRequestContext()?.sessionId;
    if (!clientId || !sessionId) {
      return undefined;
    }
    const claims = await client.account(sub, { clientId, sessionId });
    if (!claims) {
      return undefined;
    }
    const { org_id, ...rest } = claims;
    return {
      accountId: claims.sub,
      claims: () => ({ ...rest, ...(org_id ? { org_id } : {}) }),
    };
  };
}

/**
 * The locked configuration from ADR 0001 (D1, D6). The API's admin routes refuse client
 * settings that would loosen it, so this is the ceiling, not a default.
 */
export function buildProviderConfiguration(input: ProviderConfigurationInput): Configuration {
  const [activeKey] = input.signingKeys;
  if (!activeKey) {
    throw new Error('No provider signing key is available');
  }
  const activeAlg = activeKey.alg;
  if (!isAsymmetricAlg(activeAlg)) {
    throw new Error(`The active provider key uses unsupported alg ${activeAlg}`);
  }
  const signingAlgs = [activeAlg];

  return {
    adapter: createApiAdapterFactory(input.client),
    findAccount: createFindAccount(input.client),
    jwks: { keys: input.signingKeys },
    responseTypes: ['code'],
    pkce: { required: () => true },
    rotateRefreshToken: true,
    enableHttpPostMethods: false,
    // TODO(#8): honour client_secret_basic and client_secret_post through verify-secret.
    // Until then the API never sends a secret, so those clients fail closed.
    clientAuthMethods: ['private_key_jwt', 'none', 'client_secret_basic', 'client_secret_post'],
    enabledJWA: {
      clientAuthSigningAlgValues: [...ASYMMETRIC_ALGS],
      requestObjectSigningAlgValues: [...ASYMMETRIC_ALGS],
      idTokenSigningAlgValues: signingAlgs,
      userinfoSigningAlgValues: signingAlgs,
    },
    acrValues: ['phr', 'phrh'],
    scopes: ['openid', 'offline_access', 'email', 'phone', 'seamless'],
    claims: {
      openid: ['sub'],
      email: ['email', 'email_verified'],
      phone: ['phone_number', 'phone_number_verified'],
      seamless: ['roles', 'org_id'],
    },
    extraClientMetadata: { properties: ['urn:seamless:first_party'] },
    routes: {
      authorization: '/authorize',
      token: '/token',
      userinfo: '/userinfo',
      jwks: '/jwks',
      end_session: '/session/end',
    },
    ttl: {
      AccessToken: 600,
      AuthorizationCode: 60,
      IdToken: 600,
      Interaction: 600,
    },
    cookies: {
      keys: input.cookieKeys,
      names: PROVIDER_COOKIE_NAMES,
      long: { httpOnly: true, sameSite: 'lax', secure: true, path: '/' },
      short: { httpOnly: true, sameSite: 'lax', secure: true, path: '/' },
    },
    // TODO(#3): the hosted UI serves this path and finishes the interaction.
    interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
    features: {
      devInteractions: { enabled: false },
      registration: { enabled: false },
      backchannelLogout: { enabled: false },
      externalSigningSupport: { enabled: true, ack: 'experimental-01' },
      // TODO(#4): client credentials with resource scopes.
      clientCredentials: { enabled: false },
      // TODO(#5): RP-initiated logout through the hosted UI.
      rpInitiatedLogout: { enabled: false },
      // TODO(#6): introspection and revocation.
      introspection: { enabled: false },
      revocation: { enabled: false },
      // TODO(#7): device flow, first-party clients only.
      deviceFlow: { enabled: false },
    },
  };
}
