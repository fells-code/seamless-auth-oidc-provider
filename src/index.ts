/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

export { ApiClientAdapter, ApiPayloadAdapter, createApiAdapterFactory } from './adapter.js';
export { ReplayDetectedError, UnsupportedModelError } from './adapter.js';
export type { OidcApiClientOptions } from './apiClient.js';
export { OidcApiClient, SERVICE_TOKEN_SUBJECT } from './apiClient.js';
export type { OidcEdge, OidcEdgeOptions } from './createOidcEdge.js';
export { ADAPTER_COOKIE_NAMES, createOidcEdge } from './createOidcEdge.js';
export type { Env } from './env.js';
export { EnvSchema, parseEnv } from './env.js';
export {
  OidcApiError,
  OidcContractMismatchError,
  OidcProviderDisabledError,
  OidcSignRefusedError,
} from './errors.js';
export { buildProviderConfiguration, PROVIDER_COOKIE_NAMES } from './providerConfig.js';
export type { EdgeRequestContext } from './requestContext.js';
export { currentRequestContext, runWithRequestContext } from './requestContext.js';
export {
  ApiSigningKey,
  classifyToken,
  signingKeysFrom,
  UnsignableTokenError,
} from './signingKey.js';
export { checkApiCompatibility } from './startup.js';
