/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import {
  isReservedClaimName,
  type OidcAuthContext,
  type OidcClientMetadata,
  type OidcClientResource,
  type OidcPayloadUpsertRequest,
} from '@seamless-auth/types';
import type { z } from 'zod';

import type { OidcProviderAccountSchema } from '../src/accountClaims.js';
import { PERMISSION_CLAIMS } from '../src/accountClaims.js';
import { json, type RecordedRequest } from './fakeApi.js';

const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

interface StoredRecord {
  model: string;
  id: string;
  payload: Record<string, unknown>;
  sessionId: string | null;
  expiresAt: number;
  consumedAt: string | null;
}

export interface FakeAccount {
  claims: z.input<typeof OidcProviderAccountSchema>;
  sessionId: string;
  context?: Partial<OidcAuthContext>;
}

/**
 * The API's provider store, client registry and grant-bound lookups, in memory. It applies
 * the same binding the API does: accounts, auth context and user token signing answer only
 * for a session bound to the asking client with the user's access token, that also holds a
 * grant for it, and only a bound session can be revoked.
 */
/** The fake first-party access token is unsigned: the fake API only reads its claims. */
function decodeAccessToken(token: string): Record<string, unknown> | undefined {
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
    );
    return payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

const PROTOCOL_CLAIMS = new Set([
  'iss',
  'sub',
  'aud',
  'exp',
  'iat',
  'nbf',
  'jti',
  'auth_time',
  'acr',
  'amr',
  'sid',
  'azp',
  'nonce',
  'at_hash',
  'c_hash',
  's_hash',
  'client_id',
  'scope',
  'cnf',
]);

const ACCOUNT_CLAIMS = new Set<string>([
  'email',
  'email_verified',
  'phone_number',
  'phone_number_verified',
  'roles',
  'org_id',
  ...PERMISSION_CLAIMS,
]);

export function createFakeStore() {
  const records = new Map<string, StoredRecord>();
  const clients = new Map<string, OidcClientMetadata>();
  const accounts = new Map<string, FakeAccount & { addedAt: number }>();

  /**
   * As `/oidc/sign` checks account claims (seamless-auth-oidc-provider#47): every one must have
   * the account's own value, a custom name the account does not have is refused, and the
   * permission and custom claim sets are carried whole or not at all.
   */
  function accountClaimRefusal(
    kind: string,
    sessionId: string | undefined,
    claims: Record<string, unknown>,
  ): string | undefined {
    const released = Object.keys(claims).filter((claim) => !PROTOCOL_CLAIMS.has(claim));
    if (released.length === 0) {
      return undefined;
    }
    const account = [...accounts.values()].find((a) => a.sessionId === sessionId);
    if (kind === 'client_credentials' || !account) {
      return 'malformed_signing_input';
    }
    const { customClaims: stored = {}, ...standard } = account.claims;
    // The API never resolves a reserved name into custom claims.
    const customClaims = Object.fromEntries(
      Object.entries(stored).filter(([name]) => !isReservedClaimName(name)),
    );
    const expected: Record<string, unknown> = { ...customClaims, ...standard };
    if (released.some((claim) => !(claim in expected) && !ACCOUNT_CLAIMS.has(claim))) {
      return 'malformed_signing_input';
    }
    if (
      released.some((claim) => JSON.stringify(claims[claim]) !== JSON.stringify(expected[claim]))
    ) {
      return 'subject_mismatch';
    }
    for (const set of [
      PERMISSION_CLAIMS.filter((claim) => claim in standard),
      Object.keys(customClaims),
    ]) {
      const carried = set.filter((claim) => claim in claims).length;
      if (carried > 0 && carried < set.length) {
        return 'subject_mismatch';
      }
    }
    return undefined;
  }
  const secrets = new Map<string, string>();
  const resources = new Map<string, OidcClientResource[]>();
  const revokedSessions: { sessionId: string; reason: string }[] = [];
  const events: Record<string, unknown>[] = [];
  const verified: { clientId: string; secret: string }[] = [];
  const signed: { kind: string; clientId: string; sessionId?: string; grantType?: string }[] = [];
  const bindings = new Set<string>();

  const key = (model: string, id: string) => `${model}/${id}`;
  const live = (record: StoredRecord | undefined) =>
    record && record.expiresAt > Date.now() ? record : undefined;
  const view = (record: StoredRecord | undefined) => {
    const found = live(record);
    return found
      ? json(200, {
          payload: found.payload,
          sessionId: found.sessionId,
          expiresAt: new Date(found.expiresAt).toISOString(),
          consumedAt: found.consumedAt,
        })
      : json(404, { error: 'Not Found' });
  };
  const findBy = (model: string, field: string, value: string) =>
    [...records.values()].find(
      (record) => record.model === model && record.payload[field] === value,
    );

  function isBound(sessionId: string) {
    return [...bindings].some((binding) => binding.startsWith(`${sessionId}:`));
  }

  function hasGrant(sessionId: string, clientId: string) {
    return (
      bindings.has(`${sessionId}:${clientId}`) &&
      [...records.values()].some(
        (record) =>
          live(record) &&
          record.model === 'Grant' &&
          record.sessionId === sessionId &&
          record.payload.clientId === clientId,
      )
    );
  }

  function contextFor(sessionId: string): OidcAuthContext | undefined {
    const account = [...accounts.values()].find((a) => a.sessionId === sessionId);
    if (!account) {
      return undefined;
    }
    return {
      sessionId,
      userId: account.claims.sub,
      active: true,
      recovery: false,
      authMethods: [
        {
          method: 'passkey',
          at: new Date(account.addedAt * 1000).toISOString(),
          deviceBound: true,
          userVerified: true,
        },
      ],
      authTime: account.addedAt,
      acr: 'phrh',
      amr: ['hwk', 'user', 'mfa'],
      ...account.context,
    };
  }

  function handle({ method, path, search, body }: RecordedRequest): Response | undefined {
    const params = new URLSearchParams(search);
    let match = /^\/oidc\/payloads\/(\w+)\/by-uid\/(.+)$/.exec(path);
    if (match && method === 'GET') {
      return view(findBy(match[1]!, 'uid', decodeURIComponent(match[2]!)));
    }
    match = /^\/oidc\/payloads\/(\w+)\/by-user-code\/(.+)$/.exec(path);
    if (match && method === 'GET') {
      return view(findBy(match[1]!, 'userCode', decodeURIComponent(match[2]!)));
    }
    match = /^\/oidc\/payloads\/(\w+)\/by-grant\/(.+)$/.exec(path);
    if (match && method === 'DELETE') {
      for (const [id, record] of records) {
        if (record.model === match[1] && record.payload.grantId === decodeURIComponent(match[2]!)) {
          records.delete(id);
        }
      }
      return json(204);
    }
    match = /^\/oidc\/payloads\/(\w+)\/([^/]+)\/consume$/.exec(path);
    if (match && method === 'POST') {
      const record = records.get(key(match[1]!, decodeURIComponent(match[2]!)));
      const consumed = Boolean(record && !record.consumedAt);
      if (record && consumed) {
        record.consumedAt = new Date().toISOString();
      }
      return json(200, { consumed });
    }
    match = /^\/oidc\/payloads\/(\w+)\/([^/]+)$/.exec(path);
    if (match) {
      const [model, id] = [match[1]!, decodeURIComponent(match[2]!)];
      if (method === 'PUT') {
        const upsert = body as OidcPayloadUpsertRequest;
        const existing = live(records.get(key(model, id)));
        if (model === 'ReplayDetection' && existing) {
          return json(200, { created: false });
        }
        records.set(key(model, id), {
          model,
          id,
          payload: upsert.payload,
          sessionId: upsert.sessionId ?? null,
          expiresAt: Date.now() + upsert.expiresIn * 1000,
          consumedAt: null,
        });
        return json(200, { created: true });
      }
      if (method === 'GET') {
        return view(records.get(key(model, id)));
      }
      if (method === 'DELETE') {
        records.delete(key(model, id));
        return json(204);
      }
    }
    match = /^\/oidc\/clients\/([^/]+)$/.exec(path);
    if (match && method === 'GET') {
      const found = clients.get(decodeURIComponent(match[1]!));
      return found ? json(200, found) : json(404, { error: 'Not Found' });
    }
    match = /^\/oidc\/clients\/([^/]+)\/resources$/.exec(path);
    if (match && method === 'GET') {
      const clientId = decodeURIComponent(match[1]!);
      return clients.has(clientId)
        ? json(200, { resources: resources.get(clientId) ?? [] })
        : json(404, { error: 'Not Found' });
    }
    match = /^\/oidc\/clients\/([^/]+)\/verify-secret$/.exec(path);
    if (match && method === 'POST') {
      const clientId = decodeURIComponent(match[1]!);
      const { secret } = body as { secret: string };
      verified.push({ clientId, secret });
      return json(200, { valid: secrets.get(clientId) === secret });
    }
    match = /^\/oidc\/accounts\/([^/]+)$/.exec(path);
    if (match && method === 'GET') {
      const account = accounts.get(decodeURIComponent(match[1]!));
      const sessionId = params.get('sessionId') ?? '';
      const clientId = params.get('clientId') ?? '';
      return account && account.sessionId === sessionId && hasGrant(sessionId, clientId)
        ? json(200, account.claims)
        : json(404, { error: 'Not Found' });
    }
    match = /^\/oidc\/sessions\/([^/]+)\/auth-context$/.exec(path);
    if (match && method === 'GET') {
      const sessionId = decodeURIComponent(match[1]!);
      const context = contextFor(sessionId);
      if (!context || !hasGrant(sessionId, params.get('clientId') ?? '')) {
        return json(404, { error: 'Not Found' });
      }
      return json(200, context);
    }
    match = /^\/oidc\/sessions\/([^/]+)\/bind$/.exec(path);
    if (match && method === 'POST') {
      const sessionId = decodeURIComponent(match[1]!);
      const { clientId, accessToken } = body as { clientId: string; accessToken: string };
      const claims = decodeAccessToken(accessToken);
      const account = [...accounts.values()].find((a) => a.sessionId === sessionId);
      if (
        !claims ||
        claims.typ !== 'access' ||
        claims.sid !== sessionId ||
        !account ||
        claims.sub !== account.claims.sub
      ) {
        return json(403, { error: 'invalid_access_token' });
      }
      if (claims.recovery === true) {
        return json(403, { error: 'enrollment_required' });
      }
      if (!clients.has(clientId)) {
        return json(404, { error: 'Not Found' });
      }
      bindings.add(`${sessionId}:${clientId}`);
      return json(204);
    }
    match = /^\/oidc\/sessions\/([^/]+)\/revoke$/.exec(path);
    if (match && method === 'POST') {
      if (!isBound(decodeURIComponent(match[1]!))) {
        return json(404, { error: 'Not Found' });
      }
      revokedSessions.push({
        sessionId: decodeURIComponent(match[1]!),
        reason: (body as { reason: string }).reason,
      });
      return json(204);
    }
    if (path === '/oidc/events' && method === 'POST') {
      events.push(body as Record<string, unknown>);
      return json(202, { message: 'Accepted' });
    }
    if (path === '/oidc/sign' && method === 'POST') {
      const request = body as {
        kind: string;
        clientId: string;
        sessionId?: string;
        grantType?: string;
        signingInput: string;
      };
      if (
        request.kind !== 'client_credentials' &&
        !hasGrant(request.sessionId ?? '', request.clientId)
      ) {
        return json(403, { error: 'grant_not_allowed' });
      }
      // As the API checks them: a client credentials or device-flow token (ADR 0001 D10) states
      // no assurance at all, and any other token only the session's own.
      const claims = decodeAccessToken(request.signingInput) ?? {};
      const stated = ['acr', 'amr', 'auth_time'].filter((claim) => claim in claims);
      if (request.kind === 'client_credentials' || request.grantType === DEVICE_CODE_GRANT) {
        if (stated.length > 0) {
          return json(403, { error: 'auth_context_mismatch' });
        }
      } else {
        const context = contextFor(request.sessionId ?? '');
        const amr = Array.isArray(claims.amr) ? [...(claims.amr as string[])].sort() : claims.amr;
        if (
          !context ||
          (claims.acr !== undefined && claims.acr !== context.acr) ||
          (claims.amr !== undefined &&
            JSON.stringify(amr) !== JSON.stringify([...context.amr].sort())) ||
          (claims.auth_time !== undefined && claims.auth_time !== context.authTime)
        ) {
          return json(403, { error: 'auth_context_mismatch' });
        }
      }
      const refusal = accountClaimRefusal(request.kind, request.sessionId, claims);
      if (refusal) {
        return json(403, { error: refusal });
      }
      signed.push({
        kind: request.kind,
        clientId: request.clientId,
        sessionId: request.sessionId,
        ...(request.grantType ? { grantType: request.grantType } : {}),
      });
      return undefined;
    }
    return undefined;
  }

  return {
    handle,
    records,
    signed,
    bindings,
    revokedSessions,
    events,
    /** What the API does when a first-party session ends: its provider records go with it. */
    endSession(sessionId: string) {
      for (const [id, record] of records) {
        if (record.sessionId === sessionId) records.delete(id);
      }
      for (const binding of bindings) {
        if (binding.startsWith(`${sessionId}:`)) bindings.delete(binding);
      }
    },
    addClient(metadata: OidcClientMetadata) {
      clients.set(metadata.client_id, metadata);
    },
    verified,
    setSecret(clientId: string, secret: string) {
      secrets.set(clientId, secret);
    },
    setResources(clientId: string, list: OidcClientResource[]) {
      resources.set(clientId, list);
    },
    addAccount(account: FakeAccount) {
      // A fixed sign-in time, as a real session's is, so /oidc/sign can compare auth_time.
      accounts.set(account.claims.sub, { ...account, addedAt: Math.floor(Date.now() / 1000) - 5 });
    },
  };
}
