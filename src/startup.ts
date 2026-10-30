/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import { OIDC_EDGE_CONTRACT_VERSION, type OidcEdgeConfigResponse } from '@seamless-auth/types';

import type { OidcApiClient } from './apiClient.js';
import { OidcContractMismatchError, OidcProviderDisabledError } from './errors.js';

/** Refuses to start against an API with the provider off or on another contract version. */
export async function checkApiCompatibility(
  client: OidcApiClient,
): Promise<OidcEdgeConfigResponse> {
  const config = await client.config();
  if (!config) {
    throw new OidcProviderDisabledError();
  }
  if (config.contractVersion !== OIDC_EDGE_CONTRACT_VERSION) {
    throw new OidcContractMismatchError(config.contractVersion, OIDC_EDGE_CONTRACT_VERSION);
  }
  return config;
}
