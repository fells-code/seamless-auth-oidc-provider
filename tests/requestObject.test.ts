/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { FakeBrowser } from './browser.js';
import { firstParty, REDIRECT, startEdge } from './harness.js';

const HTML = { accept: 'text/html' };

function unsigned(payload: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(payload)}.`;
}

function authorize(params: Record<string, string>) {
  return `/authorize?${new URLSearchParams({
    client_id: firstParty.client_id,
    response_type: 'code',
    scope: 'openid',
    redirect_uri: REDIRECT,
    state: 'outside-state',
    ...params,
  })}`;
}

function formOf(html: string) {
  const action = /<form method="post" action="([^"]*)"/.exec(html)?.[1];
  const inputs = Object.fromEntries(
    [...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"\/>/g)].map((m) => [
      m[1]!,
      m[2]!,
    ]),
  );
  return { action, inputs };
}

describe('a refused request object', () => {
  let browser: FakeBrowser;

  beforeEach(async () => {
    const started = await startEdge();
    browser = new FakeBrowser(started.base);
  });

  it('returns request_not_supported by form post when the object asks for form_post', async () => {
    const response = await browser.get(
      authorize({
        request: unsigned({
          client_id: firstParty.client_id,
          response_type: 'code',
          response_mode: 'form_post',
          redirect_uri: REDIRECT,
          scope: 'openid',
        }),
      }),
      HTML,
    );

    expect(response.headers.location).toBeUndefined();
    expect(response.status).toBe(400);
    expect(formOf(response.text)).toEqual({
      action: REDIRECT,
      inputs: {
        error: 'request_not_supported',
        error_description: expect.any(String),
        state: 'outside-state',
        iss: expect.any(String),
      },
    });
  });

  it('takes nothing else from the object: not its redirect_uri, nor its state', async () => {
    const response = await browser.get(
      authorize({
        request: unsigned({
          response_mode: 'form_post',
          redirect_uri: 'https://elsewhere.example.org/callback',
          state: '"><script>alert(1)</script>',
          client_id: 'someone-else',
        }),
      }),
      HTML,
    );

    const form = formOf(response.text);
    expect(form.action).toBe(REDIRECT);
    expect(form.inputs.state).toBe('outside-state');
    expect(response.text).not.toContain('elsewhere.example.org');
    expect(response.text).not.toContain('<script>alert(1)');
  });

  it('still refuses to send the error to an unregistered redirect_uri', async () => {
    const response = await browser.get(
      authorize({
        redirect_uri: 'https://elsewhere.example.org/callback',
        request: unsigned({ response_mode: 'form_post' }),
      }),
      HTML,
    );

    expect(response.headers.location).toBeUndefined();
    expect(response.text).not.toContain('elsewhere.example.org');
    expect(response.text).not.toContain('<form method="post"');
    expect(response.text).toContain('"view":"error"');
  });

  it.each([
    ['another response mode', unsigned({ response_mode: 'fragment' })],
    ['a JWT response mode', unsigned({ response_mode: 'form_post.jwt' })],
    ['a value that is not a string', unsigned({ response_mode: ['form_post'] })],
    ['a value that is not a JWT', 'not-a-jwt'],
    ['a payload that is not JSON', `e30.${Buffer.from('form_post').toString('base64url')}.`],
  ])('ignores %s and answers in the query', async (_label, request) => {
    const response = await browser.get(authorize({ request }), HTML);

    expect(response.status).toBe(303);
    const location = new URL(String(response.headers.location));
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    expect(location.searchParams.get('error')).toBe('request_not_supported');
    expect(location.searchParams.get('state')).toBe('outside-state');
  });

  it('lets the object override the outer response_mode, as OIDC Core 6.3.3 says', async () => {
    const response = await browser.get(
      authorize({ response_mode: 'query', request: unsigned({ response_mode: 'form_post' }) }),
      HTML,
    );

    expect(response.headers.location).toBeUndefined();
    expect(formOf(response.text).action).toBe(REDIRECT);
  });
});
