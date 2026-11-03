/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import { isIP } from 'node:net';

import { z } from 'zod';

const SECRET_MIN_LENGTH = 32;

// Express's own names for the private ranges, which `trust proxy` accepts in a list.
const NAMED_RANGES = new Set(['loopback', 'linklocal', 'uniquelocal']);

function isProxyAddress(entry: string): boolean {
  if (NAMED_RANGES.has(entry)) {
    return true;
  }
  const [address = '', prefix, extra] = entry.split('/');
  const version = isIP(address);
  if (version === 0 || extra !== undefined) {
    return false;
  }
  if (prefix === undefined) {
    return true;
  }
  const bits = Number(prefix);
  return /^\d+$/.test(prefix) && bits <= (version === 4 ? 32 : 128);
}

/**
 * Express's `trust proxy`: `false`, the number of proxies in front of this service, or the
 * addresses and subnets of the ones it trusts. `true` keeps its old meaning of one proxy.
 */
const trustProxy = z
  .string()
  .default('false')
  .transform((value, ctx): false | number | string[] => {
    const trimmed = value.trim();
    if (trimmed === '' || trimmed === 'false' || trimmed === '0') {
      return false;
    }
    if (trimmed === 'true') {
      return 1;
    }
    if (/^\d+$/.test(trimmed)) {
      return Number(trimmed);
    }
    const entries = trimmed
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (entries.length === 0 || !entries.every(isProxyAddress)) {
      ctx.addIssue({ code: 'custom', message: 'expected a hop count or addresses and subnets' });
      return z.NEVER;
    }
    return entries;
  });

export const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(5314),
  SEAMLESS_API_URL: z.url(),
  SEAMLESS_API_ISSUER: z.url().optional(),
  SEAMLESS_OIDC_SERVICE_TOKEN: z.string().min(SECRET_MIN_LENGTH),
  SEAMLESS_JWKS_KID: z.string().min(1).optional(),
  SEAMLESS_COOKIE_SECRET: z.string().min(SECRET_MIN_LENGTH),
  OIDC_COOKIE_KEYS: z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((key) => key.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().min(SECRET_MIN_LENGTH)).min(1)),
  TRUST_PROXY: trustProxy,
});

export type Env = z.infer<typeof EnvSchema>;

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`Invalid environment: ${fields}`);
  }
  return parsed.data;
}
