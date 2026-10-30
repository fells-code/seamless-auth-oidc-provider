/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import { randomUUID } from 'node:crypto';

import { createSeamlessAuthServer } from '@seamless-auth/express';
import type { OidcEdgeConfigResponse } from '@seamless-auth/types';
import express, { type Router } from 'express';
import Provider from 'oidc-provider';

import { OidcApiClient } from './apiClient.js';
import { buildProviderConfiguration } from './providerConfig.js';
import { runWithRequestContext } from './requestContext.js';
import { signingKeysFrom } from './signingKey.js';
import { checkApiCompatibility } from './startup.js';

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
  /** The shared service token secret (`SEAMLESS_SERVICE_TOKEN` on the API). */
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
  const signingKeys = signingKeysFrom(await client.jwks(), client);

  const provider = new Provider(
    config.issuer,
    buildProviderConfiguration({ client, config, signingKeys, cookieKeys: options.cookieKeys }),
  );
  provider.proxy = options.trustProxy === true;

  const issuerUrl = new URL(config.issuer);
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

  router.use(
    '/auth',
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

  router.use(issuerUrl.pathname, provider.callback());

  return { router, provider, issuer: config.issuer, config, client };
}
