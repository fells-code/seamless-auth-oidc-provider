// Checks a running stack from the outside: health, discovery and JWKS over TLS with only the
// local CA, production checks, the hosted page, a verified token for the resource, and a second
// seed that changes nothing. The passkey half is passkey-sign-in.mjs.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  backendClientAuth,
  backendToken,
  call,
  discovery,
  env,
  generatedPath,
  readGenerated,
  recipe,
  startNativeSignIn,
  verifyAccessToken,
} from './lib.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const failures = [];

function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? `: ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

const run = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: here, encoding: 'utf8', stdio: 'pipe', ...options });

const { issuer, resource, nativeClientId, backendClientId, scopes, apiUrl } = recipe();

const compose = (...args) => run('docker', ['compose', '--env-file', 'settings.env', ...args]);

const services = compose('ps', '--all', '--format', '{{.Service}} {{.State}} {{.Health}}')
  .trim()
  .split('\n')
  .map((line) => line.split(' '));
for (const [service, state, health] of services) {
  if (service === 'seed') continue;
  check(`${service} is healthy`, state === 'running' && health === 'healthy', `${state} ${health}`);
}

const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
const curl = (url, extra = []) => run('curl', ['-sS', '--fail', ...extra, url]);
const viaCurl = JSON.parse(curl(discoveryUrl, ['--cacert', generatedPath('ca.crt')]));
check('discovery answers over TLS with --cacert', viaCurl.issuer === issuer, viaCurl.issuer);
let refused = false;
try {
  curl(discoveryUrl, ['--cacert', '/dev/null']);
} catch {
  refused = true;
}
check('the certificate does not verify without the local CA', refused);

const config = await discovery();
check('issuer is https and the edge origin', issuer.startsWith('https://auth.'), issuer);
const jwks = JSON.parse(curl(config.jwks_uri, ['--cacert', generatedPath('ca.crt')]));
check('JWKS answers over TLS', jwks.keys?.length > 0);
check(
  'JWKS holds public keys only',
  jwks.keys?.every((key) => !('d' in key)),
);

const docs = await call(`${apiUrl}/docs`);
check('the API runs in production mode (no /docs)', docs.status === 404, `status ${docs.status}`);
for (const service of ['api', 'edge']) {
  const mode = compose('exec', '-T', service, 'printenv', 'NODE_ENV').trim();
  check(`${service} has NODE_ENV=production`, mode === 'production', mode);
}

const flow = await startNativeSignIn();
const authorize = await call(flow.url);
const cookies = authorize.headers['set-cookie'] ?? [];
flow.close();
check(
  'authorize redirects into the sign-in',
  authorize.status === 303,
  `status ${authorize.status}`,
);
check(
  'provider cookies are __Host- and Secure',
  cookies.length > 0 &&
    cookies.every((cookie) => cookie.startsWith('__Host-') && /;\s*secure/i.test(cookie)),
  cookies.map((cookie) => cookie.split('=')[0]).join(', '),
);
const location = new URL(authorize.headers.location, issuer);
const hosted = await call(location.href, {
  headers: { cookie: cookies.map((cookie) => cookie.split(';')[0]).join('; ') },
});
check(
  'the authorization endpoint renders the hosted page',
  hosted.status === 200 &&
    (hosted.headers['content-type'] ?? '').startsWith('text/html') &&
    /<div id="root"/.test(hosted.text),
  `status ${hosted.status} at ${location.pathname}`,
);
check('the hosted page carries a CSP', Boolean(hosted.headers['content-security-policy']));

const token = await backendToken();
check('client credentials answers with a token', token.status === 200, token.text);
const claims = await verifyAccessToken(token.json.access_token, { audience: resource }).catch(
  (error) => check(`the token verifies: ${error.message}`, false),
);
if (claims) {
  check('the token verifies against the JWKS', true);
  check(
    'the token names the backend',
    claims.sub === backendClientId && claims.client_id === backendClientId,
  );
  check('the token carries the linked scopes', claims.scope === scopes.join(' '), claims.scope);
  check(
    'a client credentials token carries no assurance claims',
    !('acr' in claims || 'amr' in claims || 'auth_time' in claims),
  );
}
const other = await backendToken(`https://other-${randomBytes(4).toString('hex')}.example`);
check(
  'a resource the client is not linked to is refused',
  other.json?.error === 'invalid_target',
  other.text,
);

const introspected = await call(config.introspection_endpoint, {
  method: 'POST',
  form: {
    ...backendClientAuth(backendClientId, issuer),
    token: token.json?.access_token ?? '',
  },
});
check(
  'the backend can introspect its token',
  introspected.json?.active === true,
  introspected.text,
);

const before = readGenerated('recipe.json');
process.env.HOST_UID = String(process.getuid());
process.env.HOST_GID = String(process.getgid());
const seed = compose('run', '--rm', '--no-deps', 'seed');
const lines = seed.split('\n').filter((line) => /^(created|unchanged) /.test(line));
check('a second seed reports every record', lines.length === 5, seed);
check(
  'a second seed creates nothing',
  lines.every((line) => line.startsWith('unchanged')),
  seed,
);
check('a second seed keeps the same ids', readGenerated('recipe.json') === before);
check('the native client is still the one seeded', recipe().nativeClientId === nativeClientId);

console.log(
  failures.length ? `${failures.length} failed` : `smoke passed (${env.COMPOSE_PROJECT_NAME})`,
);
process.exit(failures.length ? 1 : 0);
