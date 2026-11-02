// What the checks outside the suite (device-flow.mjs, resource-token.mjs) share: calls to the
// edge's endpoints, a browser with a passkey, and a tally of results.
import { readFileSync } from 'node:fs';
import { request } from 'node:https';

import { chromium } from 'playwright';

export const runDir = process.env.RUN_DIR ?? new URL('../.run/', import.meta.url).pathname;
export const issuer = process.env.ISSUER ?? 'https://op.seamless.test:5321';
export const ASSURANCE = ['acr', 'amr', 'auth_time'];

export const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ca = readFileSync(`${runDir}/tls.crt`);

// The edge's host name only resolves inside the browser (--host-resolver-rules).
export function post(path, form) {
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

export const claimsOf = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
export const isJwt = (token) => typeof token === 'string' && token.split('.').length === 3;

const failures = [];
export function check(label, ok, detail) {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? `: ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

export function finish(name) {
  log(failures.length ? `${failures.length} failed` : `${name} passed`);
  process.exit(failures.length ? 1 : 0);
}

/** A fresh browser with a platform passkey authenticator, as a user's own device has. */
export async function passkeyBrowser() {
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
  return { browser, page };
}

export async function describePage(page, error) {
  log(`browser step failed: ${error.message.split('\n')[0]}`);
  log(
    `  at ${page.url()}\n${await page
      .locator('body')
      .ariaSnapshot()
      .catch(() => '')}`,
  );
}
