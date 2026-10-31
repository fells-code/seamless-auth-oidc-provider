/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import type {
  OidcAccountClaims,
  OidcAuthContext,
  OidcClientMetadata,
  OidcPayloadUpsertRequest,
} from '@seamless-auth/types';

import { json, type RecordedRequest } from './fakeApi.js';

interface StoredRecord {
  model: string;
  id: string;
  payload: Record<string, unknown>;
  sessionId: string | null;
  expiresAt: number;
  consumedAt: string | null;
}

export interface FakeAccount {
  claims: OidcAccountClaims;
  sessionId: string;
  context?: Partial<OidcAuthContext>;
}

/**
 * The API's provider store, client registry and grant-bound lookups, in memory. It applies
 * the same binding the API does: accounts and auth context answer only for a session that
 * holds a grant for the asking client.
 */
export function createFakeStore() {
  const records = new Map<string, StoredRecord>();
  const clients = new Map<string, OidcClientMetadata>();
  const accounts = new Map<string, FakeAccount>();
  const signed: { kind: string; clientId: string; sessionId?: string }[] = [];

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

  function hasGrant(sessionId: string, clientId: string) {
    return [...records.values()].some(
      (record) =>
        live(record) &&
        record.model === 'Grant' &&
        record.sessionId === sessionId &&
        record.payload.clientId === clientId,
    );
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
      if (record) {
        record.consumedAt ??= new Date().toISOString();
      }
      return json(204);
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
      const account = [...accounts.values()].find((a) => a.sessionId === sessionId);
      if (!account || !hasGrant(sessionId, params.get('clientId') ?? '')) {
        return json(404, { error: 'Not Found' });
      }
      const context: OidcAuthContext = {
        sessionId,
        userId: account.claims.sub,
        active: true,
        recovery: false,
        authMethods: [
          {
            method: 'passkey',
            at: new Date().toISOString(),
            deviceBound: true,
            userVerified: true,
          },
        ],
        authTime: Math.floor(Date.now() / 1000) - 5,
        acr: 'phrh',
        amr: ['hwk', 'user', 'mfa'],
        ...account.context,
      };
      return json(200, context);
    }
    if (path === '/oidc/sign' && method === 'POST') {
      const request = body as { kind: string; clientId: string; sessionId?: string };
      signed.push({ kind: request.kind, clientId: request.clientId, sessionId: request.sessionId });
      return undefined;
    }
    return undefined;
  }

  return {
    handle,
    records,
    signed,
    addClient(metadata: OidcClientMetadata) {
      clients.set(metadata.client_id, metadata);
    },
    addAccount(account: FakeAccount) {
      accounts.set(account.claims.sub, account);
    },
  };
}
