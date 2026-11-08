/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import { SESSION_EXCHANGE_SCOPE } from '@seamless-auth/types';
import type { KoaContextWithOIDC } from 'oidc-provider';
import { describe, expect, it } from 'vitest';

import { accessTokenAuthorization, accessTokenClaims } from '../src/accessTokenClaims.js';
import {
  authorizationClaimsFor,
  type OidcProviderAccount,
  OidcProviderAccountSchema,
  providerAccountOf,
  withAccount,
} from '../src/accountClaims.js';

const account: OidcProviderAccount = OidcProviderAccountSchema.parse({
  sub: 'u1',
  roles: ['user'],
  org_id: null,
  permissions: ['orders:read'],
  customClaims: { tier: 'gold', sub: 'other', seamless_admin: true },
});

function contextWith(entities: Record<string, unknown>, loaded: OidcProviderAccount | undefined) {
  return {
    oidc: {
      entities,
      account: loaded
        ? withAccount({ accountId: 'u1', claims: () => ({ sub: 'u1' }) }, loaded)
        : undefined,
    },
  } as unknown as KoaContextWithOIDC;
}

describe('authorizationClaimsFor', () => {
  it('releases by scope, drops an empty org and reserved custom names', () => {
    expect(authorizationClaimsFor(account, 'permissions custom_claims')).toEqual({
      roles: ['user'],
      permissions: ['orders:read'],
      tier: 'gold',
    });
    expect(authorizationClaimsFor(account, undefined)).toEqual({});
  });

  it('defaults custom claims to none when an older API sends none', () => {
    const older = OidcProviderAccountSchema.parse({ sub: 'u1', roles: [], org_id: null });
    expect(older.customClaims).toEqual({});
    expect(providerAccountOf(undefined)).toBeUndefined();
  });
});

describe('accessTokenAuthorization', () => {
  const resourceToken = { kind: 'AccessToken', resourceServer: {}, scope: 'orders:read' };

  it('reads the grant from the code, refresh or device code it redeems', () => {
    for (const entity of ['AuthorizationCode', 'RefreshToken', 'DeviceCode']) {
      const ctx = contextWith({ [entity]: { scope: 'openid custom_claims' } }, account);
      expect(accessTokenAuthorization(ctx, resourceToken)).toEqual({ tier: 'gold' });
    }
  });

  it('adds nothing to a session exchange token, an opaque token, or without an account', () => {
    const grant = { AuthorizationCode: { scope: 'openid permissions' } };
    expect(
      accessTokenAuthorization(contextWith(grant, account), {
        ...resourceToken,
        scope: SESSION_EXCHANGE_SCOPE,
      }),
    ).toBeUndefined();
    expect(
      accessTokenAuthorization(contextWith(grant, account), { kind: 'AccessToken' }),
    ).toBeUndefined();
    expect(accessTokenAuthorization(contextWith(grant, undefined), resourceToken)).toBeUndefined();
    expect(accessTokenAuthorization(contextWith({}, account), resourceToken)).toBeUndefined();
    expect(accessTokenAuthorization(undefined, resourceToken)).toBeUndefined();
    expect(accessTokenClaims(undefined, resourceToken)).toBeUndefined();
  });
});
