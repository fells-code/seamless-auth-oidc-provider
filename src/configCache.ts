/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import type { OidcEdgeConfigResponse } from '@seamless-auth/types';

import type { OidcApiClient } from './apiClient.js';
import { OidcProviderDisabledError } from './errors.js';

const DEFAULT_TTL_MS = 30_000;

/**
 * The API's `/oidc/config`, re-read at most every `ttlMs`, so an admin turning a flag off
 * (third-party clients, or the provider itself) takes effect without restarting this service.
 */
export class EdgeConfigCache {
  readonly #client: OidcApiClient;
  readonly #ttlMs: number;
  readonly #now: () => number;
  #value: OidcEdgeConfigResponse;
  #fetchedAt: number;
  #pending: Promise<OidcEdgeConfigResponse> | undefined;

  constructor(
    client: OidcApiClient,
    initial: OidcEdgeConfigResponse,
    { ttlMs = DEFAULT_TTL_MS, now = Date.now }: { ttlMs?: number; now?: () => number } = {},
  ) {
    this.#client = client;
    this.#ttlMs = ttlMs;
    this.#now = now;
    this.#value = initial;
    this.#fetchedAt = now();
  }

  async get(): Promise<OidcEdgeConfigResponse> {
    if (this.#now() - this.#fetchedAt < this.#ttlMs) {
      return this.#value;
    }
    this.#pending ??= this.#refresh().finally(() => {
      this.#pending = undefined;
    });
    return this.#pending;
  }

  async #refresh(): Promise<OidcEdgeConfigResponse> {
    const config = await this.#client.config();
    if (!config) {
      throw new OidcProviderDisabledError();
    }
    this.#value = config;
    this.#fetchedAt = this.#now();
    return config;
  }
}
