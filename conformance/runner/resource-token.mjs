// A user's access token for a resource against the real API (ADR 0002 N7): the RFC 9068 JWT
// carries the session's acr, amr and auth_time, the values the ID token states, introspection
// returns them, and a refresh carries them again. The API signs only the session's own values.
import { createHash, randomBytes } from 'node:crypto';

import { signIn } from './browser.mjs';
import {
  ASSURANCE,
  check,
  claimsOf,
  describePage,
  finish,
  isJwt,
  issuer,
  passkeyBrowser,
  post,
  runDir,
} from './edge-checks.mjs';

const clientId = 'conformance-resource';
const resource = 'https://api.seamless.test';
const redirectUri = 'https://app.seamless.test/callback';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function checkAssurance(label, tokens) {
  check(`${label}: a JWT access token for the resource`, isJwt(tokens.access_token));
  if (!isJwt(tokens.access_token) || !isJwt(tokens.id_token)) return;
  const access = claimsOf(tokens.access_token);
  const id = claimsOf(tokens.id_token);
  check(`${label}: audience is the resource`, access.aud === resource, access.aud);
  check(
    `${label}: amr and auth_time present`,
    Array.isArray(access.amr) && typeof access.auth_time === 'number',
    ASSURANCE.filter((claim) => !(claim in access)).join(', '),
  );
  for (const claim of ASSURANCE) {
    check(
      `${label}: ${claim} matches the ID token`,
      same(access[claim], id[claim]),
      `${JSON.stringify(access[claim])} vs ${JSON.stringify(id[claim])}`,
    );
  }
}

const { browser, page } = await passkeyBrowser();
let callback;
// The app's host does not resolve; the redirect to it is all this needs.
page.on('request', (request) => {
  if (request.url().startsWith(redirectUri)) callback = new URL(request.url());
});
const account = { email: `resource+${Date.now()}@seamless.test`, credential: null };

async function codeFlow(label, extra) {
  callback = undefined;
  const verifier = randomBytes(32).toString('base64url');
  const authorize = new URL('/authorize', issuer);
  authorize.search = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    scope: 'openid email offline_access library:read',
    redirect_uri: redirectUri,
    resource,
    prompt: 'consent',
    state: randomBytes(16).toString('base64url'),
    nonce: randomBytes(16).toString('base64url'),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    ...extra,
  }).toString();
  await signIn({ page }, authorize.href, account, `${runDir}/resource-token-${label}.png`).catch(
    (error) => describePage(page, error),
  );
  account.credential = true;
  const code = callback?.searchParams.get('code');
  check(`${label}: authorization code`, Boolean(code), callback?.searchParams.get('error'));
  const tokens = await post('/token', {
    client_id: clientId,
    grant_type: 'authorization_code',
    code: code ?? '',
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  check(`${label}: token response`, tokens.status === 200, tokens.body.error);
  checkAssurance(label, tokens.body);
  return tokens.body;
}

// The account registers with an email code, so its first session has amr but no acr.
const first = await codeFlow('sign-up', {});

const introspected = await post('/token/introspection', {
  client_id: clientId,
  token: first.access_token ?? '',
});
check('introspection', introspected.body.active === true, introspected.body.error);
if (isJwt(first.access_token)) {
  const access = claimsOf(first.access_token);
  for (const claim of ASSURANCE) {
    check(`introspection: ${claim}`, same(introspected.body[claim], access[claim]));
  }
}

// A route that needs a phishing-resistant sign-in: the passkey step-up gives the session an
// acr, which the access token states.
const stepped = await codeFlow('step-up', { acr_values: 'phr' });
await browser.close();
if (isJwt(stepped.access_token)) {
  const access = claimsOf(stepped.access_token);
  check(
    'step-up: acr is phr or stronger',
    ['phr', 'phrh'].includes(access.acr),
    String(access.acr),
  );
}

const refreshed = await post('/token', {
  client_id: clientId,
  grant_type: 'refresh_token',
  refresh_token: stepped.refresh_token ?? '',
});
check('refresh response', refreshed.status === 200, refreshed.body.error);
checkAssurance('refresh', refreshed.body);

finish('resource token');
