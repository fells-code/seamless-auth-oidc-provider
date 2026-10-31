/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import { randomBytes } from 'node:crypto';

import {
  type OidcPayloadModel,
  OidcPayloadModelSchema,
  type OidcPayloadRecord,
} from '@seamless-auth/types';
import type { Adapter, AdapterFactory, AdapterPayload } from 'oidc-provider';
import { errors } from 'oidc-provider';

import type { OidcApiClient } from './apiClient.js';
import type { EdgeConfigCache } from './configCache.js';
import {
  checkDeviceRequest,
  DEVICE_CODE_GRANT,
  DevicePollThrottle,
  isDeviceGrant,
  withLoginPrompt,
} from './deviceFlow.js';
import { adoptSession, currentRequestContext, markDeviceFlow } from './requestContext.js';

/** A client assertion or proof presented twice. Answered as `invalid_client`, not a 500. */
export class ReplayDetectedError extends errors.InvalidClientAuth {
  constructor() {
    super('a replay detection record already exists for this assertion');
    this.name = 'ReplayDetectedError';
  }
}

const SHARED_SECRET_METHODS = new Set(['client_secret_basic', 'client_secret_post']);

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
  if (!CONTEXTUAL_MODELS.has(model) && isDeviceGrant(payload)) {
    markDeviceFlow();
  }
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
  readonly #polls: DevicePollThrottle;

  constructor(name: string, client: OidcApiClient, polls = new DevicePollThrottle()) {
    this.#name = name;
    this.#client = client;
    this.#polls = polls;
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
    const stored = { ...payload };
    if (model === 'DeviceCode') {
      const params = stored.params as Record<string, unknown> | undefined;
      checkDeviceRequest(params);
      // The verification page reads its authorization parameters from the stored code, so
      // this is where every approval is made to sign in again rather than ride a session
      // the browser already had: approving a device is the step phishing aims at.
      if (params && !stored.accountId) {
        stored.params = { ...params, prompt: withLoginPrompt(params.prompt) };
      }
      // ADR D10: never carried into the device's tokens, whatever the approver earned.
      delete stored.acr;
    }
    const { created } = await this.#client.upsertPayload(model, id, {
      payload: stored,
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
    const context = currentRequestContext();
    const record = await this.#client.findPayload(model, id);
    // The grant loads the code more than once per request, and only the first is the poll.
    // Only a code that exists is tracked, so made-up ones cannot fill the throttle.
    if (model === 'DeviceCode' && record && context?.tokenRequest && !context.devicePolled) {
      context.devicePolled = true;
      this.#polls.check(id);
    }
    const payload = toAdapterPayload(model, record);
    // The library loads only opaque records. A JWT access token the edge verified on this
    // request is read like one, so introspection and revocation can see it.
    if (
      payload?.format === 'jwt' &&
      (model === 'AccessToken' || model === 'ClientCredentials') &&
      currentRequestContext()?.verifiedJwtTokenId === id
    ) {
      delete payload.format;
    }
    if (model === 'RefreshToken' && payload && record?.sessionId) {
      await this.#adoptCurrentAuthContext(payload, record.sessionId);
    }
    return payload;
  }

  /**
   * A refresh carries the acr, amr and auth_time of the session's current row, not the ones
   * the token was first issued with: a step-up since then moved them, and `/oidc/sign`
   * refuses any value that differs from the row.
   */
  async #adoptCurrentAuthContext(payload: AdapterPayload, sessionId: string): Promise<void> {
    const { clientId, accountId } = payload;
    if (typeof clientId !== 'string') {
      return;
    }
    const context = await this.#client.authContext(sessionId, clientId);
    if (!context || !context.active || context.recovery || context.userId !== accountId) {
      return;
    }
    payload.authTime = context.authTime;
    if (context.acr && !isDeviceGrant(payload)) {
      payload.acr = context.acr;
    } else {
      delete payload.acr;
    }
    if (context.amr.length > 0) {
      payload.amr = [...context.amr];
    } else {
      delete payload.amr;
    }
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
 *
 * The registry never returns a secret. A client on a shared-secret method gets the one-time
 * value `verifyClientSecrets` set for a secret the API accepted on this request, and otherwise
 * a random value nothing can present, which the library needs to load the client at all.
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
    // ADR D10: the device grant is first-party only. The API filters it too.
    const grants = metadata['urn:seamless:first_party']
      ? metadata.grant_types
      : metadata.grant_types.filter((grant) => grant !== DEVICE_CODE_GRANT);
    if (!SHARED_SECRET_METHODS.has(metadata.token_endpoint_auth_method)) {
      return { ...metadata, grant_types: grants } as AdapterPayload;
    }
    const verified = currentRequestContext()?.verifiedClientSecret;
    const secret =
      verified?.clientId === metadata.client_id
        ? verified.value
        : randomBytes(32).toString('base64url');
    return { ...metadata, grant_types: grants, client_secret: secret } as AdapterPayload;
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
  const polls = new DevicePollThrottle();
  return (name) =>
    name === 'Client'
      ? new ApiClientAdapter(client, config)
      : new ApiPayloadAdapter(name, client, polls);
}
