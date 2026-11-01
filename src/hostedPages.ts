/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { HostedUi } from '@seamless-auth/types';
import express, { type Router } from 'express';

import type { EdgeConfigCache } from './configCache.js';

/**
 * Paths the SPA renders. The adapter's bundled screens (`@seamless-auth/react` AuthRoutes)
 * own most of them, and the API builds magic link and recovery URLs from some.
 */
export const HOSTED_PAGE_PATHS = [
  '/',
  '/interaction/:uid',
  '/login',
  '/passkey-login',
  '/verify-phone-otp',
  '/verify-email-otp',
  '/verify-magiclink',
  '/oauth/callback',
  '/register-passkey',
  '/magic-link-sent',
  '/recovery-code',
  '/recovery-codes',
  '/account-recovery',
  '/recovery/cancel',
] as const;

const HEAD_PLACEHOLDER = '<!--seamless:head-->';

export interface HostedBranding {
  appName: string;
  logoUrl?: string;
}

const COLOR_VARIABLES = {
  primary: '--seamless-color-primary',
  onPrimary: '--seamless-color-on-primary',
  background: '--seamless-color-background',
  surface: '--seamless-color-surface',
  text: '--seamless-color-text',
  muted: '--seamless-color-muted',
} as const;

export interface HostedPagesOptions {
  /** The built SPA: `index.html` and its `assets/`. */
  uiDir: string;
  configCache: EdgeConfigCache;
}

/** JSON for an inline `<script type="application/json">`, safe against `</script>`. */
export function inlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * ADR D7's CSP. The bundled screens inject their CSS at runtime, so injected `<style>`
 * elements take the response's nonce (see `ui/src/nonce.ts`). Scripts stay `'self'` only.
 */
export function contentSecurityPolicy(
  nonce: string,
  logoUrl?: string,
  formActions: readonly string[] = [],
): string {
  const logoOrigin = logoUrl ? ` ${new URL(logoUrl).origin}` : '';
  // Browsers apply form-action to the redirects that follow a submission, so a form that
  // ends at an app's post-logout URI has to name that origin.
  const formOrigins = formActions.map((uri) => ` ${new URL(uri).origin}`).join('');
  return [
    "default-src 'none'",
    "script-src 'self'",
    `style-src 'self' 'nonce-${nonce}'`,
    `img-src 'self' data:${logoOrigin}`,
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    `form-action 'self'${formOrigins}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; ');
}

export interface BrandingStyle {
  css: string;
  /** Set when the branding has colors, which turns off the stylesheet's dark palette. */
  palette: boolean;
}

/**
 * `hosted_ui` as CSS variables. The API and this service's config client both validate it
 * against `HostedUiSchema`, which only admits hex colors and plain font names.
 */
export function brandingStyle(hostedUi: HostedUi | undefined): BrandingStyle | undefined {
  const declarations: string[] = [];
  for (const [key, variable] of Object.entries(COLOR_VARIABLES)) {
    const value = hostedUi?.colors?.[key as keyof typeof COLOR_VARIABLES];
    if (value) {
      declarations.push(`${variable}:${value}`);
    }
  }
  const palette = declarations.length > 0;
  if (palette) {
    declarations.push('color-scheme:light');
  }
  if (hostedUi?.fontFamily) {
    declarations.push(`--seamless-font-family:${hostedUi.fontFamily}`);
  }
  return declarations.length > 0
    ? { css: `:root:root{${declarations.join(';')}}`, palette }
    : undefined;
}

export function brandingFor(appName: string, hostedUi: HostedUi | undefined): HostedBranding {
  return {
    appName: hostedUi?.appName ?? appName,
    ...(hostedUi?.logoUrl ? { logoUrl: hostedUi.logoUrl } : {}),
  };
}

/** A page the provider renders itself (logout, device flow), handed to the SPA as data. */
export type HostedPageData = Record<string, unknown> & { view: string };

export function renderIndex(
  template: string,
  branding: HostedBranding,
  nonce: string,
  style?: BrandingStyle,
  page?: HostedPageData,
): string {
  const head = [
    `<meta name="seamless-csp-nonce" content="${nonce}" />`,
    `<title>Sign in to ${escapeHtml(branding.appName)}</title>`,
    `<script type="application/json" id="seamless-hosted">${inlineJson(branding)}</script>`,
    ...(page
      ? [`<script type="application/json" id="seamless-page">${inlineJson(page)}</script>`]
      : []),
    ...(style
      ? [
          `<style nonce="${nonce}"${style.palette ? ' id="seamless-palette"' : ''}>${style.css}</style>`,
        ]
      : []),
  ].join('\n    ');
  return template.replace(HEAD_PLACEHOLDER, head);
}

function pageHeaders(nonce: string, logoUrl?: string, formActions?: readonly string[]) {
  return {
    'content-security-policy': contentSecurityPolicy(nonce, logoUrl, formActions),
    'cache-control': 'no-store',
    'cross-origin-opener-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  };
}

export interface RenderedPage {
  html: string;
  headers: Record<string, string>;
}

export type HostedPageRenderer = (
  page?: HostedPageData,
  formActions?: readonly string[],
) => Promise<RenderedPage>;

export function createHostedPageRenderer(options: HostedPagesOptions): HostedPageRenderer {
  const template = readFileSync(join(options.uiDir, 'index.html'), 'utf8');
  if (!template.includes(HEAD_PLACEHOLDER)) {
    throw new Error(`${options.uiDir}/index.html has no ${HEAD_PLACEHOLDER} placeholder`);
  }
  return async (page, formActions) => {
    const config = await options.configCache.get();
    const nonce = randomBytes(16).toString('base64');
    const branding = brandingFor(config.appName, config.hostedUi);
    return {
      html: renderIndex(template, branding, nonce, brandingStyle(config.hostedUi), page),
      headers: pageHeaders(nonce, branding.logoUrl, formActions),
    };
  };
}

/**
 * Serves the hosted login and consent pages. Branding is read from the API's config on each
 * page load and written into `index.html`, so changing it is a config write, never a build.
 */
export function createHostedPagesRouter(
  options: HostedPagesOptions,
  render: HostedPageRenderer = createHostedPageRenderer(options),
): Router {
  const router = express.Router();

  router.use(
    '/assets',
    express.static(join(options.uiDir, 'assets'), {
      fallthrough: false,
      immutable: true,
      maxAge: '365d',
      index: false,
      setHeaders: (res) => {
        res.setHeader('x-content-type-options', 'nosniff');
      },
    }),
  );

  router.get([...HOSTED_PAGE_PATHS], (_req, res, next) => {
    render()
      .then(({ html, headers }) => {
        res.set(headers).type('html').send(html);
      })
      .catch(next);
  });

  return router;
}
