/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import {
  createServiceToken,
  DEV_JWKS_KID,
  SERVICE_TOKEN_AUDIENCE,
  SERVICE_TOKEN_ISSUER,
} from '@seamless-auth/core';
import {
  type OidcAccountClaims,
  OidcAccountClaimsSchema,
  type OidcAccountQuery,
  type OidcAuthContext,
  OidcAuthContextSchema,
  type OidcClientMetadata,
  OidcClientMetadataSchema,
  type OidcClientResource,
  OidcClientResourcesResponseSchema,
  type OidcEdgeConfigResponse,
  OidcEdgeConfigResponseSchema,
  type OidcEdgeEvent,
  OidcEdgeRoutes,
  type OidcJwksResponse,
  OidcJwksResponseSchema,
  type OidcPayloadModel,
  type OidcPayloadRecord,
  OidcPayloadRecordSchema,
  type OidcPayloadUpsertRequest,
  type OidcPayloadUpsertResponse,
  OidcPayloadUpsertResponseSchema,
  type OidcSessionRevokeRequest,
  OidcSignRefusalSchema,
  type OidcSignRequest,
  type OidcSignResponse,
  OidcSignResponseSchema,
  OidcVerifySecretResponseSchema,
} from '@seamless-auth/types';
import type { z } from 'zod';

import { OidcApiError, OidcSignRefusedError } from './errors.js';
import { currentRequestContext } from './requestContext.js';

export const SERVICE_TOKEN_SUBJECT = 'seamless-oidc-provider';

// createServiceToken mints a 60 second token. Reusing it for less than that means a
// request never presents a token that expires in flight.
const SERVICE_TOKEN_REUSE_MS = 45_000;

export interface OidcApiClientOptions {
  apiUrl: string;
  serviceSecret: string;
  /** The `kid` header on the service token. Defaults to the API's development kid. */
  serviceTokenKid?: string;
  fetch?: typeof fetch;
}

type Method = 'GET' | 'PUT' | 'POST' | 'DELETE';

interface RequestOptions<S extends z.ZodType> {
  body?: unknown;
  schema?: S;
  allowNotFound?: boolean;
}

export function routePath(template: string, params: Record<string, string> = {}): string {
  return template.replace(/:([A-Za-z]+)/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`Missing path parameter ${name} for ${template}`);
    }
    return encodeURIComponent(value);
  });
}

export class OidcApiClient {
  readonly #apiUrl: string;
  readonly #serviceSecret: string;
  readonly #serviceTokenKid: string;
  readonly #fetch: typeof fetch;
  #token: { value: string; expiresAt: number } | undefined;

  constructor(options: OidcApiClientOptions) {
    this.#apiUrl = options.apiUrl.replace(/\/+$/, '');
    this.#serviceSecret = options.serviceSecret;
    this.#serviceTokenKid = options.serviceTokenKid ?? DEV_JWKS_KID;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  config(): Promise<OidcEdgeConfigResponse | undefined> {
    return this.#request('GET', OidcEdgeRoutes.config, {
      schema: OidcEdgeConfigResponseSchema,
      allowNotFound: true,
    });
  }

  async upsertPayload(
    model: OidcPayloadModel,
    id: string,
    body: OidcPayloadUpsertRequest,
  ): Promise<OidcPayloadUpsertResponse> {
    return this.#required(
      'PUT',
      routePath(OidcEdgeRoutes.payload, { model, id }),
      OidcPayloadUpsertResponseSchema,
      body,
    );
  }

  findPayload(model: OidcPayloadModel, id: string): Promise<OidcPayloadRecord | undefined> {
    return this.#request('GET', routePath(OidcEdgeRoutes.payload, { model, id }), {
      schema: OidcPayloadRecordSchema,
      allowNotFound: true,
    });
  }

  findPayloadByUserCode(
    model: OidcPayloadModel,
    userCode: string,
  ): Promise<OidcPayloadRecord | undefined> {
    return this.#request('GET', routePath(OidcEdgeRoutes.payloadByUserCode, { model, userCode }), {
      schema: OidcPayloadRecordSchema,
      allowNotFound: true,
    });
  }

  findPayloadByUid(model: OidcPayloadModel, uid: string): Promise<OidcPayloadRecord | undefined> {
    return this.#request('GET', routePath(OidcEdgeRoutes.payloadByUid, { model, uid }), {
      schema: OidcPayloadRecordSchema,
      allowNotFound: true,
    });
  }

  async consumePayload(model: OidcPayloadModel, id: string): Promise<void> {
    await this.#request('POST', routePath(OidcEdgeRoutes.payloadConsume, { model, id }), {
      allowNotFound: true,
    });
  }

  async destroyPayload(model: OidcPayloadModel, id: string): Promise<void> {
    await this.#request('DELETE', routePath(OidcEdgeRoutes.payload, { model, id }), {
      allowNotFound: true,
    });
  }

  async revokePayloadsByGrant(model: OidcPayloadModel, grantId: string): Promise<void> {
    await this.#request('DELETE', routePath(OidcEdgeRoutes.payloadsByGrant, { model, grantId }), {
      allowNotFound: true,
    });
  }

  async sign(body: OidcSignRequest): Promise<OidcSignResponse> {
    const response = await this.#send('POST', OidcEdgeRoutes.sign, body);
    const json = await readJson(response);
    if (!response.ok) {
      const refusal = OidcSignRefusalSchema.safeParse(json);
      if (refusal.success) {
        throw new OidcSignRefusedError(refusal.data.error, refusal.data.message);
      }
      throw new OidcApiError(response.status, OidcEdgeRoutes.sign);
    }
    const parsed = OidcSignResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw unexpectedShape(response.status, OidcEdgeRoutes.sign);
    }
    return parsed.data;
  }

  jwks(): Promise<OidcJwksResponse> {
    return this.#required('GET', OidcEdgeRoutes.jwks, OidcJwksResponseSchema);
  }

  client(id: string): Promise<OidcClientMetadata | undefined> {
    return this.#request('GET', routePath(OidcEdgeRoutes.client, { id }), {
      schema: OidcClientMetadataSchema,
      allowNotFound: true,
    });
  }

  /** An API from before this route, or a client that is not active, has none. */
  async clientResources(id: string): Promise<OidcClientResource[]> {
    const result = await this.#request('GET', routePath(OidcEdgeRoutes.clientResources, { id }), {
      schema: OidcClientResourcesResponseSchema,
      allowNotFound: true,
    });
    return result?.resources ?? [];
  }

  async verifySecret(id: string, secret: string): Promise<boolean> {
    const result = await this.#request(
      'POST',
      routePath(OidcEdgeRoutes.clientVerifySecret, { id }),
      { body: { secret }, schema: OidcVerifySecretResponseSchema, allowNotFound: true },
    );
    return result?.valid === true;
  }

  /** Answers only for the user behind a session holding a grant for `clientId`. */
  account(id: string, binding: OidcAccountQuery): Promise<OidcAccountClaims | undefined> {
    const query = new URLSearchParams(binding).toString();
    return this.#request('GET', `${routePath(OidcEdgeRoutes.account, { id })}?${query}`, {
      schema: OidcAccountClaimsSchema,
      allowNotFound: true,
    });
  }

  /** Answers only while the session holds a grant for `clientId`, so save the Grant first. */
  authContext(sessionId: string, clientId: string): Promise<OidcAuthContext | undefined> {
    const query = new URLSearchParams({ clientId }).toString();
    const path = routePath(OidcEdgeRoutes.sessionAuthContext, { id: sessionId });
    return this.#request('GET', `${path}?${query}`, {
      schema: OidcAuthContextSchema,
      allowNotFound: true,
    });
  }

  async revokeSession(sessionId: string, body: OidcSessionRevokeRequest): Promise<void> {
    await this.#request('POST', routePath(OidcEdgeRoutes.sessionRevoke, { id: sessionId }), {
      body,
      allowNotFound: true,
    });
  }

  async event(event: OidcEdgeEvent): Promise<void> {
    await this.#request('POST', OidcEdgeRoutes.events, { body: event });
  }

  async #required<S extends z.ZodType>(
    method: Method,
    path: string,
    schema: S,
    body?: unknown,
  ): Promise<z.infer<S>> {
    return this.#parse(await this.#send(method, path, body), path, schema);
  }

  async #request<S extends z.ZodType>(
    method: Method,
    path: string,
    options: RequestOptions<S>,
  ): Promise<z.infer<S> | undefined> {
    const response = await this.#send(method, path, options.body);
    if (response.status === 404 && options.allowNotFound) {
      return undefined;
    }
    if (!options.schema) {
      if (!response.ok) {
        throw new OidcApiError(response.status, path);
      }
      return undefined;
    }
    return this.#parse(response, path, options.schema);
  }

  async #parse<S extends z.ZodType>(response: Response, path: string, schema: S) {
    if (!response.ok) {
      throw new OidcApiError(response.status, path);
    }
    const parsed = schema.safeParse(await readJson(response));
    if (!parsed.success) {
      throw unexpectedShape(response.status, path);
    }
    return parsed.data as z.infer<S>;
  }

  #send(method: Method, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-seamless-service-token': this.#serviceToken(),
    };
    // The API rate limits per client IP, so a call made for a browser request carries
    // that browser's address and user agent rather than the edge's own.
    const context = currentRequestContext();
    if (context?.clientIp) {
      headers['x-seamless-client-ip'] = context.clientIp;
    }
    if (context?.userAgent) {
      headers['x-seamless-client-user-agent'] = context.userAgent;
    }
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    return this.#fetch(`${this.#apiUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
    });
  }

  #serviceToken(): string {
    const now = Date.now();
    if (this.#token && this.#token.expiresAt > now) {
      return this.#token.value;
    }
    const value = createServiceToken({
      subject: SERVICE_TOKEN_SUBJECT,
      issuer: SERVICE_TOKEN_ISSUER,
      audience: SERVICE_TOKEN_AUDIENCE,
      serviceSecret: this.#serviceSecret,
      keyId: this.#serviceTokenKid,
    });
    this.#token = { value, expiresAt: now + SERVICE_TOKEN_REUSE_MS };
    return value;
  }
}

function unexpectedShape(status: number, path: string) {
  return new OidcApiError(status, path, `Unexpected response shape from ${path}`);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
