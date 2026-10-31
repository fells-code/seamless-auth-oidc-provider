/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import type { OidcAcrValue } from '@seamless-auth/types';

export const ACR_VALUES = ['phr', 'phrh'] as const satisfies readonly OidcAcrValue[];

const ACR_RANK: Record<OidcAcrValue, number> = { phr: 1, phrh: 2 };

function isAcrValue(value: unknown): value is OidcAcrValue {
  return typeof value === 'string' && value in ACR_RANK;
}

/** What an authorization request asks of the authentication behind it (ADR D3, D9). */
export interface AuthRequirements {
  /** The weakest acr the request accepts. phrh satisfies a request for phr. */
  acr?: OidcAcrValue;
  maxAge?: number;
  /** `prompt=login`: only an authentication during this interaction counts. */
  reauthenticate?: boolean;
}

/** The acr and auth_time the API reported for the session. Never computed here. */
export interface AuthState {
  acr: OidcAcrValue | null | undefined;
  authTime: number;
}

/**
 * Reads `acr_values`, `max_age` and `prompt=login`. The claims parameter is not enabled, so
 * `acr_values` is the only way to ask for an acr. Unknown values are ignored.
 */
export function authRequirements(params: Record<string, unknown>): AuthRequirements {
  const requested = typeof params.acr_values === 'string' ? params.acr_values.split(' ') : [];
  const acr = requested
    .filter(isAcrValue)
    .sort((a, b) => ACR_RANK[a] - ACR_RANK[b])
    .at(0);

  const rawMaxAge = params.max_age;
  const maxAge = typeof rawMaxAge === 'string' ? Number(rawMaxAge) : rawMaxAge;
  const prompts = typeof params.prompt === 'string' ? params.prompt.split(' ') : [];

  return {
    ...(acr ? { acr } : {}),
    ...(typeof maxAge === 'number' && Number.isInteger(maxAge) && maxAge >= 0 ? { maxAge } : {}),
    ...(prompts.includes('login') ? { reauthenticate: true } : {}),
  };
}

export function hasRequirements(requirements: AuthRequirements): boolean {
  return (
    requirements.acr !== undefined ||
    requirements.maxAge !== undefined ||
    requirements.reauthenticate === true
  );
}

export function meetsAcr(actual: unknown, required: OidcAcrValue): boolean {
  return isAcrValue(actual) && ACR_RANK[actual] >= ACR_RANK[required];
}

export interface UnmetRequirements {
  acr: boolean;
  freshness: boolean;
}

/**
 * `interactionStartedAt` is when the hosted pages began this interaction. An authentication
 * since then satisfies any `max_age`, including 0, as the library's own check allows.
 */
export function unmetRequirements(
  requirements: AuthRequirements,
  state: AuthState,
  interactionStartedAt?: number,
  now = Math.floor(Date.now() / 1000),
): UnmetRequirements | undefined {
  const freshSinceStart =
    interactionStartedAt !== undefined && state.authTime >= interactionStartedAt;
  const acr = requirements.acr !== undefined && !meetsAcr(state.acr, requirements.acr);
  const stale =
    (requirements.reauthenticate === true && !freshSinceStart) ||
    (requirements.maxAge !== undefined &&
      now - state.authTime > requirements.maxAge &&
      !freshSinceStart);
  return acr || stale ? { acr, freshness: stale } : undefined;
}

export type StepUpMethod = 'passkey' | 'totp';

/**
 * The API moves auth_time only for a step-up that alone earns the session's acr, and TOTP
 * never earns one. So TOTP helps only with freshness on a session that has no acr.
 */
export function stepUpMethods(unmet: UnmetRequirements, state: AuthState): StepUpMethod[] {
  return unmet.acr || state.acr ? ['passkey'] : ['passkey', 'totp'];
}
