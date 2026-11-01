/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import type Provider from 'oidc-provider';
import type { KoaContextWithOIDC } from 'oidc-provider';

import type { OidcApiClient } from './apiClient.js';
import type { HostedPageRenderer, RenderedPage } from './hostedPages.js';
import { currentRequestContext } from './requestContext.js';

function send(ctx: KoaContextWithOIDC, { html, headers }: RenderedPage) {
  ctx.set(headers);
  ctx.type = 'html';
  ctx.body = html;
}

/** The library's logout confirmation and signed-out pages, rendered by the hosted UI. */
export function createLogoutPages(render: HostedPageRenderer) {
  return {
    async logoutSource(ctx: KoaContextWithOIDC) {
      const { oidc } = ctx;
      const postLogout = oidc.params?.post_logout_redirect_uri;
      send(
        ctx,
        await render(
          {
            view: 'logout',
            action: oidc.urlFor('end_session_confirm'),
            xsrf: oidc.session?.state?.secret,
            clientName: oidc.client ? (oidc.client.clientName ?? oidc.client.clientId) : null,
          },
          typeof postLogout === 'string' ? [postLogout] : [],
        ),
      );
    },
    async postLogoutSuccessSource(ctx: KoaContextWithOIDC) {
      const client = ctx.oidc.client;
      send(
        ctx,
        await render({
          view: 'signed_out',
          clientName: client ? (client.clientName ?? client.clientId) : null,
        }),
      );
    },
  };
}

/**
 * The API sends back-channel logout itself (ADR D3), for every way a session ends, so the
 * library's own sender is switched off. The feature stays on for what else it does: the
 * client metadata, discovery and `sid` in ID tokens.
 */
export function leaveBackchannelLogoutToApi(provider: Provider) {
  provider.Client.prototype.backchannelLogout = async () => {};
}

/**
 * "Sign out" ends the provider session, which the library does, and the first-party session
 * it was made under, which this does. That revocation is what tells every other app the user
 * signed in to through it. The adapter cookies are cleared too, so the hosted pages do not
 * offer a session that no longer exists.
 */
export function endFirstPartySessionOnLogout(client: OidcApiClient, adapterCookies: string[]) {
  return async (ctx: KoaContextWithOIDC, next: () => Promise<unknown>) => {
    await next();
    if (ctx.oidc?.route !== 'end_session_confirm' || ctx.status !== 303) {
      return;
    }
    const everywhere = Boolean(ctx.oidc.params?.logout);
    const context = currentRequestContext();
    if (everywhere) {
      for (const name of adapterCookies) {
        ctx.cookies.set(name, null, { path: '/', secure: true, httpOnly: true, sameSite: 'lax' });
      }
    }
    if (!context?.sessionId) {
      return;
    }
    const clientId = ctx.oidc.client?.clientId;
    try {
      if (everywhere) {
        await client.revokeSession(context.sessionId, {
          reason: 'provider_logout',
          correlationId: context.correlationId,
        });
      }
      await client.event({
        type: 'end_session',
        correlationId: context.correlationId,
        occurredAt: new Date().toISOString(),
        sessionId: context.sessionId,
        ...(clientId ? { clientId } : {}),
        metadata: { scope: everywhere ? 'session' : 'client' },
      });
    } catch (error) {
      console.error(`[oidc-provider] could not end the first-party session: ${String(error)}`);
    }
  };
}
