/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createSeamlessAuthServer } from '@seamless-auth/express';
import type { OidcEdgeConfigResponse } from '@seamless-auth/types';
import express, { type Router } from 'express';
import Provider from 'oidc-provider';

import { OidcApiClient } from './apiClient.js';
import { verifyClientSecrets } from './clientSecrets.js';
import { EdgeConfigCache } from './configCache.js';
import { deviceFlowMiddleware } from './deviceFlow.js';
import { createHostedPageRenderer, createHostedPagesRouter } from './hostedPages.js';
import { createInteractionRouter } from './interactions.js';
import { acceptJwtAccessTokens, createJwtAccessTokenLookup } from './jwtAccessTokens.js';
import { endFirstPartySessionOnLogout, leaveBackchannelLogoutToApi } from './logout.js';
import { createSameOriginGuard } from './originGuard.js';
import { buildProviderConfiguration, PROVIDER_COOKIE_NAMES } from './providerConfig.js';
import { createRateLimiter } from './rateLimit.js';
import { revokeSessionOnRefreshReuse } from './refreshReuse.js';
import { runWithRequestContext } from './requestContext.js';
import { hostOnlyResumeCookie } from './resumeCookie.js';
import { signingKeysFrom } from './signingKey.js';
import { checkApiCompatibility } from './startup.js';
import { auditRevocations } from './tokenAudit.js';

export const ADAPTER_COOKIE_NAMES = {
  access: '__Host-seamless-access',
  registration: '__Host-seamless-ephemeral',
  refresh: '__Host-seamless-refresh',
  preAuth: '__Host-seamless-pre-auth',
} as const;

export interface OidcEdgeOptions {
  /** The private Seamless Auth API, as this service reaches it. */
  apiUrl: string;
  /** The API's `ISSUER`, when it differs from `apiUrl`. */
  apiIssuer?: string;
  /**
   * This service's own service token secret (`SEAMLESS_OIDC_SERVICE_TOKEN` on the API), used
   * for `/oidc/*` and for the adapter's first-party calls. Never the adapters' secret.
   */
  serviceSecret: string;
  serviceTokenKid?: string;
  /** Signs the provider's cookies. The first key signs, the rest still verify. */
  cookieKeys: string[];
  /** Signs the first-party session cookies the hosted UI uses. */
  adapterCookieSecret: string;
  /**
   * Set when TLS ends at a proxy in front of this service. The host Express app needs
   * `trust proxy` set to match.
   */
  trustProxy?: boolean;
  /** `false` keeps the adapter on its bundled route manifest. */
  fetchAdapterManifest?: boolean;
  /** The built hosted pages. Defaults to the copy this package ships in `dist/ui`. */
  uiDir?: string;
  fetch?: typeof fetch;
}

export interface OidcEdge {
  /** Mount at the root of the app that serves the issuer's origin. */
  router: Router;
  provider: Provider;
  issuer: string;
  config: OidcEdgeConfigResponse;
  client: OidcApiClient;
}

export async function createOidcEdge(options: OidcEdgeOptions): Promise<OidcEdge> {
  const client = new OidcApiClient({
    apiUrl: options.apiUrl,
    serviceSecret: options.serviceSecret,
    ...(options.serviceTokenKid ? { serviceTokenKid: options.serviceTokenKid } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  const config = await checkApiCompatibility(client);
  const configCache = new EdgeConfigCache(client, config);
  const signingKeys = signingKeysFrom(await client.jwks(), client);
  const hostedPages = {
    uiDir: options.uiDir ?? fileURLToPath(new URL('./ui/', import.meta.url)),
    configCache,
  };
  const renderPage = createHostedPageRenderer(hostedPages);

  const provider = new Provider(
    config.issuer,
    buildProviderConfiguration({
      client,
      config,
      configCache,
      signingKeys,
      cookieKeys: options.cookieKeys,
      renderPage,
    }),
  );
  leaveBackchannelLogoutToApi(provider);
  provider.proxy = options.trustProxy === true;
  provider.use(hostOnlyResumeCookie(PROVIDER_COOKIE_NAMES.resume, '/authorize'));
  provider.use(verifyClientSecrets(client));
  provider.use(revokeSessionOnRefreshReuse(client));
  provider.use(auditRevocations(client));
  provider.use(endFirstPartySessionOnLogout(client, Object.values(ADAPTER_COOKIE_NAMES)));
  provider.use(
    acceptJwtAccessTokens(createJwtAccessTokenLookup(signingKeys, config.issuer), [
      '/token/introspection',
      '/token/revocation',
    ]),
  );
  // The library answers a bare server_error and logs nothing, so this is the only trace.
  provider.on('server_error', (_ctx, error: Error) => {
    console.error(`[oidc-provider] ${error.name}: ${error.message}`);
  });

  const issuerUrl = new URL(config.issuer);
  const issuerBase = issuerUrl.pathname.replace(/\/$/, '');
  provider.use(deviceFlowMiddleware(`${issuerBase}/token`));
  const router = express.Router();

  // The library builds endpoint URLs from the request's scheme and host, so a request for
  // any other origin could put a foreign one into discovery or a redirect. Behind a TLS
  // proxy the host app must set Express's `trust proxy` for the scheme to read as https.
  const issuerScheme = issuerUrl.protocol.slice(0, -1);
  router.use((req, res, next) => {
    if (req.host !== issuerUrl.host || req.protocol !== issuerScheme) {
      res.status(421).json({ error: 'misdirected_request' });
      return;
    }
    next();
  });

  router.use((req, _res, next) => {
    const userAgent = req.get('user-agent');
    runWithRequestContext(
      {
        correlationId: randomUUID(),
        ...(req.ip ? { clientIp: req.ip } : {}),
        ...(userAgent ? { userAgent } : {}),
      },
      next,
    );
  });

  const sameOrigin = createSameOriginGuard(issuerUrl.origin);

  router.use(
    '/auth',
    sameOrigin,
    createSeamlessAuthServer({
      authServerUrl: options.apiUrl,
      audience: options.apiIssuer ?? options.apiUrl,
      ...(options.apiIssuer ? { authServerIssuer: options.apiIssuer } : {}),
      cookieSecret: options.adapterCookieSecret,
      serviceSecret: options.serviceSecret,
      ...(options.serviceTokenKid ? { jwksKid: options.serviceTokenKid } : {}),
      cookieSecure: true,
      cookieSameSite: 'lax',
      allowedOrigins: [issuerUrl.origin],
      accessCookieName: ADAPTER_COOKIE_NAMES.access,
      registrationCookieName: ADAPTER_COOKIE_NAMES.registration,
      refreshCookieName: ADAPTER_COOKIE_NAMES.refresh,
      preAuthCookieName: ADAPTER_COOKIE_NAMES.preAuth,
      ...(options.fetchAdapterManifest === false ? { fetchManifest: false } : {}),
    }),
  );

  router.use(
    createInteractionRouter({
      provider,
      client,
      issuerOrigin: issuerUrl.origin,
      adapterCookieSecret: options.adapterCookieSecret,
      accessCookieName: ADAPTER_COOKIE_NAMES.access,
    }),
  );

  router.use(createHostedPagesRouter(hostedPages, renderPage));

  const tokenStatusLimiter = createRateLimiter({ limit: 1200, windowMs: 60_000 });
  router.use(
    [`${issuerBase}/token/introspection`, `${issuerBase}/token/revocation`],
    tokenStatusLimiter,
  );

  // User code entry (RFC 8628 section 5.1). Per IP for a guesser at one address, and across
  // all of them for one spread over many, per instance.
  const userCodeLimiters = [
    createRateLimiter({ limit: 10, windowMs: 60_000 }),
    createRateLimiter({ limit: 600, windowMs: 60_000, key: () => 'all' }),
  ];
  router.post(`${issuerBase}/device`, ...userCodeLimiters);

  router.use(issuerUrl.pathname, provider.callback());

  return { router, provider, issuer: config.issuer, config, client };
}
