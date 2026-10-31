/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import type { KoaContextWithOIDC } from 'oidc-provider';
import { errors } from 'oidc-provider';

import type { OidcApiClient } from './apiClient.js';
import type { HostedPageRenderer, RenderedPage } from './hostedPages.js';
import { currentRequestContext } from './requestContext.js';

export const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/** RFC 8628 section 3.5: a client that is told `slow_down` adds five seconds. */
export const DEVICE_POLL_INTERVAL_SECONDS = 5;

/** ADR D10: user codes live for at most ten minutes. */
export const DEVICE_CODE_TTL_SECONDS = 600;

/**
 * Eight characters of the RFC 8628 section 6.1 base-20 set (no vowels, so no words, and no
 * look-alikes), about 34.5 bits. With codes living ten minutes and entry rate limited,
 * guessing a live one is out of reach.
 */
export const USER_CODE_CHARSET = 'base-20' as const;
export const USER_CODE_MASK = '****-****';

/** Whether a stored token or code came from a device approval. */
export function isDeviceGrant(payload: { kind?: unknown; gty?: unknown }): boolean {
  return (
    payload.kind === 'DeviceCode' ||
    (typeof payload.gty === 'string' && payload.gty.split(' ').includes('device_code'))
  );
}

/**
 * ADR D10. The approving session's `acr` says how the approver signed in, not who holds the
 * device, and `acr_values` or `max_age` would be satisfied by an approval made somewhere
 * else, so the device flow takes neither.
 */
export function checkDeviceRequest(params: Record<string, unknown> | undefined) {
  if (params?.acr_values !== undefined || params?.max_age !== undefined) {
    throw new errors.InvalidRequest('acr_values and max_age are not supported by the device flow');
  }
}

export function withLoginPrompt(prompt: unknown): string {
  const prompts = new Set(typeof prompt === 'string' ? prompt.split(' ').filter(Boolean) : []);
  prompts.add('login');
  return [...prompts].join(' ');
}

/**
 * Per device code, per instance. The library has no polling interval of its own, so a
 * client polling sooner than `interval` is told `slow_down` and its interval grows.
 */
export class DevicePollThrottle {
  readonly #polls = new Map<string, { at: number; interval: number }>();
  readonly #now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  check(deviceCode: string): void {
    const now = this.#now();
    if (this.#polls.size > 10_000) {
      for (const [code, poll] of this.#polls) {
        if (now - poll.at > DEVICE_CODE_TTL_SECONDS * 1000) this.#polls.delete(code);
      }
    }
    const last = this.#polls.get(deviceCode);
    if (last && now - last.at < last.interval * 1000) {
      this.#polls.set(deviceCode, {
        at: now,
        interval: last.interval + DEVICE_POLL_INTERVAL_SECONDS,
      });
      throw new errors.SlowDown();
    }
    this.#polls.set(deviceCode, {
      at: now,
      interval: last?.interval ?? DEVICE_POLL_INTERVAL_SECONDS,
    });
  }
}

/** Marks token endpoint posts, and adds `interval` to the device authorization response. */
export function deviceFlowMiddleware(tokenPath: string) {
  return async (ctx: KoaContextWithOIDC, next: () => Promise<unknown>) => {
    const context = currentRequestContext();
    if (context && ctx.method === 'POST' && ctx.path === tokenPath) {
      context.tokenRequest = true;
    }
    await next();
    if (
      ctx.oidc?.route === 'device_authorization' &&
      ctx.status === 200 &&
      ctx.body &&
      typeof ctx.body === 'object'
    ) {
      (ctx.body as Record<string, unknown>).interval = DEVICE_POLL_INTERVAL_SECONDS;
    }
  };
}

function send(ctx: KoaContextWithOIDC, { html, headers }: RenderedPage) {
  ctx.set(headers);
  ctx.type = 'html';
  ctx.body = html;
}

function clientName(client: { clientId: string; clientName?: string | undefined } | undefined) {
  return client ? (client.clientName ?? client.clientId) : null;
}

const INPUT_ERRORS: Record<string, string> = {
  NotFoundError: 'not_found',
  ExpiredError: 'expired',
  AlreadyUsedError: 'already_used',
  AbortedError: 'aborted',
  NoCodeError: 'no_code',
};

/** The device verification pages (RFC 8628 section 3.3), rendered by the hosted UI. */
export function createDevicePages(render: HostedPageRenderer, client: OidcApiClient) {
  async function audit(
    type: 'device_code_approved' | 'device_code_denied',
    clientId: string | undefined,
  ) {
    const context = currentRequestContext();
    if (!context) return;
    try {
      await client.event({
        type,
        correlationId: context.correlationId,
        occurredAt: new Date().toISOString(),
        ...(clientId ? { clientId } : {}),
        ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      });
    } catch (error) {
      console.error(`[oidc-provider] could not record a device decision: ${String(error)}`);
    }
  }

  return {
    charset: USER_CODE_CHARSET,
    mask: USER_CODE_MASK,
    async userCodeInputSource(
      ctx: KoaContextWithOIDC,
      _form: string,
      out?: { error?: string },
      err?: Error & { userCode?: string },
    ) {
      if (err?.name === 'AbortedError') {
        await audit('device_code_denied', ctx.oidc.entities.DeviceCode?.clientId);
      }
      const error = err ? (INPUT_ERRORS[err.name] ?? out?.error ?? 'server_error') : null;
      send(
        ctx,
        await render({
          view: 'device_input',
          action: ctx.oidc.urlFor('code_verification'),
          xsrf: ctx.oidc.session?.state?.secret,
          userCode: err?.userCode ?? null,
          error,
        }),
      );
    },
    async userCodeConfirmSource(
      ctx: KoaContextWithOIDC,
      _form: string,
      found: { clientId: string; clientName?: string | undefined },
      _deviceInfo: unknown,
      userCode: string,
    ) {
      const scope = ctx.oidc.entities.DeviceCode?.params?.scope;
      send(
        ctx,
        await render({
          view: 'device_confirm',
          action: ctx.oidc.urlFor('code_verification'),
          xsrf: ctx.oidc.session?.state?.secret,
          userCode,
          clientName: clientName(found),
          scopes: typeof scope === 'string' ? scope.split(' ').filter(Boolean) : [],
        }),
      );
    },
    async successSource(ctx: KoaContextWithOIDC) {
      await audit('device_code_approved', ctx.oidc.client?.clientId);
      send(ctx, await render({ view: 'device_done', clientName: clientName(ctx.oidc.client) }));
    },
  };
}
