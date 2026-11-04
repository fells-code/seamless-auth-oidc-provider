/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import type { Configuration, KoaContextWithOIDC } from 'oidc-provider';

import type { HostedPageRenderer } from './hostedPages.js';

type ErrorOut = Parameters<NonNullable<Configuration['renderError']>>[1];

/**
 * The page for an error the provider cannot send back to the app: an unknown client, an
 * unregistered redirect_uri or post_logout_redirect_uri, a broken id_token_hint. Only the
 * code and description go to the page, as data the UI renders as text. `state` is left out.
 */
export function createErrorPage(render: HostedPageRenderer) {
  return async (ctx: KoaContextWithOIDC, out: ErrorOut): Promise<void> => {
    const error = typeof out.error === 'string' ? out.error : 'server_error';
    // The library's own text for an unexposed error is "oops! something went wrong".
    const description =
      error !== 'server_error' && typeof out.error_description === 'string'
        ? out.error_description
        : 'Something went wrong on our side.';
    const { html, headers } = await render({ view: 'error', error, description });
    ctx.set(headers);
    ctx.type = 'html';
    ctx.body = html;
  };
}
