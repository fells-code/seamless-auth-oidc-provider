/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { FakeBrowser } from './browser.js';
import { firstParty, REDIRECT, startEdge } from './harness.js';

const HTML = { accept: 'text/html' };

function pageData(html: string) {
  const match = /<script type="application\/json" id="seamless-page">(.*?)<\/script>/.exec(html);
  return match ? (JSON.parse(match[1]!) as Record<string, unknown>) : undefined;
}

function authorize(params: Record<string, string>) {
  return `/authorize?${new URLSearchParams({
    response_type: 'code',
    scope: 'openid',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
    ...params,
  })}`;
}

describe('error pages the provider cannot redirect', () => {
  let browser: FakeBrowser;

  beforeEach(async () => {
    const started = await startEdge();
    browser = new FakeBrowser(started.base);
  });

  function expectHostedErrorPage(response: Awaited<ReturnType<FakeBrowser['get']>>, error: string) {
    expect(response.status).toBe(400);
    expect(response.headers['content-type']).toMatch(/^text\/html/);
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.text).not.toMatch(/oops/i);
    expect(response.text).toContain('<div id="root"></div>');
    const page = pageData(response.text);
    expect(page).toEqual({ view: 'error', error, description: expect.any(String) });
    return page!;
  }

  it('renders a refused authorization request on the hosted page', async () => {
    const response = await browser.get(
      authorize({
        client_id: firstParty.client_id,
        redirect_uri: 'https://elsewhere.example.org/callback',
        state: 'abc',
      }),
      HTML,
    );

    expect(response.headers.location).toBeUndefined();
    const page = expectHostedErrorPage(response, 'invalid_redirect_uri');
    expect(page.description).toMatch(/redirect_uri/);
  });

  it('renders an unknown client on the hosted page', async () => {
    const response = await browser.get(
      authorize({ client_id: 'nobody', redirect_uri: REDIRECT }),
      HTML,
    );

    expectHostedErrorPage(response, 'invalid_client');
  });

  it('renders a refused logout request on the hosted page', async () => {
    const response = await browser.get(
      `/session/end?${new URLSearchParams({
        client_id: firstParty.client_id,
        post_logout_redirect_uri: 'https://elsewhere.example.org/signed-out',
      })}`,
      HTML,
    );

    const page = expectHostedErrorPage(response, 'invalid_request');
    expect(page.description).toMatch(/post_logout_redirect_uri/);
  });

  it('renders a logout request with a broken id_token_hint on the hosted page', async () => {
    const response = await browser.get(
      `/session/end?${new URLSearchParams({ id_token_hint: 'not-a-token' })}`,
      HTML,
    );

    expectHostedErrorPage(response, 'invalid_request');
  });

  it('escapes what the request put into the error', async () => {
    const response = await browser.get(
      authorize({
        client_id: firstParty.client_id,
        redirect_uri: REDIRECT,
        scope: 'openid </script><script>alert(1)</script>',
        prompt: '</script><img src=x onerror=alert(1)>',
      }),
      HTML,
    );

    expect(response.text).not.toContain('<script>alert(1)</script>');
    expect(response.text).not.toContain('<img src=x');
  });

  it('keeps a server failure generic', async () => {
    const response = await browser.get(
      `/session/end?${new URLSearchParams({ client_id: 'nobody' })}`,
      HTML,
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    const page = pageData(response.text);
    expect(page?.view).toBe('error');
    expect(String(page?.description)).not.toMatch(/oops/i);
  });
});
