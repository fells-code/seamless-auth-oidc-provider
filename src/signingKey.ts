/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import { createPublicKey, type JsonWebKey, type KeyObject } from 'node:crypto';

import type { OidcJwksResponse, OidcPublicJwk, OidcSignKind } from '@seamless-auth/types';
import { ExternalSigningKey } from 'oidc-provider';

import type { OidcApiClient } from './apiClient.js';
import { DEVICE_CODE_GRANT } from './deviceFlow.js';
import { currentRequestContext } from './requestContext.js';

export class UnsignableTokenError extends Error {
  constructor(reason: string) {
    super(`This service does not sign this token: ${reason}`);
    this.name = 'UnsignableTokenError';
  }
}

type JsonObject = Record<string, unknown>;

function decodePart(part: string | undefined): JsonObject {
  if (!part) {
    throw new UnsignableTokenError('malformed signing input');
  }
  const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new UnsignableTokenError('malformed signing input');
  }
  return value as JsonObject;
}

function stringClaim(payload: JsonObject, name: string): string | undefined {
  const value = payload[name];
  return typeof value === 'string' && value ? value : undefined;
}

interface Classified {
  kind: OidcSignKind;
  clientId: string;
}

export function classifyToken(
  header: JsonObject,
  payload: JsonObject,
  sessionId: string | undefined,
): Classified {
  const typ = header.typ;
  if (typ === 'logout+jwt') {
    throw new UnsignableTokenError('the API sends back-channel logout tokens itself');
  }
  if (typ === 'at+jwt') {
    const clientId = stringClaim(payload, 'client_id');
    if (!clientId) {
      throw new UnsignableTokenError('access token without client_id');
    }
    const kind =
      !sessionId && stringClaim(payload, 'sub') === clientId
        ? 'client_credentials'
        : 'access_token';
    return { kind, clientId };
  }
  if (typ === undefined) {
    const aud = payload.aud;
    const firstAud = Array.isArray(aud) ? aud[0] : aud;
    const clientId =
      stringClaim(payload, 'azp') ?? (typeof firstAud === 'string' ? firstAud : undefined);
    if (!clientId) {
      throw new UnsignableTokenError('ID token without an audience');
    }
    return { kind: 'id_token', clientId };
  }
  throw new UnsignableTokenError(`unexpected typ ${String(typ)}`);
}

/**
 * A provider key whose private half stays in the API. `sign` sends the JWS signing
 * input to `POST /oidc/sign`, which checks the claims before it signs.
 */
export class ApiSigningKey extends ExternalSigningKey {
  readonly #kid: string;
  readonly #alg: string;
  readonly #keyObject: KeyObject;
  readonly #client: OidcApiClient;
  readonly #active: boolean;

  constructor(jwk: OidcPublicJwk, client: OidcApiClient, active: boolean) {
    super();
    this.#kid = jwk.kid;
    this.#alg = jwk.alg;
    this.#keyObject = createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' });
    this.#client = client;
    this.#active = active;
  }

  override get kid(): string {
    return this.#kid;
  }

  override get alg(): string {
    return this.#alg;
  }

  get active(): boolean {
    return this.#active;
  }

  override keyObject(): KeyObject {
    return this.#keyObject;
  }

  override async sign(data: Uint8Array): Promise<Uint8Array> {
    if (!this.#active) {
      throw new UnsignableTokenError(`key ${this.#kid} is published but not active`);
    }
    const signingInput = Buffer.from(data).toString('utf8');
    const [headerPart, payloadPart, extra] = signingInput.split('.');
    if (extra !== undefined) {
      throw new UnsignableTokenError('malformed signing input');
    }
    const header = decodePart(headerPart);
    if (header.alg !== this.#alg) {
      throw new UnsignableTokenError(`alg ${String(header.alg)} does not match key ${this.#kid}`);
    }
    const sessionId = currentRequestContext()?.sessionId;
    const { kind, clientId } = classifyToken(header, decodePart(payloadPart), sessionId);
    const context = currentRequestContext();
    const { signature } = await this.#client.sign({
      kind,
      kid: this.#kid,
      clientId,
      signingInput,
      ...(sessionId ? { sessionId } : {}),
      ...(kind === 'client_credentials'
        ? {}
        : { grantType: context?.deviceFlow ? DEVICE_CODE_GRANT : 'authorization_code' }),
    });
    return Buffer.from(signature, 'base64url');
  }
}

/** The active key comes first, which is the one the library selects to sign with. */
export function signingKeysFrom(jwks: OidcJwksResponse, client: OidcApiClient): ApiSigningKey[] {
  const active = jwks.keys.find((key) => key.kid === jwks.activeKid);
  if (!active) {
    throw new Error(`The API's active provider key ${jwks.activeKid} is not in its JWKS`);
  }
  return [
    new ApiSigningKey(active, client, true),
    ...jwks.keys
      .filter((key) => key.kid !== jwks.activeKid)
      .map((key) => new ApiSigningKey(key, client, false)),
  ];
}
