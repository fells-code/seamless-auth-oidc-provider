/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { AxeBuilder } from '@axe-core/playwright';
import type { HostedUi } from '@seamless-auth/types';
import express from 'express';
import { type Browser, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { EdgeConfigCache } from '../../src/configCache.js';
import {
  createHostedPageRenderer,
  createHostedPagesRouter,
  type HostedPageData,
} from '../../src/hostedPages.js';
import { EDGE_CONFIG } from '../fakeApi.js';

/** WCAG 2.0, 2.1 and 2.2 A and AA, as axe tags them. */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const UI_DIR = join(import.meta.dirname, '../../dist/ui');

/** A palette an adopter might pick, every pair at AA or better. */
const CUSTOM_BRANDING: HostedUi = {
  appName: 'Acme Workspace',
  logoUrl: 'https://cdn.acme.example/logo.png',
  colors: {
    primary: '#0b6e4f',
    onPrimary: '#ffffff',
    background: '#fbf7ef',
    surface: '#fffdf8',
    text: '#2b2620',
    muted: '#5c5446',
  },
  fontFamily: 'Georgia, serif',
};

const BRANDINGS = [
  { name: 'default branding', hostedUi: undefined, colorScheme: 'light' },
  { name: 'default branding, dark', hostedUi: undefined, colorScheme: 'dark' },
  { name: 'custom branding', hostedUi: CUSTOM_BRANDING, colorScheme: 'light' },
  { name: 'custom branding, dark preference', hostedUi: CUSTOM_BRANDING, colorScheme: 'dark' },
] as const;

/** Pages the provider renders itself, by the data the edge writes into them. */
const PROVIDER_PAGES: Record<string, HostedPageData> = {
  logout: {
    view: 'logout',
    action: '/session/end/confirm',
    xsrf: 'xsrf',
    clientName: 'Example App',
  },
  signed_out: { view: 'signed_out', clientName: 'Example App' },
  device_input: { view: 'device_input', action: '/device', xsrf: 'xsrf', userCode: null },
  device_input_error: {
    view: 'device_input',
    action: '/device',
    xsrf: 'xsrf',
    userCode: 'BCDF-GHJK',
    error: 'not_found',
  },
  device_confirm: {
    view: 'device_confirm',
    action: '/device',
    xsrf: 'xsrf',
    userCode: 'BCDF-GHJK',
    clientName: 'Example TV',
    scopes: ['openid', 'email', 'offline_access'],
  },
  device_done: { view: 'device_done', clientName: 'Example TV' },
  error: {
    view: 'error',
    error: 'invalid_redirect_uri',
    description: "redirect_uri did not match any of the client's registered redirect_uris",
  },
};

const PROMPT = { reasons: [], missingClaims: [], missingResourceScopes: [] };

/** `/interaction/:uid/details` answers, by uid. */
const INTERACTIONS: Record<string, unknown> = {
  consent: {
    uid: 'consent',
    prompt: { ...PROMPT, name: 'consent', missingScopes: ['openid', 'email', 'offline_access'] },
    client: {
      id: 'partner',
      name: 'Partner App',
      firstParty: false,
      redirectHost: 'partner.example.net',
    },
    scopes: ['openid', 'email', 'offline_access'],
    loginHint: null,
  },
  native: {
    uid: 'native',
    prompt: {
      ...PROMPT,
      name: 'consent',
      reasons: ['native_client_prompt'],
      missingScopes: [],
    },
    client: { id: 'native', name: 'Example Desktop', firstParty: true, redirectHost: null },
    scopes: ['openid'],
    loginHint: null,
  },
  stepup: {
    uid: 'stepup',
    prompt: { ...PROMPT, name: 'login', reasons: ['auth_context'], missingScopes: [] },
    client: { id: 'first', name: 'Example App', firstParty: true, redirectHost: null },
    scopes: ['openid'],
    loginHint: null,
  },
};

const PUBLIC_SYSTEM_CONFIG = {
  app_name: 'Example',
  login_methods: ['passkey', 'email_otp', 'magic_link'],
  passkey_login_fallback_enabled: true,
  recovery_codes: { enabled: true },
  account_recovery: { enabled: true },
  oauth_providers: [],
};

const RECOVERY_CODES = ['7KQ2-M9XA', 'P4TZ-8HWD', 'C3NV-R6JE', 'Y2BF-5LQS'];

interface Target {
  name: string;
  path: string;
  /** Something on the page once it has rendered. */
  ready: string;
  signedIn?: boolean;
  /** Steps from the landing state to the state under test. */
  act?: (page: Page) => Promise<void>;
}

const TARGETS: Target[] = [
  { name: 'sign-in (new account)', path: '/login', ready: 'main form' },
  {
    name: 'sign-in (returning user)',
    path: '/login',
    ready: 'main form',
    act: async (page) => {
      await page
        .getByRole('button', { name: /sign in/i })
        .last()
        .click();
    },
  },
  {
    name: 'sign-in with an error',
    path: '/login',
    ready: 'main form',
    act: async (page) => {
      await page
        .getByRole('button', { name: /sign in/i })
        .last()
        .click();
      // The adapter answers 401 to signed-out calls, so starting the sign-in fails.
      await page.getByRole('textbox').first().fill('ada@example.com');
      await page.getByRole('button', { name: /^login$/i }).click();
      await page.getByText(/please try again/i).waitFor();
    },
  },
  { name: 'consent (third-party app)', path: '/interaction/consent', ready: '#consent-title' },
  { name: 'native app confirmation', path: '/interaction/native', ready: '#confirm-title' },
  {
    name: 'step-up',
    path: '/interaction/stepup',
    ready: '#step-up-title',
    signedIn: true,
  },
  { name: 'expired sign-in request', path: '/interaction/gone', ready: '#notice-title' },
  { name: 'device code entry', path: '/provider/device_input', ready: '#device-title' },
  {
    name: 'device code entry with an error',
    path: '/provider/device_input_error',
    ready: '#device-title',
  },
  { name: 'device confirmation', path: '/provider/device_confirm', ready: '#device-confirm-title' },
  { name: 'device signed in', path: '/provider/device_done', ready: '#device-done-title' },
  { name: 'sign-out confirmation', path: '/provider/logout', ready: '#logout-title' },
  { name: 'signed out', path: '/provider/signed_out', ready: '#signed-out-title' },
  { name: 'error page', path: '/provider/error', ready: '#error-title' },
  {
    name: 'passkey enrollment (bundled)',
    path: '/register-passkey',
    ready: 'main button',
    signedIn: true,
  },
  {
    name: 'recovery codes (bundled)',
    path: '/recovery-codes',
    ready: 'main input[type=checkbox]',
    signedIn: true,
  },
];

// Runs in the page. A string, as this project's TypeScript has no DOM library.
const FOCUSED_CONTROL = `(() => {
  const element = document.activeElement;
  if (!element || element === document.body || !element.closest('main')) return null;
  const style = getComputedStyle(element);
  return {
    label: element.tagName.toLowerCase() + ' ' + (element.textContent || '').trim(),
    indicator:
      (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) ||
      style.boxShadow !== 'none',
  };
})()`;

let hostedUi: HostedUi | undefined;
let browser: Browser;
let base: string;
let close: () => void;

function startServer() {
  const configCache = {
    get: async () => ({ ...EDGE_CONFIG, ...(hostedUi ? { hostedUi } : {}) }),
  } as unknown as EdgeConfigCache;
  const options = { uiDir: UI_DIR, configCache };
  const render = createHostedPageRenderer(options);
  const app = express();
  app.get('/provider/:name', (req, res, next) => {
    const page = PROVIDER_PAGES[req.params.name];
    if (!page) {
      res.sendStatus(404);
      return;
    }
    render(page)
      .then(({ html, headers }) => res.set(headers).type('html').send(html))
      .catch(next);
  });
  app.get('/interaction/:uid/details', (req, res) => {
    const details = INTERACTIONS[req.params.uid];
    if (details) {
      res.json(details);
    } else {
      res.status(404).json({ error: 'interaction_expired' });
    }
  });
  app.post('/interaction/stepup/login', (_req, res) => {
    res.status(403).json({ error: 'step_up_required', methods: ['passkey', 'totp'] });
  });
  app.use(createHostedPagesRouter(options, render));
  // The adapter routes the bundled screens call. A page that needs a signed-in user marks its
  // requests with a header.
  app.get('/auth/system-config/public', (_req, res) => {
    res.json(PUBLIC_SYSTEM_CONFIG);
  });
  app.get('/auth/recovery-codes', (_req, res) => {
    res.json({ enabled: true, remaining: 0, total: 0 });
  });
  app.post(/^\/auth\/recovery-codes/, (_req, res) => {
    res.json({ codes: RECOVERY_CODES });
  });
  app.use((req, res) => {
    if (req.get('x-a11y-signed-in') === 'yes') {
      res.json({ user: { id: 'user', email: 'ada@example.com', roles: ['user'] } });
      return;
    }
    res.status(401).json({ error: 'unauthenticated' });
  });
  const server = app.listen(0, '127.0.0.1');
  return new Promise<void>((resolve) => {
    server.once('listening', () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      close = () => server.close();
      resolve();
    });
  });
}

async function openPage(target: Target, colorScheme: 'light' | 'dark'): Promise<Page> {
  const context = await browser.newContext({ colorScheme, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.route('https://cdn.acme.example/**', (route) => route.abort());
  // A platform authenticator, so the passkey screens render as they would on a phone or laptop.
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  });
  if (target.signedIn) {
    await page.setExtraHTTPHeaders({ 'x-a11y-signed-in': 'yes' });
  }
  await page.goto(`${base}${target.path}`);
  await page.locator(target.ready).first().waitFor({ state: 'visible', timeout: 10_000 });
  if (target.act) {
    await target.act(page);
  }
  return page;
}

describe.skipIf(!existsSync(join(UI_DIR, 'index.html')))('hosted pages meet WCAG 2.2 AA', () => {
  beforeAll(async () => {
    browser = await chromium.launch();
    await startServer();
  });

  afterAll(async () => {
    await browser?.close();
    close?.();
  });

  for (const branding of BRANDINGS) {
    describe(branding.name, () => {
      for (const target of TARGETS) {
        it(target.name, async () => {
          hostedUi = branding.hostedUi;
          const page = await openPage(target, branding.colorScheme);
          try {
            const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
            const found = results.violations.map((violation) => ({
              rule: violation.id,
              impact: violation.impact,
              nodes: violation.nodes.map((node) => ({
                target: node.target.join(' '),
                summary: node.failureSummary,
              })),
            }));
            expect(found).toEqual([]);
          } finally {
            await page.context().close();
          }
        });
      }
    });
  }

  // WCAG 2.1.1 and 2.4.7, which axe cannot see: every control is reached with Tab and shows
  // where focus is.
  describe('keyboard', () => {
    for (const target of TARGETS) {
      it(target.name, async () => {
        hostedUi = undefined;
        const page = await openPage(target, 'light');
        try {
          const controls = await page
            .locator('main :is(a[href], button:not([disabled]), input:not([type=hidden]))')
            .count();
          const reached: { label: string; indicator: boolean }[] = [];
          for (let step = 0; step < controls + 2; step += 1) {
            await page.keyboard.press('Tab');
            const focused = (await page.evaluate(FOCUSED_CONTROL)) as {
              label: string;
              indicator: boolean;
            } | null;
            if (focused && !reached.some((entry) => entry.label === focused.label)) {
              reached.push(focused);
            }
          }
          expect(reached.length).toBe(controls);
          expect(reached.filter((entry) => !entry.indicator)).toEqual([]);
        } finally {
          await page.context().close();
        }
      });
    }
  });
});
