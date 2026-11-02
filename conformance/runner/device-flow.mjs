// The device grant end to end against the real API, which the conformance suite has no plan
// for: a device asks for openid and a resource, a browser approves it with a passkey, and the
// device's tokens must state no assurance (ADR 0001 D10), which the API refuses to sign
// otherwise.
import { signIn } from './browser.mjs';
import {
  ASSURANCE,
  check,
  claimsOf,
  describePage,
  finish,
  isJwt,
  passkeyBrowser,
  post,
  runDir,
  sleep,
} from './edge-checks.mjs';

const clientId = 'conformance-device';
const resource = 'https://api.seamless.test';
const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

function checkNoAssurance(label, tokens) {
  for (const [name, jwt] of [
    ['ID token', tokens.id_token],
    ['access token', tokens.access_token],
  ]) {
    if (!isJwt(jwt)) continue;
    const present = ASSURANCE.filter((claim) => claim in claimsOf(jwt));
    check(`${label}: ${name} states no assurance`, present.length === 0, present.join(', '));
  }
}

const authorization = await post('/device/auth', {
  client_id: clientId,
  scope: 'openid email offline_access library:read',
  resource,
});
check('device authorization', authorization.status === 200, authorization.body.error);
const { device_code: deviceCode, verification_uri_complete: verificationUri } = authorization.body;

const { browser, page } = await passkeyBrowser();
const account = { email: `device+${Date.now()}@seamless.test`, credential: null };

await page.goto(verificationUri);
await page.getByRole('button', { name: /^continue$/i }).click();
await page.waitForURL((url) => url.pathname !== '/device', { timeout: 15_000 });
await signIn({ page }, page.url(), account, `${runDir}/device-flow.png`).catch((error) =>
  describePage(page, error),
);
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
check('a JWT access token for the resource', isJwt(tokens.body.access_token));
checkNoAssurance('device grant', tokens.body);

const refreshed = await post('/token', {
  client_id: clientId,
  grant_type: 'refresh_token',
  refresh_token: tokens.body.refresh_token,
});
check('refresh response', refreshed.status === 200, refreshed.body.error);
checkNoAssurance('refresh', refreshed.body);

finish('device flow');
