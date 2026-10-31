/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import { authenticateCookie, verifyCookieJwt } from '@seamless-auth/core';

export interface FirstPartySession {
  userId: string;
  sessionId: string;
}

export interface FirstPartySessionRejection {
  status: number;
  error: string;
}

export type FirstPartySessionResult =
  | { session: FirstPartySession; rejection?: undefined }
  | { session?: undefined; rejection: FirstPartySessionRejection };

/**
 * Reads the first-party session the hosted pages signed in through this service's adapter.
 * A recovery session is refused here, as it is on every first-party route that is not
 * enrollment, so it can never finish a provider sign-in.
 */
export function readFirstPartySession(
  cookie: string | undefined,
  cookieSecret: string,
): FirstPartySessionResult {
  const { user, rejection } = authenticateCookie({ token: cookie, cookieSecret });
  if (rejection || !user || !cookie) {
    return {
      rejection: {
        status: rejection?.status ?? 401,
        error:
          rejection?.errorCode === 'enrollment_required' ? 'enrollment_required' : 'login_required',
      },
    };
  }
  const payload = verifyCookieJwt<{ sessionId?: unknown }>(cookie, cookieSecret);
  if (typeof payload?.sessionId !== 'string' || !payload.sessionId) {
    return { rejection: { status: 401, error: 'login_required' } };
  }
  return { session: { userId: user.id, sessionId: payload.sessionId } };
}
