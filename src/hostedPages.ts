/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { HostedUi } from '@seamless-auth/types';
import express, { type Response, type Router } from 'express';

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
export function contentSecurityPolicy(nonce: string, logoUrl?: string): string {
  const logoOrigin = logoUrl ? ` ${new URL(logoUrl).origin}` : '';
  return [
    "default-src 'none'",
    "script-src 'self'",
    `style-src 'self' 'nonce-${nonce}'`,
    `img-src 'self' data:${logoOrigin}`,
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "form-action 'self'",
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

export function renderIndex(
  template: string,
  branding: HostedBranding,
  nonce: string,
  style?: BrandingStyle,
): string {
  const head = [
    `<meta name="seamless-csp-nonce" content="${nonce}" />`,
    `<title>Sign in to ${escapeHtml(branding.appName)}</title>`,
    `<script type="application/json" id="seamless-hosted">${inlineJson(branding)}</script>`,
    ...(style
      ? [
          `<style nonce="${nonce}"${style.palette ? ' id="seamless-palette"' : ''}>${style.css}</style>`,
        ]
      : []),
  ].join('\n    ');
  return template.replace(HEAD_PLACEHOLDER, head);
}

function setPageHeaders(res: Response, nonce: string, logoUrl?: string) {
  res.set({
    'content-security-policy': contentSecurityPolicy(nonce, logoUrl),
    'cache-control': 'no-store',
    'cross-origin-opener-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  });
}

/**
 * Serves the hosted login and consent pages. Branding is read from the API's config on each
 * page load and written into `index.html`, so changing it is a config write, never a build.
 */
export function createHostedPagesRouter(options: HostedPagesOptions): Router {
  const template = readFileSync(join(options.uiDir, 'index.html'), 'utf8');
  if (!template.includes(HEAD_PLACEHOLDER)) {
    throw new Error(`${options.uiDir}/index.html has no ${HEAD_PLACEHOLDER} placeholder`);
  }

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
    options.configCache
      .get()
      .then((config) => {
        const nonce = randomBytes(16).toString('base64');
        const branding = brandingFor(config.appName, config.hostedUi);
        setPageHeaders(res, nonce, branding.logoUrl);
        res
          .type('html')
          .send(renderIndex(template, branding, nonce, brandingStyle(config.hostedUi)));
      })
      .catch(next);
  });

  return router;
}
