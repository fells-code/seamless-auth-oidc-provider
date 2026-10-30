/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import { z } from 'zod';

const SECRET_MIN_LENGTH = 32;

const booleanString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

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
  TRUST_PROXY: booleanString,
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
