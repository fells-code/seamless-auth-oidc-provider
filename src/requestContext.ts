/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface EdgeRequestContext {
  correlationId: string;
  clientIp?: string;
  userAgent?: string;
  /** The first-party `sessions` row the request acts for, once a sign-in has linked one. */
  sessionId?: string;
  /** Set when a verified first-party session named `sessionId`, so stored records cannot. */
  sessionBound?: boolean;
  /** The one-time stand-in for a client secret the API verified on this request. */
  verifiedClientSecret?: { clientId: string; value: string };
  /** The `jti` of a JWT access token this request presented and the edge verified. */
  verifiedJwtTokenId?: string;
  /** Set once the request loads a record from a device approval (ADR D10). */
  deviceFlow?: boolean;
  /** A POST to the token endpoint, where loading a device code is a poll. */
  tokenRequest?: boolean;
  devicePolled?: boolean;
}

const storage = new AsyncLocalStorage<EdgeRequestContext>();

export function runWithRequestContext<T>(context: EdgeRequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentRequestContext(): EdgeRequestContext | undefined {
  return storage.getStore();
}

/** Pins the request to a first-party session the edge verified itself. */
export function bindSession(sessionId: string): void {
  const context = storage.getStore();
  if (!context) {
    throw new Error('bindSession called outside a request context');
  }
  context.sessionId = sessionId;
  context.sessionBound = true;
}

export function markDeviceFlow(): void {
  const context = storage.getStore();
  if (context) {
    context.deviceFlow = true;
  }
}

/**
 * Takes the session a stored record was saved with. An `authoritative` record (the code,
 * token or interaction the request is acting on) replaces what an earlier lookup set, such as
 * the browser's provider session. Neither overrides a session bound with `bindSession`.
 */
export function adoptSession(sessionId: string | null, authoritative: boolean): void {
  const context = storage.getStore();
  if (!context || !sessionId || context.sessionBound) {
    return;
  }
  if (authoritative || !context.sessionId) {
    context.sessionId = sessionId;
  }
}
