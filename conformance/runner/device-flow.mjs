// The device grant end to end against the real API, which the conformance suite has no plan
// for: a device asks for openid, a browser approves it with a passkey, and the device's
// tokens must state no assurance (ADR 0001 D10), which the API refuses to sign otherwise.
import { readFileSync } from 'node:fs';
import { request } from 'node:https';

import { chromium } from 'playwright';

import { signIn } from './browser.mjs';

const runDir = process.env.RUN_DIR ?? new URL('../.run/', import.meta.url).pathname;
const issuer = process.env.ISSUER ?? 'https://op.seamless.test:5321';
const clientId = 'conformance-device';
const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const ASSURANCE = ['acr', 'amr', 'auth_time'];

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ca = readFileSync(`${runDir}/tls.crt`);

// The edge's host name only resolves inside the browser (--host-resolver-rules).
function post(path, form) {
  const body = new URLSearchParams(form).toString();
  return new Promise((resolve, reject) => {
    const req = request(
      `${issuer}${path}`,
      {
        method: 'POST',
        ca,
        lookup: (_host, options, callback) =>
          options.all
            ? callback(null, [{ address: '127.0.0.1', family: 4 }])
            : callback(null, '127.0.0.1', 4),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

const claimsOf = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());

const failures = [];
function check(label, ok, detail) {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

function checkNoAssurance(label, tokens) {
  for (const [name, jwt] of [
    ['ID token', tokens.id_token],
    ['access token', tokens.access_token],
  ]) {
    if (!jwt || jwt.split('.').length !== 3) continue;
    const present = ASSURANCE.filter((claim) => claim in claimsOf(jwt));
    check(`${label}: ${name} states no assurance`, present.length === 0, present.join(', '));
  }
}

const authorization = await post('/device/auth', {
  client_id: clientId,
  scope: 'openid email offline_access',
});
check('device authorization', authorization.status === 200, authorization.body.error);
const { device_code: deviceCode, verification_uri_complete: verificationUri } = authorization.body;

const spki = readFileSync(`${runDir}/spki.txt`, 'utf8').trim();
const browser = await chromium.launch({
  args: [
    `--ignore-certificate-errors-spki-list=${spki}`,
    '--host-resolver-rules=MAP op.seamless.test 127.0.0.1',
  ],
});
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send('WebAuthn.enable');
await cdp.send('WebAuthn.addVirtualAuthenticator', {
  options: {
    protocol: 'ctap2',
    transport: 'internal',
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
  },
});
const account = { email: `device+${Date.now()}@seamless.test`, credential: null };

await page.goto(verificationUri);
await page.getByRole('button', { name: /^continue$/i }).click();
await page.waitForURL((url) => url.pathname !== '/device', { timeout: 15_000 });
await signIn({ page }, page.url(), account, `${runDir}/device-flow.png`).catch(async (error) => {
  log(`browser step failed: ${error.message.split('\n')[0]}`);
  log(
    `  at ${page.url()}\n${await page
      .locator('body')
      .ariaSnapshot()
      .catch(() => '')}`,
  );
});
const done = await page
  .getByRole('heading', { name: /your device is signed in/i })
  .waitFor({ timeout: 15_000 })
  .then(() => true)
  .catch(() => false);
check('approval in the browser', done, page.url());
await browser.close();

let tokens;
for (let attempt = 0; attempt < 5; attempt += 1) {
  tokens = await post('/token', {
    client_id: clientId,
    grant_type: DEVICE_CODE_GRANT,
    device_code: deviceCode,
  });
  if (tokens.body.error !== 'slow_down' && tokens.body.error !== 'authorization_pending') break;
  await sleep(6000);
}
check('device token response', tokens.status === 200, tokens.body.error);
check('an ID token', typeof tokens.body.id_token === 'string');
checkNoAssurance('device grant', tokens.body);

const refreshed = await post('/token', {
  client_id: clientId,
  grant_type: 'refresh_token',
  refresh_token: tokens.body.refresh_token,
});
check('refresh response', refreshed.status === 200, refreshed.body.error);
checkNoAssurance('refresh', refreshed.body);

log(failures.length ? `${failures.length} failed` : 'device flow passed');
process.exit(failures.length ? 1 : 0);
