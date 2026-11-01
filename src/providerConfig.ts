/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import type { OidcAuthContext, OidcEdgeConfigResponse } from '@seamless-auth/types';
import {
  type Configuration,
  type FindAccount,
  interactionPolicy,
  type KoaContextWithOIDC,
} from 'oidc-provider';

import { createApiAdapterFactory } from './adapter.js';
import type { OidcApiClient } from './apiClient.js';
import {
  ACR_VALUES,
  authRequirements,
  hasRequirements,
  meetsAcr,
  unmetRequirements,
} from './authRequirements.js';
import type { EdgeConfigCache } from './configCache.js';
import { createDevicePages, DEVICE_CODE_TTL_SECONDS } from './deviceFlow.js';
import type { HostedPageRenderer } from './hostedPages.js';
import { FIRST_PARTY_CLIENT_PROPERTY } from './interactions.js';
import { storeJwtAccessToken } from './jwtAccessTokens.js';
import { createLogoutPages } from './logout.js';
import { currentRequestContext } from './requestContext.js';
import { createResourceIndicators, DEFAULT_ACCESS_TOKEN_TTL } from './resourceServers.js';
import type { ApiSigningKey } from './signingKey.js';

export const PROVIDER_COOKIE_NAMES = {
  session: '__Host-oidc_session',
  interaction: '__Host-oidc_interaction',
  // The library scopes this one to the resume path. hostOnlyResumeCookie moves it to Path=/.
  resume: '__Host-oidc_resume',
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
  configCache: EdgeConfigCache;
  renderPage: HostedPageRenderer;
}

// The routes where the library loads the browser session's account before the grant. The
// device flow's verification page runs the same authorization checks in the browser.
const AUTHORIZATION_ROUTES = new Set([
  'authorization',
  'resume',
  'code_verification',
  'device_resume',
]);

export function createFindAccount(client: OidcApiClient): FindAccount {
  return async (ctx, sub) => {
    // The API releases claims only for the session and client this request serves.
    const clientId = ctx.oidc?.client?.clientId;
    const sessionId = currentRequestContext()?.sessionId;
    const claims =
      clientId && sessionId ? await client.account(sub, { clientId, sessionId }) : undefined;
    if (claims) {
      const { org_id, ...rest } = claims;
      return {
        accountId: claims.sub,
        claims: () => ({ ...rest, ...(org_id ? { org_id } : {}) }),
      };
    }
    // A client this session has not used yet has no grant, so the API will not describe the
    // account. At authorization the library only needs to know the provider session's own
    // account; claims are read at the token and userinfo endpoints, once the grant exists.
    if (AUTHORIZATION_ROUTES.has(ctx.oidc?.route) && ctx.oidc.session?.accountId === sub) {
      return { accountId: sub, claims: () => ({ sub }) };
    }
    return undefined;
  };
}

/**
 * First-party clients have consent implied, so their grant is created or topped up with what
 * they ask for. Third-party clients (ADR D10) see the consent page on every authorization: only the
 * grant the interaction just produced counts, never one remembered on the provider session.
 */
export async function loadExistingGrant(ctx: KoaContextWithOIDC) {
  const { oidc } = ctx;
  const client = oidc.client;
  if (!client) {
    return undefined;
  }
  const firstParty = client[FIRST_PARTY_CLIENT_PROPERTY] === true;
  const grantId =
    oidc.result?.consent?.grantId ??
    (firstParty ? oidc.session?.grantIdFor(client.clientId) : undefined);
  const accountId = oidc.session?.accountId;
  if (!grantId && !(firstParty && accountId)) {
    return undefined;
  }
  const grant = grantId
    ? await oidc.provider.Grant.find(grantId)
    : new oidc.provider.Grant({ accountId, clientId: client.clientId });
  if (!grant || !firstParty) {
    return grant;
  }
  const granted = new Set(grant.getOIDCScope().split(' '));
  const scopes = [...oidc.requestParamOIDCScopes].filter((scope) => !granted.has(scope));
  const grantedClaims = new Set(grant.getOIDCClaims());
  const claims = [...oidc.requestParamClaims].filter((claim) => !grantedClaims.has(claim));
  let resourcesChanged = false;
  for (const [indicator, server] of Object.entries(oidc.resourceServers ?? {})) {
    const offered = new Set((server.scope ?? '').split(' '));
    const held = new Set((grant.getResourceScope(indicator) ?? '').split(' '));
    const missing = [...oidc.requestParamScopes].filter(
      (scope) => offered.has(scope) && !held.has(scope),
    );
    if (missing.length > 0) {
      grant.addResourceScope(indicator, missing.join(' '));
      resourcesChanged = true;
    }
  }
  if (!grantId || scopes.length > 0 || claims.length > 0 || resourcesChanged) {
    grant.addOIDCScope(scopes.join(' '));
    grant.addOIDCClaims(claims);
    await grant.save();
  }
  return grant;
}

type ProviderSession = NonNullable<KoaContextWithOIDC['oidc']['session']>;

function adoptAuthContext(session: ProviderSession, context: OidcAuthContext): void {
  session.acr = context.acr ?? undefined;
  session.amr = context.amr.length > 0 ? [...context.amr] : undefined;
  session.loginTs = context.authTime;
}

/**
 * Replaces the library's max_age and essential acr checks, which read the provider session's
 * copy of the login and want an exact acr match. The API's auth context is the record: it
 * moves with every step-up, and /oidc/sign refuses any acr, amr or auth_time that differs.
 */
export function authContextCheck(client: OidcApiClient) {
  return new interactionPolicy.Check(
    'auth_context',
    'the requested authentication could not be obtained',
    async (ctx) => {
      const { oidc } = ctx;
      const accountId = oidc.session?.accountId;
      if (!oidc.session || !accountId || !oidc.client) {
        return interactionPolicy.Check.NO_NEED_TO_PROMPT;
      }
      const requirements = authRequirements(oidc.params ?? {});
      const login = oidc.result?.login;
      // A device approval always signs in again (see the DeviceCode upsert in adapter.ts).
      if (oidc.route === 'code_verification' && !login) {
        return interactionPolicy.Check.REQUEST_PROMPT;
      }
      if (login) {
        // The interaction copied these from the API after checking freshness itself.
        return requirements.acr && !meetsAcr(login.acr, requirements.acr)
          ? interactionPolicy.Check.REQUEST_PROMPT
          : interactionPolicy.Check.NO_NEED_TO_PROMPT;
      }
      const sessionId = currentRequestContext()?.sessionId;
      const context = sessionId
        ? await client.authContext(sessionId, oidc.client.clientId)
        : undefined;
      if (context) {
        if (!context.active || context.recovery || context.userId !== accountId) {
          return interactionPolicy.Check.REQUEST_PROMPT;
        }
        adoptAuthContext(oidc.session, context);
      }
      if (!hasRequirements(requirements)) {
        return interactionPolicy.Check.NO_NEED_TO_PROMPT;
      }
      return !context || unmetRequirements(requirements, context)
        ? interactionPolicy.Check.REQUEST_PROMPT
        : interactionPolicy.Check.NO_NEED_TO_PROMPT;
    },
  );
}

export function buildInteractionPolicy(client: OidcApiClient) {
  const policy = interactionPolicy.base();
  const login = policy.get('login');
  if (!login) {
    throw new Error('The base interaction policy has no login prompt');
  }
  for (const reason of ['max_age', 'essential_acrs', 'essential_acr']) {
    login.checks.remove(reason);
  }
  login.checks.add(authContextCheck(client));
  return policy;
}

/**
 * A client may introspect its own tokens. A resource server is a confidential client linked
 * to its resource, so it may introspect tokens whose audience is that resource and nothing
 * else: no client sees the tokens of apps it has no part in.
 */
export function createIntrospectionPolicy(client: OidcApiClient) {
  return async (
    _ctx: KoaContextWithOIDC,
    caller: { clientId: string; clientAuthMethod?: string | undefined },
    token: { clientId?: string; aud?: string | string[] },
  ): Promise<boolean> => {
    if (token.clientId === caller.clientId) {
      return true;
    }
    if (caller.clientAuthMethod === 'none' || typeof token.aud !== 'string') {
      return false;
    }
    const resources = await client.clientResources(caller.clientId);
    return resources.some((resource) => resource.identifier === token.aud);
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
  const resourceIndicators = createResourceIndicators(input.client, activeAlg);

  return {
    adapter: createApiAdapterFactory(input.client, input.configCache),
    findAccount: createFindAccount(input.client),
    loadExistingGrant,
    jwks: { keys: input.signingKeys },
    responseTypes: ['code'],
    pkce: { required: () => true },
    // Many RPs read the profile from the ID token rather than calling userinfo.
    conformIdTokenClaims: false,
    rotateRefreshToken: true,
    enableHttpPostMethods: false,
    // ADR D6. Shared secrets are offered only on an instance that allows them, and are
    // checked by the API (verifyClientSecrets). client_secret_jwt is never offered.
    clientAuthMethods: [
      'private_key_jwt',
      'none',
      ...(input.config.allowClientSecrets
        ? (['client_secret_basic', 'client_secret_post'] as const)
        : []),
    ],
    enabledJWA: {
      clientAuthSigningAlgValues: [...ASYMMETRIC_ALGS],
      requestObjectSigningAlgValues: [...ASYMMETRIC_ALGS],
      idTokenSigningAlgValues: signingAlgs,
      userinfoSigningAlgValues: signingAlgs,
    },
    acrValues: [...ACR_VALUES],
    scopes: ['openid', 'offline_access', 'email', 'phone', 'seamless'],
    // Listing claims replaces the library's defaults. The session claims sit under openid so
    // every ID token carries the assurance the API recorded (ADR D9, D11), asked for or not.
    claims: {
      sid: null,
      openid: ['sub', 'acr', 'amr', 'auth_time'],
      email: ['email', 'email_verified'],
      phone: ['phone_number', 'phone_number_verified'],
      seamless: ['roles', 'org_id'],
    },
    extraClientMetadata: { properties: ['urn:seamless:first_party'] },
    routes: {
      authorization: '/authorize',
      token: '/token',
      introspection: '/token/introspection',
      revocation: '/token/revocation',
      userinfo: '/userinfo',
      jwks: '/jwks',
      end_session: '/session/end',
      code_verification: '/device',
      device_authorization: '/device/auth',
    },
    formats: { customizers: { jwt: storeJwtAccessToken } },
    ttl: {
      // A number here would override the resource's own lifetime.
      AccessToken: (_ctx, token) =>
        token.resourceServer?.accessTokenTTL ?? DEFAULT_ACCESS_TOKEN_TTL,
      AuthorizationCode: 60,
      DeviceCode: DEVICE_CODE_TTL_SECONDS,
      IdToken: 600,
      Interaction: 600,
      // The API hides every record whose first-party session has ended, so these are
      // ceilings, and the session's own lifetime is what actually bounds them.
      Grant: 1_209_600,
      Session: 1_209_600,
    },
    cookies: {
      keys: input.cookieKeys,
      names: PROVIDER_COOKIE_NAMES,
      long: { httpOnly: true, sameSite: 'lax', secure: true, path: '/' },
      short: { httpOnly: true, sameSite: 'lax', secure: true, path: '/' },
    },
    interactions: {
      policy: buildInteractionPolicy(input.client),
      url: (_ctx, interaction) => `/interaction/${interaction.uid}`,
    },
    clientBasedCORS: (ctx, origin, client) => {
      if (origin === 'null') {
        return false;
      }
      if (ctx.oidc.route === 'userinfo' || client.clientAuthMethod === 'none') {
        return (client.redirectUris ?? []).some((uri) => URL.parse(uri)?.origin === origin);
      }
      return false;
    },
    features: {
      devInteractions: { enabled: false },
      registration: { enabled: false },
      // The API sends the logout tokens (see leaveBackchannelLogoutToApi).
      backchannelLogout: { enabled: true },
      externalSigningSupport: { enabled: true, ack: 'experimental-01' },
      resourceIndicators: {
        enabled: true,
        defaultResource: resourceIndicators.defaultResource,
        // An RP that named one resource at authorization gets a token for it without repeating
        // it at the token endpoint, which many RP libraries never do.
        useGrantedResource: () => true,
        getResourceServerInfo: resourceIndicators.getResourceServerInfo,
      },
      clientCredentials: { enabled: true },
      rpInitiatedLogout: { enabled: true, ...createLogoutPages(input.renderPage) },
      introspection: { enabled: true, allowedPolicy: createIntrospectionPolicy(input.client) },
      revocation: { enabled: true },
      // First-party clients only: the API lists the grant for no other (ADR D10).
      deviceFlow: { enabled: true, ...createDevicePages(input.renderPage, input.client) },
    },
  };
}
