/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import { createPublicKey, type JsonWebKeyInput, type KeyObject } from 'node:crypto';

import type { OidcJwksResponse, OidcPublicJwk, OidcSignKind } from '@seamless-auth/types';
import { errors, ExternalSigningKey } from 'oidc-provider';

import type { OidcApiClient } from './apiClient.js';
import { DEVICE_CODE_GRANT } from './deviceFlow.js';
import { OidcSignRefusedError } from './errors.js';
import { currentRequestContext } from './requestContext.js';

// @types/node 26 dropped the global JsonWebKey.
type PublicJwk = JsonWebKeyInput['key'] & { kid?: string; use?: string; alg?: string };

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
  readonly #onUnknownKey: (() => Promise<void>) | undefined;

  constructor(
    jwk: OidcPublicJwk,
    client: OidcApiClient,
    active: boolean,
    onUnknownKey?: () => Promise<void>,
  ) {
    super();
    this.#kid = jwk.kid;
    this.#alg = jwk.alg;
    this.#keyObject = createPublicKey({ key: jwk as JsonWebKeyInput['key'], format: 'jwk' });
    this.#client = client;
    this.#active = active;
    this.#onUnknownKey = onUnknownKey;
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

  /** Public members only, whatever else the API's JWK carried. */
  get publicJwk(): PublicJwk {
    const { kty, ...rest } = this.#keyObject.export({ format: 'jwk' });
    return { kty, use: 'sig', kid: this.#kid, alg: this.#alg, ...rest };
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
    // The library reads the kid before it signs, and the keys can reload in between.
    if (header.kid !== undefined && header.kid !== this.#kid) {
      throw new UnsignableTokenError(`kid ${String(header.kid)} does not match key ${this.#kid}`);
    }
    const sessionId = currentRequestContext()?.sessionId;
    const { kind, clientId } = classifyToken(header, decodePart(payloadPart), sessionId);
    const context = currentRequestContext();
    const { signature } = await this.#signOrRefuse({
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

  // A session that ended while the request ran (a concurrent refresh found reuse, say) is
  // a grant that is no longer valid, which the client should hear as such, not a 500.
  async #signOrRefuse(body: Parameters<OidcApiClient['sign']>[0]) {
    try {
      return await this.#client.sign(body);
    } catch (error) {
      if (error instanceof OidcSignRefusedError && error.code === 'session_revoked') {
        throw new errors.InvalidGrant('the session behind this grant has ended');
      }
      // The API rotated its key. This request fails, and the next one signs with the new key.
      if (error instanceof OidcSignRefusedError && error.code === 'unknown_key') {
        await this.#onUnknownKey?.().catch(() => undefined);
      }
      throw error;
    }
  }
}

/** The active key comes first, which is the one the library selects to sign with. */
export function signingKeysFrom(
  jwks: OidcJwksResponse,
  client: OidcApiClient,
  onUnknownKey?: () => Promise<void>,
): ApiSigningKey[] {
  const active = jwks.keys.find((key) => key.kid === jwks.activeKid);
  if (!active) {
    throw new Error(`The API's active provider key ${jwks.activeKid} is not in its JWKS`);
  }
  return [
    new ApiSigningKey(active, client, true, onUnknownKey),
    ...jwks.keys
      .filter((key) => key.kid !== jwks.activeKid)
      .map((key) => new ApiSigningKey(key, client, false, onUnknownKey)),
  ];
}

/** Re-read the API's keys this often, so a rotation is picked up before anything is refused. */
export const SIGNING_KEY_REFRESH_MS = 5 * 60_000;

/**
 * The API's provider keys, reloaded on a timer and whenever the API refuses a key as unknown.
 * The library reads its keystore once, at construction, so it is handed fixed slots that
 * follow the current keys: the first is always the active key.
 */
export class SigningKeyRing {
  readonly #client: OidcApiClient;
  readonly #alg: string;
  readonly #slots: SigningKeySlot[];
  #keys: ApiSigningKey[];
  #reloading: Promise<void> | undefined;

  constructor(jwks: OidcJwksResponse, client: OidcApiClient) {
    this.#client = client;
    this.#keys = signingKeysFrom(jwks, client, () => this.reload());
    this.#alg = this.#keys[0]!.alg;
    this.#slots = this.#keys.map((_, index) => new SigningKeySlot(this, index));
  }

  /** Every key the API publishes, the active one first. */
  get keys(): readonly ApiSigningKey[] {
    return this.#keys;
  }

  /** For the library's `jwks` configuration. */
  get providerKeys(): ExternalSigningKey[] {
    return this.#slots;
  }

  /** The current keys, active first, for the edge's `/jwks`. */
  get publicJwks(): PublicJwk[] {
    return this.#keys.map((key) => key.publicJwk);
  }

  /** One reload at a time. A failed one keeps the keys already loaded. */
  reload(): Promise<void> {
    this.#reloading ??= this.#load().finally(() => {
      this.#reloading = undefined;
    });
    return this.#reloading;
  }

  async #load(): Promise<void> {
    const jwks = await this.#client.jwks();
    const keys = signingKeysFrom(jwks, this.#client, () => this.reload());
    // The library's signing algorithms are fixed when it starts.
    if (keys[0]!.alg !== this.#alg) {
      throw new Error(
        `The API's active provider key now uses ${keys[0]!.alg}, not ${this.#alg}; restart this service`,
      );
    }
    this.#keys = keys;
  }

  /** Reloads every `intervalMs` until the returned function is called. Never holds the process. */
  startRefresh(intervalMs = SIGNING_KEY_REFRESH_MS): () => void {
    const timer = setInterval(() => {
      this.reload().catch((error: unknown) => {
        console.error(`[oidc-provider] could not reload the signing keys: ${String(error)}`);
      });
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }
}

/** One of the library's keys, standing for whichever of the ring's keys is in its place. */
class SigningKeySlot extends ExternalSigningKey {
  readonly #ring: SigningKeyRing;
  readonly #index: number;

  constructor(ring: SigningKeyRing, index: number) {
    super();
    this.#ring = ring;
    this.#index = index;
  }

  // A slot past the ring's current keys repeats the active key, which only ever signs first.
  #key(): ApiSigningKey {
    const keys = this.#ring.keys;
    return keys[this.#index] ?? keys[0]!;
  }

  override get kid(): string {
    return this.#key().kid;
  }

  override get alg(): string {
    return this.#key().alg;
  }

  override keyObject(): KeyObject {
    return this.#key().keyObject();
  }

  override sign(data: Uint8Array): Promise<Uint8Array> {
    return this.#key().sign(data);
  }
}
