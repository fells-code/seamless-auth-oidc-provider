/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import { isReservedClaimName, OidcAccountClaimsSchema } from '@seamless-auth/types';
import type { Account, Provider } from 'oidc-provider';
import { z } from 'zod';

/**
 * What `/oidc/accounts/:id` returns since seamless-auth-oidc-provider#47: the ADR 0004
 * permission claims under their token names, and the merged custom claims, all computed by the
 * API for this session and client and already held to the shared budget. The shared schema does
 * not have these yet.
 */
export const OidcProviderAccountSchema = OidcAccountClaimsSchema.extend({
  permissions: z.array(z.string()).optional(),
  permissions_omitted: z.literal(true).optional(),
  org_roles: z.array(z.string()).optional(),
  org_permissions: z.array(z.string()).optional(),
  customClaims: z.record(z.string(), z.unknown()).default({}),
});

export type OidcProviderAccount = z.infer<typeof OidcProviderAccountSchema>;

/** Roles, permissions and the active organization's roles, as a first-party token has them. */
export const PERMISSIONS_SCOPE = 'permissions';
/** Every custom claim the API resolved for the user and this client. */
export const CUSTOM_CLAIMS_SCOPE = 'custom_claims';

/** `/oidc/sign` signs these together or not at all, since a partial list looks complete. */
export const PERMISSION_CLAIMS = [
  'permissions',
  'permissions_omitted',
  'org_roles',
  'org_permissions',
] as const;

export const PERMISSIONS_SCOPE_CLAIMS = ['roles', 'org_id', ...PERMISSION_CLAIMS];

// A symbol, so the library's own copies of the claims carry it while no claim filter can
// release it under a name.
const CUSTOM_CLAIMS = Symbol('seamless.customClaims');
const ACCOUNT_PROPERTY = 'seamlessAccount';

/** Reserved names are dropped here too, whatever the API sent, so none can replace a claim. */
export function customClaimsOf(account: OidcProviderAccount): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(account.customClaims).filter(([name]) => !isReservedClaimName(name)),
  );
}

function standardClaimsOf(account: OidcProviderAccount): Record<string, unknown> {
  const { org_id, ...rest } = account;
  delete (rest as Partial<OidcProviderAccount>).customClaims;
  return { ...rest, ...(org_id ? { org_id } : {}) };
}

/** The claims the library filters by scope, with the custom claims kept aside for after it. */
export function accountClaimsOf(account: OidcProviderAccount) {
  return {
    ...standardClaimsOf(account),
    sub: account.sub,
    [CUSTOM_CLAIMS]: customClaimsOf(account),
  };
}

export function withAccount(account: Account, claims: OidcProviderAccount): Account {
  return Object.assign(account, { [ACCOUNT_PROPERTY]: claims });
}

export function providerAccountOf(account: unknown): OidcProviderAccount | undefined {
  const value = (account as Record<string, unknown> | undefined)?.[ACCOUNT_PROPERTY];
  return value ? (value as OidcProviderAccount) : undefined;
}

function scopesOf(scope: unknown): Set<string> {
  return new Set(typeof scope === 'string' ? scope.split(' ') : []);
}

/** The authorization claims a scope set releases, by the names `/oidc/sign` expects. */
export function authorizationClaimsFor(
  account: OidcProviderAccount,
  scope: unknown,
): Record<string, unknown> {
  const scopes = scopesOf(scope);
  const standard = standardClaimsOf(account);
  return {
    ...(scopes.has(CUSTOM_CLAIMS_SCOPE) ? customClaimsOf(account) : {}),
    ...(scopes.has(PERMISSIONS_SCOPE)
      ? Object.fromEntries(
          PERMISSIONS_SCOPE_CLAIMS.filter((name) => name in standard).map((name) => [
            name,
            standard[name],
          ]),
        )
      : {}),
  };
}

interface ClaimsMask {
  available: Record<string | symbol, unknown>;
  result(): Promise<Record<string, unknown>>;
  scope(value?: string): unknown;
}

const maskScopes = new WeakMap<object, string>();

/**
 * The library releases only claims named in its static `claims` map, and custom claim names are
 * the adopter's. ID tokens and userinfo both build their payload through `provider.Claims`, so
 * this adds the account's custom claims there when `custom_claims` was granted, under every
 * claim the library already chose. It also keeps the permission claims whole: a `claims`
 * request or a rejection that asks for part of them gets none, rather than a token the API
 * refuses to sign.
 */
export function releaseAuthorizationClaims(provider: Provider) {
  const prototype = provider.Claims.prototype as unknown as ClaimsMask;
  const scope = prototype.scope;
  const result = prototype.result;
  prototype.scope = function (this: ClaimsMask, value?: string) {
    maskScopes.set(this, value ?? '');
    return scope.call(this, value);
  };
  prototype.result = async function (this: ClaimsMask) {
    const claims = await result.call(this);
    const present = PERMISSION_CLAIMS.filter((name) => name in this.available);
    if (present.some((name) => !(name in claims))) {
      for (const name of present) {
        delete claims[name];
      }
    }
    const custom = this.available[CUSTOM_CLAIMS] as Record<string, unknown> | undefined;
    if (!custom || !scopesOf(maskScopes.get(this)).has(CUSTOM_CLAIMS_SCOPE)) {
      return claims;
    }
    return { ...custom, ...claims };
  };
}
