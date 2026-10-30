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
}

const storage = new AsyncLocalStorage<EdgeRequestContext>();

export function runWithRequestContext<T>(context: EdgeRequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentRequestContext(): EdgeRequestContext | undefined {
  return storage.getStore();
}
