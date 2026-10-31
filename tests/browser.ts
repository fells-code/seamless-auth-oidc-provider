/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import { createHmac } from 'node:crypto';
import { request as httpRequest } from 'node:http';

import { ISSUER } from './fakeApi.js';

export interface EdgeResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json<T = unknown>(): T;
}

export interface EdgeRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** Sends a request for the issuer's origin to the edge listening at `base`. */
export function sendToEdge(
  base: string,
  url: string,
  init: EdgeRequest = {},
): Promise<EdgeResponse> {
  const target = new URL(url, ISSUER);
  const issuer = new URL(ISSUER);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      `${base}${target.pathname}${target.search}`,
      {
        method: init.method ?? 'GET',
        headers: {
          'x-forwarded-proto': issuer.protocol.slice(0, -1),
          ...init.headers,
          host: target.host,
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text,
            json: <T>() => JSON.parse(text) as T,
          }),
        );
      },
    );
    req.on('error', reject);
    if (init.body !== undefined) {
      req.write(init.body);
    }
    req.end();
  });
}

/** A `fetch` for the issuer's origin, for RP libraries that take a custom one. */
export function edgeFetch(base: string) {
  return async (url: string, options: RequestInit = {}): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(options.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const body =
      options.body === undefined || options.body === null
        ? undefined
        : options.body instanceof URLSearchParams
          ? options.body.toString()
          : String(options.body);
    const response = await sendToEdge(base, url, {
      method: options.method ?? 'GET',
      headers,
      ...(body === undefined ? {} : { body }),
    });
    const responseHeaders = new Headers();
    for (const [name, value] of Object.entries(response.headers)) {
      if (typeof value === 'string') {
        responseHeaders.set(name, value);
      }
    }
    return new Response(response.status === 204 ? null : response.text, {
      status: response.status,
      headers: responseHeaders,
    });
  };
}

/** A browser that keeps cookies and sends the headers a same-origin page would. */
export class FakeBrowser {
  readonly cookies = new Map<string, string>();

  constructor(readonly base: string) {}

  async get(url: string, headers: Record<string, string> = {}): Promise<EdgeResponse> {
    return this.#send(url, { method: 'GET', headers });
  }

  async post(url: string, headers: Record<string, string> = {}): Promise<EdgeResponse> {
    return this.#send(url, {
      method: 'POST',
      headers: { origin: new URL(ISSUER).origin, 'sec-fetch-site': 'same-origin', ...headers },
    });
  }

  async #send(url: string, init: EdgeRequest): Promise<EdgeResponse> {
    const cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    const response = await sendToEdge(this.base, url, {
      ...init,
      headers: { ...(cookie ? { cookie } : {}), ...init.headers },
    });
    const setCookie = response.headers['set-cookie'] ?? [];
    for (const line of Array.isArray(setCookie) ? setCookie : [setCookie]) {
      const [pair = ''] = line.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (!value || /expires=Thu, 01 Jan 1970/i.test(line)) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
    return response;
  }
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function hs256(payload: Record<string, unknown>, secret: string): string {
  const input = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url(payload)}`;
  return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
}

/** The access cookie the adapter sets once a first-party sign-in succeeds. */
export function firstPartyCookie(
  secret: string,
  { sub, sessionId, recovery = false }: { sub: string; sessionId?: string; recovery?: boolean },
): string {
  const now = Math.floor(Date.now() / 1000);
  const token = `${base64url({ alg: 'RS256' })}.${base64url({
    sub,
    typ: 'access',
    ...(sessionId ? { sid: sessionId } : {}),
    ...(recovery ? { recovery: true } : {}),
  })}.sig`;
  return hs256(
    { sub, ...(sessionId ? { sessionId } : {}), token, roles: ['user'], iat: now, exp: now + 300 },
    secret,
  );
}
