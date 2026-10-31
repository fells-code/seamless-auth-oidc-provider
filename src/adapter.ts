/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import {
  type OidcPayloadModel,
  OidcPayloadModelSchema,
  type OidcPayloadRecord,
} from '@seamless-auth/types';
import type { Adapter, AdapterFactory, AdapterPayload } from 'oidc-provider';

import type { OidcApiClient } from './apiClient.js';
import type { EdgeConfigCache } from './configCache.js';
import { adoptSession, currentRequestContext } from './requestContext.js';

export class ReplayDetectedError extends Error {
  constructor() {
    super('A replay detection record already exists for this assertion');
    this.name = 'ReplayDetectedError';
  }
}

export class UnsupportedModelError extends Error {
  constructor(name: string, operation: string) {
    super(`${operation} is not supported for oidc-provider model ${name}`);
    this.name = 'UnsupportedModelError';
  }
}

// The browser's provider session and the grant can outlive the first-party session they were
// made under, so they only fill an empty context. Every other record is the thing the request
// is acting on.
const CONTEXTUAL_MODELS = new Set<OidcPayloadModel>(['Session', 'Grant']);

function toAdapterPayload(
  model: OidcPayloadModel,
  record: OidcPayloadRecord | undefined,
): AdapterPayload | undefined {
  if (!record) {
    return undefined;
  }
  adoptSession(record.sessionId, !CONTEXTUAL_MODELS.has(model));
  const payload = { ...record.payload } as AdapterPayload;
  if (record.consumedAt) {
    payload.consumed = Math.floor(Date.parse(record.consumedAt) / 1000);
  }
  return payload;
}

/** Stores one library model through the API's `/oidc/payloads/*` routes. */
export class ApiPayloadAdapter implements Adapter {
  readonly #name: string;
  readonly #model: OidcPayloadModel | undefined;
  readonly #client: OidcApiClient;

  constructor(name: string, client: OidcApiClient) {
    this.#name = name;
    this.#client = client;
    const parsed = OidcPayloadModelSchema.safeParse(name);
    this.#model = parsed.success ? parsed.data : undefined;
  }

  #requireModel(operation: string): OidcPayloadModel {
    if (!this.#model) {
      throw new UnsupportedModelError(this.#name, operation);
    }
    return this.#model;
  }

  async upsert(id: string, payload: AdapterPayload, expiresIn?: number): Promise<void> {
    const model = this.#requireModel('upsert');
    if (!expiresIn || expiresIn <= 0) {
      throw new UnsupportedModelError(this.#name, 'upsert without an expiry');
    }
    const sessionId = currentRequestContext()?.sessionId;
    const { created } = await this.#client.upsertPayload(model, id, {
      payload: { ...payload },
      expiresIn: Math.ceil(expiresIn),
      ...(sessionId ? { sessionId } : {}),
    });
    // The library checks for an existing record before it saves one, so this only
    // fires when two requests race. Failing the request is the closed outcome.
    if (model === 'ReplayDetection' && !created) {
      throw new ReplayDetectedError();
    }
  }

  async find(id: string): Promise<AdapterPayload | undefined> {
    const model = this.#requireModel('find');
    return toAdapterPayload(model, await this.#client.findPayload(model, id));
  }

  async findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
    const model = this.#requireModel('findByUserCode');
    return toAdapterPayload(model, await this.#client.findPayloadByUserCode(model, userCode));
  }

  async findByUid(uid: string): Promise<AdapterPayload | undefined> {
    const model = this.#requireModel('findByUid');
    return toAdapterPayload(model, await this.#client.findPayloadByUid(model, uid));
  }

  async consume(id: string): Promise<void> {
    await this.#client.consumePayload(this.#requireModel('consume'), id);
  }

  async destroy(id: string): Promise<void> {
    await this.#client.destroyPayload(this.#requireModel('destroy'), id);
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    await this.#client.revokePayloadsByGrant(this.#requireModel('revokeByGrantId'), grantId);
  }
}

/**
 * Reads clients from the API's registry. Clients are managed there, never here. A third-party
 * client does not exist while `third_party_clients_enabled` is off (ADR D10).
 */
export class ApiClientAdapter implements Adapter {
  readonly #client: OidcApiClient;
  readonly #config: EdgeConfigCache;

  constructor(client: OidcApiClient, config: EdgeConfigCache) {
    this.#client = client;
    this.#config = config;
  }

  async find(id: string): Promise<AdapterPayload | undefined> {
    const metadata = await this.#client.client(id);
    if (!metadata) {
      return undefined;
    }
    if (!metadata['urn:seamless:first_party']) {
      const { thirdPartyClientsEnabled } = await this.#config.get();
      if (!thirdPartyClientsEnabled) {
        return undefined;
      }
    }
    return { ...metadata } as AdapterPayload;
  }

  async upsert(): Promise<void> {
    throw new UnsupportedModelError('Client', 'upsert');
  }

  async findByUserCode(): Promise<undefined> {
    throw new UnsupportedModelError('Client', 'findByUserCode');
  }

  async findByUid(): Promise<undefined> {
    throw new UnsupportedModelError('Client', 'findByUid');
  }

  async consume(): Promise<void> {
    throw new UnsupportedModelError('Client', 'consume');
  }

  async destroy(): Promise<void> {
    throw new UnsupportedModelError('Client', 'destroy');
  }

  async revokeByGrantId(): Promise<void> {
    throw new UnsupportedModelError('Client', 'revokeByGrantId');
  }
}

export function createApiAdapterFactory(
  client: OidcApiClient,
  config: EdgeConfigCache,
): AdapterFactory {
  return (name) =>
    name === 'Client' ? new ApiClientAdapter(client, config) : new ApiPayloadAdapter(name, client);
}
