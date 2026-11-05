// Sets the provider up through the API's admin routes, the way an operator would: the owner signs
// in with an email code and steps up with TOTP, because every admin write needs a fresh step-up.
// Then it sets the issuer, turns the provider on, and registers the three records of ADR 0002 N1
// with a link (N4). Safe to rerun: every step reads first and changes only what differs.
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { API_URL, MAILBOX_URL, APP_NAME, TLS_PORT, API_PORT, GENERATED_DIR } = process.env;

const issuer = `https://auth.${APP_NAME}.localhost:${TLS_PORT}`;
const owner = `owner@${APP_NAME}.localhost`;
const statePath = join(GENERATED_DIR, 'seed-state.json');
const backendKeyPath = join(GENERATED_DIR, 'backend-key.json');
const scopes = ['notes:read', 'notes:write'];

const RESOURCE = {
  identifier: `https://api.${APP_NAME}.localhost`,
  name: `${APP_NAME} backend API`,
  scopes,
};
const NATIVE = {
  name: `${APP_NAME} desktop app`,
  clientType: 'public',
  firstParty: true,
  tokenEndpointAuthMethod: 'none',
  // RFC 8252: any port on the loopback IP, in development and in production alike.
  redirectUris: ['http://127.0.0.1/callback'],
  postLogoutRedirectUris: ['http://127.0.0.1/signed-out'],
  grantTypes: ['authorization_code', 'refresh_token'],
};
const backendRecord = (jwks) => ({
  name: `${APP_NAME} backend`,
  clientType: 'confidential',
  firstParty: true,
  tokenEndpointAuthMethod: 'private_key_jwt',
  jwks,
  redirectUris: [],
  grantTypes: ['client_credentials'],
});

const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
const saveState = () => writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = (what, changed) => console.log(`${changed ? 'created' : 'unchanged'}  ${what}`);

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

async function must(method, path, options) {
  const res = await call(method, path, options);
  if (res.status >= 300) {
    throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(res.json)}`);
  }
  return res.json;
}

async function codes() {
  const res = await fetch(`${MAILBOX_URL}/codes/${encodeURIComponent(owner)}`);
  return res.json();
}

async function nextCode(before) {
  for (let i = 0; i < 40; i += 1) {
    const all = await codes();
    if (all.length > before) return all.at(-1);
    await sleep(250);
  }
  throw new Error(`no code reached the mailbox for ${owner}`);
}

// Signs in with an email code, registering the owner the first time. OWNER_EMAIL makes that
// account the admin.
async function signIn() {
  const before = (await codes()).length;
  if (!state.registered) {
    const started = await must('POST', '/registration/register', { body: { email: owner } });
    const done = await must('POST', '/otp/verify-email-otp', {
      token: started.token,
      body: { verificationToken: await nextCode(before) },
    });
    state.registered = true;
    saveState();
    return done.token;
  }
  const started = await must('POST', '/login', { body: { identifier: owner } });
  await must('GET', '/otp/generate-login-email-otp', { token: started.token });
  const done = await must('POST', '/otp/verify-login-email-otp', {
    token: started.token,
    body: { verificationToken: await nextCode(before) },
  });
  return done.token;
}

function base32(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.replace(/=+$/, '').toUpperCase()) {
    bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function totp(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0xf;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

// A code is single use, so a check in the same 30 seconds as the last one waits for the next.
async function freshTotp() {
  const current = () => Math.floor(Date.now() / 30000);
  if (state.lastTotpStep !== undefined && current() <= state.lastTotpStep) {
    await sleep((state.lastTotpStep + 1) * 30000 - Date.now() + 500);
  }
  state.lastTotpStep = current();
  saveState();
  return totp(state.ownerTotpSecret, state.lastTotpStep);
}

async function stepUp(token) {
  if (!state.ownerTotpSecret) {
    const enrollment = await must('POST', '/totp/enroll/start', { token });
    state.ownerTotpSecret = enrollment.secret;
    saveState();
    await must('POST', '/totp/enroll/verify', { token, body: { code: await freshTotp() } });
  }
  await must('POST', '/totp/verify-mfa', { token, body: { code: await freshTotp() } });
}

async function turnProviderOn(token) {
  const config = await must('GET', '/system-config/admin', { token });
  const current = config.config ?? config;
  const on = current.oidc_provider_enabled === true && current.oidc_issuer === issuer;
  report(`provider on, issuer ${issuer}`, !on);
  if (on) return;
  await must('PATCH', '/system-config/admin', {
    token,
    body: { oidc_issuer: issuer, oidc_provider_enabled: true },
  });
}

async function ensureResource(token) {
  const { resources } = await must('GET', '/admin/resources', { token });
  const found = resources.find((r) => r.identifier === RESOURCE.identifier);
  report(`resource ${RESOURCE.identifier}`, !found);
  return found ?? (await must('POST', '/admin/resources', { token, body: RESOURCE })).resource;
}

async function ensureApplication(token, record) {
  const { applications } = await must('GET', '/admin/applications', { token });
  const found = applications.find((a) => a.name === record.name);
  report(`application ${record.name}`, !found);
  return found ?? (await must('POST', '/admin/applications', { token, body: record })).application;
}

// The private key goes to a file git ignores, and only the public half to the registry.
function backendKey() {
  if (existsSync(backendKeyPath)) return JSON.parse(readFileSync(backendKeyPath, 'utf8'));
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = {
    ...privateKey.export({ format: 'jwk' }),
    kid: 'backend-1',
    alg: 'RS256',
    use: 'sig',
  };
  writeFileSync(backendKeyPath, JSON.stringify(key, null, 2), { mode: 0o600 });
  return key;
}

function publicJwks({ kty, n, e, kid, alg, use }) {
  return { keys: [{ kty, n, e, kid, alg, use }] };
}

async function ensureLink(token, backend, native) {
  const listed = await call('GET', `/admin/applications/${backend.id}/links`, { token });
  if (listed.status === 404) {
    throw new Error(
      'This API has no client link routes (ADR 0002 N4). They arrive in API v0.23.0; use an API ' +
        'image built from main until then, which is what compose.api-source.yaml does.',
    );
  }
  if (listed.status >= 300) throw new Error(`list links: ${listed.status}`);
  const found = listed.json.links.some((link) => link.linkedClientId === native.id);
  report(`link ${backend.name} -> ${native.name}`, !found);
  if (found) return;
  await must('PUT', `/admin/applications/${backend.id}/links/${native.id}`, { token });
}

const token = await signIn();
await stepUp(token);
await turnProviderOn(token);
const resource = await ensureResource(token);
const native = await ensureApplication(token, NATIVE);
const backend = await ensureApplication(token, backendRecord(publicJwks(backendKey())));

// PUT replaces the set with itself when nothing changed, so a rerun is a no-op.
for (const app of [native, backend]) {
  await must('PUT', `/admin/applications/${app.id}/resources`, {
    token,
    body: { resources: [{ resourceId: resource.id, scopes }] },
  });
}
await ensureLink(token, backend, native);

writeFileSync(
  join(GENERATED_DIR, 'recipe.json'),
  `${JSON.stringify(
    {
      issuer,
      resource: RESOURCE.identifier,
      scopes,
      nativeClientId: native.id,
      backendClientId: backend.id,
      apiUrl: `http://127.0.0.1:${API_PORT}`,
      mailboxOwner: owner,
    },
    null,
    2,
  )}\n`,
);
console.log('seed finished');
