/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import type { Middleware } from 'koa';

/**
 * The library scopes its resume cookie to `Path=/authorize/<uid>`, and a `__Host-` cookie
 * must have `Path=/`. This moves it to `Path=/` so a sibling subdomain cannot plant one, and,
 * since one browser now holds a single resume cookie, refuses to resume an authorization
 * whose uid is not the cookie's (the library would otherwise resume the cookie's).
 */
export function hostOnlyResumeCookie(cookieName: string, resumePath: string): Middleware {
  const pattern = new RegExp(`^${escapeRegExp(resumePath)}/([^/]+)$`);
  const prefixes = [`${cookieName}=`, `${cookieName}.sig=`];

  return async (ctx, next) => {
    const match = pattern.exec(ctx.path);
    if (match && ctx.method === 'GET') {
      const value = ctx.cookies.get(cookieName, { signed: true });
      if (value !== undefined && value !== decodeURIComponent(match[1]!)) {
        dropRequestCookie(ctx.req.headers, prefixes);
      }
    }
    await next();
    const header = ctx.res.getHeader('set-cookie');
    if (!Array.isArray(header)) {
      return;
    }
    ctx.res.setHeader(
      'set-cookie',
      header.map((line) =>
        prefixes.some((prefix) => line.startsWith(prefix))
          ? line.replace(/;\s*path=[^;]*/i, '; path=/')
          : line,
      ),
    );
  };
}

function dropRequestCookie(headers: { cookie?: string | undefined }, prefixes: string[]) {
  if (!headers.cookie) {
    return;
  }
  headers.cookie = headers.cookie
    .split(';')
    .map((part) => part.trim())
    .filter((part) => !prefixes.some((prefix) => part.startsWith(prefix)))
    .join('; ');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
