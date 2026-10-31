/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

export interface InteractionDetails {
  uid: string;
  prompt: {
    name: 'login' | 'consent' | string;
    reasons: string[];
    missingScopes: string[];
    missingClaims: string[];
  };
  client: {
    id: string;
    name: string;
    firstParty: boolean;
    redirectHost: string | null;
  };
  scopes: string[];
  loginHint: string | null;
}

export type InteractionStep = 'login' | 'consent' | 'abort';

export type StepUpMethod = 'passkey' | 'totp';

export type ApiResult<T> =
  { ok: true; data: T } | { ok: false; status: number; error: string; methods?: StepUpMethod[] };

function stepUpMethods(body: object): StepUpMethod[] | undefined {
  if (!('methods' in body) || !Array.isArray(body.methods)) {
    return undefined;
  }
  return body.methods.filter(
    (method): method is StepUpMethod => method === 'passkey' || method === 'totp',
  );
}

async function call<T>(
  path: string,
  method: 'GET' | 'POST',
  payload?: unknown,
): Promise<ApiResult<T>> {
  try {
    const response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (response.ok) {
      return { ok: true, data: body as T };
    }
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const error = typeof body.error === 'string' ? body.error : 'server_error';
      const methods = stepUpMethods(body);
      return { ok: false, status: response.status, error, ...(methods ? { methods } : {}) };
    }
    return { ok: false, status: response.status, error: 'server_error' };
  } catch {
    return { ok: false, status: 0, error: 'network_error' };
  }
}

const base = (uid: string) => `/interaction/${encodeURIComponent(uid)}`;

export function getDetails(uid: string) {
  return call<InteractionDetails>(`${base(uid)}/details`, 'GET');
}

export function finish(uid: string, step: InteractionStep, afterStepUp = false) {
  return call<{ redirectTo: string }>(
    `${base(uid)}/${step}`,
    'POST',
    afterStepUp ? { afterStepUp: true } : undefined,
  );
}

/** Only ever follow a redirect back into this service. The provider takes it from there. */
export function sameOriginUrl(url: string): string | null {
  try {
    const target = new URL(url, window.location.origin);
    return target.origin === window.location.origin ? target.href : null;
  } catch {
    return null;
  }
}

const PENDING_KEY = 'seamless.interaction';

export interface PendingInteraction {
  uid: string;
  clientName: string;
}

/**
 * The sign-in screens navigate away from the interaction URL, so the page remembers which
 * interaction to finish once they are done.
 */
export function rememberInteraction(pending: PendingInteraction): void {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  } catch {
    // Without storage the user lands on "signed in" and returns to the app themselves.
  }
}

export function pendingInteraction(): PendingInteraction | null {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? 'null');
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'uid' in parsed &&
      typeof parsed.uid === 'string' &&
      'clientName' in parsed &&
      typeof parsed.clientName === 'string'
    ) {
      return { uid: parsed.uid, clientName: parsed.clientName };
    }
  } catch {
    // Treated as nothing pending.
  }
  return null;
}

export function forgetInteraction(): void {
  try {
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // Nothing to forget.
  }
}
