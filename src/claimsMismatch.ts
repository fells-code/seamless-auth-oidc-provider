/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import { errors, type KoaContextWithOIDC, Provider } from 'oidc-provider';

import { accountClaimsOf, providerAccountOf, withAccount } from './accountClaims.js';
import type { OidcApiClient } from './apiClient.js';
import { CLAIMS_MISMATCH, OidcSignRefusedError } from './errors.js';
import { currentRequestContext } from './requestContext.js';

function isClaimsMismatch(error: unknown) {
  return error instanceof OidcSignRefusedError && error.code === CLAIMS_MISMATCH;
}

/** RFC 6749 section 5.2, with the 500 the library answers `server_error` with. */
export function claimsChangedError() {
  const error = new errors.OIDCProviderError(500, 'server_error');
  error.expose = true;
  error.error_description = 'the account changed while the token was being issued, try again';
  return error;
}

/**
 * Reads the account again for the session and client the request serves, and puts the new
 * claims on the account the library loaded. Returns the claims it replaced, or undefined when
 * the API no longer describes the account.
 */
async function rereadAccount(client: OidcApiClient, ctx: KoaContextWithOIDC | undefined) {
  const account = ctx?.oidc?.account;
  const previous = providerAccountOf(account);
  const clientId = ctx?.oidc?.client?.clientId;
  const sessionId = currentRequestContext()?.sessionId;
  if (!account || !previous || !clientId || !sessionId) {
    return undefined;
  }
  const fresh = await client.account(account.accountId, { clientId, sessionId });
  if (!fresh || fresh.sub !== previous.sub) {
    return undefined;
  }
  withAccount(account, fresh);
  return { previous, fresh };
}

interface IssuableIdToken {
  ctx?: KoaContextWithOIDC;
  available: Record<string | symbol, unknown>;
}

/**
 * A role or membership can change between the account read that built a token and the API's
 * sign, and the API then refuses with `claims_mismatch`. The token is built again from a fresh
 * read and signed once more. A second mismatch fails the request as `server_error`; every other
 * refusal is left as it was.
 *
 * ID tokens (and signed userinfo) copy the account's claims when they are created, so those
 * are swapped in place. An access token reads them again on `save` through `extraTokenClaims`,
 * and the record a failed `save` stored under its jti is overwritten by the retry.
 */
export function retryOnClaimsMismatch(provider: Provider, client: OidcApiClient) {
  async function retrying<T>(
    ctx: KoaContextWithOIDC | undefined,
    attempt: () => Promise<T>,
    rebuild: (reread: NonNullable<Awaited<ReturnType<typeof rereadAccount>>>) => void,
  ): Promise<T> {
    try {
      return await attempt();
    } catch (error) {
      if (!isClaimsMismatch(error)) {
        throw error;
      }
      const reread = await rereadAccount(client, ctx);
      if (!reread) {
        throw claimsChangedError();
      }
      rebuild(reread);
      try {
        return await attempt();
      } catch (retryError) {
        throw isClaimsMismatch(retryError) ? claimsChangedError() : retryError;
      }
    }
  }

  const idToken = provider.IdToken.prototype as unknown as {
    issue(this: IssuableIdToken, ...args: unknown[]): Promise<string>;
  };
  const issue = idToken.issue;
  idToken.issue = function (this: IssuableIdToken, ...args: unknown[]) {
    return retrying(
      this.ctx ?? Provider.ctx,
      () => issue.apply(this, args),
      ({ previous, fresh }) => {
        for (const key of Reflect.ownKeys(accountClaimsOf(previous))) {
          if (key !== 'sub') {
            delete this.available[key];
          }
        }
        Object.assign(this.available, accountClaimsOf(fresh));
      },
    );
  };

  const accessToken = provider.AccessToken.prototype as unknown as {
    save(...args: unknown[]): Promise<string | undefined>;
  };
  const save = accessToken.save;
  accessToken.save = function (this: unknown, ...args: unknown[]) {
    return retrying(
      Provider.ctx,
      () => save.apply(this, args),
      () => undefined,
    );
  };
}
