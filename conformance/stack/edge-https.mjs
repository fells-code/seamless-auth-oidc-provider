// The built service behind TLS: Koa refuses Secure cookies over plain http.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';

import express from 'express';

import { createOidcEdge, parseEnv } from '../../dist/index.js';

const env = parseEnv();
const edge = await createOidcEdge({
  apiUrl: env.SEAMLESS_API_URL,
  serviceSecret: env.SEAMLESS_OIDC_SERVICE_TOKEN,
  cookieKeys: env.OIDC_COOKIE_KEYS,
  adapterCookieSecret: env.SEAMLESS_COOKIE_SECRET,
});

const app = express();
app.disable('x-powered-by');
app.use(edge.router);

createServer(
  { key: readFileSync(process.env.TLS_KEY), cert: readFileSync(process.env.TLS_CERT) },
  app,
).listen(env.PORT, () => console.log(`edge on ${env.PORT}, issuer ${edge.issuer}`));
