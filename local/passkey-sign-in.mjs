// Walks the one-page recipe's sign-in in a real browser with a virtual authenticator: a new
// account registers a passkey on the hosted page, then signs out and signs in with that passkey,
// and each sign-in ends in a verified JWT access token for the resource. Needs `npm ci` and
// `npx playwright install chromium` here.
import { spawn } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { connect } from 'node:tls';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import {
  call,
  discovery,
  env,
  generatedPath,
  readGenerated,
  recipe,
  startNativeSignIn,
  verifyAccessToken,
} from './lib.mjs';

const { issuer, resource, nativeClientId } = recipe();
const edge = new URL(issuer);
const email = `passkey+${Date.now()}@${env.APP_NAME}.localhost`;
const mailbox = `http://127.0.0.1:${env.MAILBOX_PORT}`;
const shots = process.env.SCREENSHOT_DIR ?? generatedPath('screenshots');
mkdirSync(shots, { recursive: true });

const failures = [];
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? `: ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

// Chromium takes no CA file, so it is told to accept the certificate the edge serves, after that
// certificate is checked against the local CA here. WebAuthn refuses a page with a certificate
// error, so ignoring errors altogether would not do.
const servedKeyHash = () =>
  new Promise((resolve, reject) => {
    const socket = connect(
      {
        host: '127.0.0.1',
        port: Number(edge.port),
        servername: edge.hostname,
        ca: readGenerated('ca.crt'),
      },
      () => {
        const der = new X509Certificate(socket.getPeerCertificate().raw).publicKey.export({
          type: 'spki',
          format: 'der',
        });
        socket.end();
        resolve(createHash('sha256').update(der).digest('base64'));
      },
    );
    socket.on('error', reject);
  });

const browser = await chromium.launch({
  args: [`--ignore-certificate-errors-spki-list=${await servedKeyHash()}`],
});
const context = await browser.newContext();
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

async function nextCode(before) {
  for (let i = 0; i < 60; i += 1) {
    const all = await (await fetch(`${mailbox}/codes/${encodeURIComponent(email)}`)).json();
    if (all.length > before) return all.at(-1);
    await page.waitForTimeout(250);
  }
  throw new Error(`no code reached the mailbox for ${email}`);
}

async function register() {
  await page
    .getByLabel(/email address/i)
    .first()
    .fill(email);
  await page.getByRole('button', { name: /^register$/i }).click();
  await page.waitForURL(/verify-email-otp/);
  const code = await nextCode(0);
  const inputs = page.locator('input');
  if ((await inputs.count()) >= 6) {
    for (let i = 0; i < 6; i += 1) await inputs.nth(i).fill(code[i]);
  } else {
    await inputs.first().fill(code);
  }
  const verify = page.getByRole('button', { name: /verify|continue|submit/i });
  if (await verify.count())
    await verify
      .first()
      .click()
      .catch(() => {});
  await page.waitForURL(/register-passkey/, { timeout: 20_000 });
  await page.screenshot({ path: `${shots}/register-passkey.png` });
  await page
    .getByRole('button', { name: /register|add|create|continue/i })
    .first()
    .click();
  const modalContinue = page.getByRole('button', { name: /^continue$/i });
  await modalContinue
    .waitFor({ timeout: 5000 })
    .then(() => modalContinue.click())
    .catch(() => {});
  await page.waitForURL(/recovery-codes|127\.0\.0\.1/, { timeout: 20_000 });
  if (page.url().includes('recovery-codes')) {
    await page.screenshot({ path: `${shots}/recovery-codes.png` });
    await page.getByLabel(/i have saved/i).check();
    await page.getByRole('button', { name: /^continue$/i }).click();
  }
}

async function signInWithPasskey() {
  const toSignIn = page.getByRole('button', { name: /already have an account/i });
  if (await toSignIn.count()) await toSignIn.click();
  await page.getByLabel(/email address \/ phone number/i).fill(email);
  await page.getByRole('button', { name: /^login$/i }).click();
  const passkey = page.getByRole('button', { name: /passkey/i }).first();
  await passkey
    .waitFor({ timeout: 5000 })
    .then(() => passkey.click())
    .catch(() => {});
}

// First-party apps skip the consent screen unless a page asks; press whatever the hosted page
// offers until the browser is back on the loopback redirect.
async function finishInteraction() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !page.url().startsWith('http://127.0.0.1')) {
    const allow = page.getByRole('button', { name: /^(allow|continue|accept)/i }).first();
    if (await allow.isEnabled({ timeout: 500 }).catch(() => false)) {
      await page.screenshot({ path: `${shots}/consent.png` });
      await allow.click({ timeout: 2000 }).catch(() => {});
    }
    await page.waitForTimeout(250);
  }
}

async function codeFlow(label, act) {
  const flow = await startNativeSignIn();
  await page.goto(flow.url);
  await page.waitForURL((url) => url.pathname === '/login', { timeout: 15_000 });
  await page.getByRole('heading', { level: 2 }).waitFor({ timeout: 10_000 });
  check(`${label}: the hosted page rendered at ${edge.host}`, page.url().startsWith(issuer));
  await page.screenshot({ path: `${shots}/${label}-hosted-page.png` });
  await act();
  await finishInteraction();
  const tokens = await flow.tokens();
  await page.getByText(/^Signed in\./).waitFor({ timeout: 10_000 });
  check(`${label}: the browser shows the loopback page`, true);
  await page.screenshot({ path: `${shots}/${label}-back-at-app.png` });
  const claims = await verifyAccessToken(tokens.access_token, { audience: resource });
  check(`${label}: the access token verifies against the JWKS`, true);
  check(`${label}: audience is the resource`, claims.aud === resource, claims.aud);
  check(`${label}: issued to the native client`, claims.client_id === nativeClientId);
  console.log(`  ${label} claims: ${JSON.stringify(claims)}`);
  return { tokens, claims };
}

let exitCode = 1;
try {
  const signedUp = await codeFlow('register', register);
  const credentials = await context.cookies();
  check(
    'provider cookies were set in the browser',
    credentials.some((c) => c.name.startsWith('__Host-')),
  );

  // Signing out here means a browser with no session; the authenticator keeps the passkey.
  await context.clearCookies();
  const signedIn = await codeFlow('passkey', signInWithPasskey);
  check(
    'the sign-in used the passkey',
    /swk|hwk/.test(signedIn.claims.amr?.join() ?? ''),
    JSON.stringify(signedIn.claims.amr),
  );
  check('the same account signed in again', signedIn.claims.sub === signedUp.claims.sub);
  check(
    'the token states a phishing-resistant sign-in',
    ['phr', 'phrh'].includes(signedIn.claims.acr),
    String(signedIn.claims.acr),
  );

  const { token_endpoint: tokenEndpoint } = await discovery();
  const refreshed = await call(tokenEndpoint, {
    method: 'POST',
    form: {
      client_id: nativeClientId,
      grant_type: 'refresh_token',
      refresh_token: signedIn.tokens.refresh_token ?? '',
      resource,
    },
  });
  check(
    'the refresh token rotates',
    refreshed.status === 200 && refreshed.json.refresh_token !== signedIn.tokens.refresh_token,
    refreshed.text,
  );

  // The command the page tells a reader to run, on the session this browser now holds.
  const cli = spawn(process.execPath, [fileURLToPath(new URL('./sign-in.mjs', import.meta.url))]);
  let output = '';
  cli.stdout.on('data', (chunk) => (output += chunk));
  cli.stderr.on('data', (chunk) => (output += chunk));
  const exited = new Promise((resolve) => cli.on('exit', resolve));
  while (!/https:\S+/.test(output)) await page.waitForTimeout(100);
  await page.goto(/https:\S+/.exec(output)[0], { waitUntil: 'commit' });
  await finishInteraction();
  await page.screenshot({ path: `${shots}/sign-in-cli.png` });
  check(
    'sign-in.mjs ends with a verified token',
    (await exited) === 0 && output.includes('verifies'),
    output,
  );

  exitCode = failures.length ? 1 : 0;
  console.log(failures.length ? `${failures.length} failed` : 'passkey sign-in passed');
} catch (error) {
  console.log(`browser step failed: ${error.message.split('\n')[0]}`);
  console.log(`  at ${page.url()}`);
  await page.screenshot({ path: `${shots}/failure.png` }).catch(() => {});
  console.log(
    await page
      .locator('body')
      .ariaSnapshot()
      .catch(() => ''),
  );
} finally {
  await browser.close();
}
process.exit(exitCode);
