#!/usr/bin/env node

/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import express from 'express';

import { createOidcEdge } from './createOidcEdge.js';
import { parseEnv } from './env.js';

async function main() {
  const env = parseEnv();
  const edge = await createOidcEdge({
    apiUrl: env.SEAMLESS_API_URL,
    ...(env.SEAMLESS_API_ISSUER ? { apiIssuer: env.SEAMLESS_API_ISSUER } : {}),
    serviceSecret: env.SEAMLESS_SERVICE_TOKEN,
    ...(env.SEAMLESS_JWKS_KID ? { serviceTokenKid: env.SEAMLESS_JWKS_KID } : {}),
    cookieKeys: env.OIDC_COOKIE_KEYS,
    adapterCookieSecret: env.SEAMLESS_COOKIE_SECRET,
    trustProxy: env.TRUST_PROXY,
  });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY ? 1 : false);
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.use(edge.router);

  app.listen(env.PORT, () => {
    console.log(`Seamless OpenID Provider listening on ${env.PORT}, issuer ${edge.issuer}`);
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
