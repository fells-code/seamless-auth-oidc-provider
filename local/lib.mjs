// What the scripts here share: HTTPS to the edge with the local CA, the sign-in a native app
// performs, the assertion a backend client signs, and verifying what comes back. Node only, so
// the recipe needs nothing installed for these. Your own code would use an OAuth library.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { fileURLToPath } from 'node:url';

const generated = new URL('./.generated/', import.meta.url);

export const readGenerated = (name) => readFileSync(new URL(name, generated), 'utf8');
export const generatedPath = (name) => fileURLToPath(new URL(name, generated));
export const env = Object.fromEntries(
  readFileSync(new URL('./settings.env', import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => /^[A-Z_]+=/.test(line))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
);
export const recipe = () => JSON.parse(readGenerated('recipe.json'));

// *.localhost is loopback (RFC 6761), and the stack publishes on 127.0.0.1 only, while some
// resolvers answer ::1 first.
const loopback = (_host, options, callback) =>
  options.all
    ? callback(null, [{ address: '127.0.0.1', family: 4 }])
    : callback(null, '127.0.0.1', 4);

/** A plain HTTP(S) call that trusts only the local CA. Follows no redirects. */
export function call(url, { method = 'GET', headers = {}, form } = {}) {
  const target = new URL(url);
  const secure = target.protocol === 'https:';
  const body = form ? new URLSearchParams(form).toString() : undefined;
  return new Promise((resolve, reject) => {
    const req = (secure ? httpsRequest : httpRequest)(
      target,
      {
        method,
        lookup: loopback,
        ...(secure ? { ca: readGenerated('ca.crt') } : {}),
        headers: {
          ...headers,
          ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => {
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

export async function discovery() {
  const { issuer } = recipe();
  return (await call(`${issuer}/.well-known/openid-configuration`)).json;
}

export const claimsOf = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());

/** What a resource server does with a token: signature against the JWKS, then its own claims. */
export async function verifyAccessToken(jwt, { audience }) {
  const { issuer, jwks_uri: jwksUri } = await discovery();
  const [header, payload, signature] = jwt.split('.');
  const { kid, alg, typ } = JSON.parse(Buffer.from(header, 'base64url').toString());
  if (typ !== 'at+jwt') throw new Error(`typ is ${typ}, expected at+jwt (RFC 9068)`);
  if (alg !== 'RS256') throw new Error(`unexpected alg ${alg}`);
  const jwk = (await call(jwksUri)).json.keys.find((key) => key.kid === kid);
  if (!jwk) throw new Error(`kid ${kid} is not in the JWKS`);
  const valid = verify(
    'RSA-SHA256',
    Buffer.from(`${header}.${payload}`),
    createPublicKey({ key: jwk, format: 'jwk' }),
    Buffer.from(signature, 'base64url'),
  );
  if (!valid) throw new Error('signature does not verify');
  const claims = claimsOf(jwt);
  if (claims.iss !== issuer) throw new Error(`iss is ${claims.iss}`);
  if (claims.aud !== audience) throw new Error(`aud is ${claims.aud}`);
  if (claims.exp * 1000 <= Date.now()) throw new Error('expired');
  return claims;
}

/** A client assertion (RFC 7523) signed with the backend's key, for private_key_jwt. */
export function backendClientAuth(clientId, issuer) {
  const key = JSON.parse(readGenerated('backend-key.json'));
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const signingInput = `${encode({ alg: 'RS256', kid: key.kid })}.${encode({
    iss: clientId,
    sub: clientId,
    aud: issuer,
    jti: randomBytes(16).toString('hex'),
    iat: now,
    exp: now + 60,
  })}`;
  const signature = sign(
    'RSA-SHA256',
    Buffer.from(signingInput),
    createPrivateKey({ key, format: 'jwk' }),
  );
  return {
    client_id: clientId,
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: `${signingInput}.${signature.toString('base64url')}`,
  };
}

/** A token for the backend itself: the client credentials grant, for its own resource. */
export async function backendToken(resource = recipe().resource) {
  const { issuer, backendClientId, scopes } = recipe();
  const { token_endpoint: tokenEndpoint } = await discovery();
  return call(tokenEndpoint, {
    method: 'POST',
    form: {
      ...backendClientAuth(backendClientId, issuer),
      grant_type: 'client_credentials',
      resource,
      scope: scopes.join(' '),
    },
  });
}

/**
 * The sign-in a native app performs (RFC 8252): a listener on a free loopback port, PKCE, the
 * hosted page in a browser, then the code for tokens.
 */
export async function startNativeSignIn({ extra = {} } = {}) {
  const { nativeClientId, resource, scopes } = recipe();
  const config = await discovery();
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(16).toString('base64url');

  let finish;
  let fail;
  const code = new Promise((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });

  const listener = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end('Signed in. You can close this tab and go back to your terminal.\n');
    if (url.searchParams.get('state') !== state) {
      fail(new Error('state does not match'));
    } else if (url.searchParams.get('error')) {
      fail(
        new Error(`${url.searchParams.get('error')}: ${url.searchParams.get('error_description')}`),
      );
    } else {
      finish(url.searchParams.get('code'));
    }
  });
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const redirectUri = `http://127.0.0.1:${listener.address().port}/callback`;

  const authorize = new URL(config.authorization_endpoint);
  authorize.search = new URLSearchParams({
    client_id: nativeClientId,
    response_type: 'code',
    scope: `openid email offline_access ${scopes.join(' ')}`,
    redirect_uri: redirectUri,
    resource,
    prompt: 'consent',
    state,
    nonce: randomBytes(16).toString('base64url'),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    ...extra,
  }).toString();

  return {
    url: authorize.href,
    close: () => listener.close(),
    /** Waits for the redirect back, then exchanges the code. */
    async tokens() {
      try {
        const res = await call(config.token_endpoint, {
          method: 'POST',
          form: {
            client_id: nativeClientId,
            grant_type: 'authorization_code',
            code: await code,
            redirect_uri: redirectUri,
            code_verifier: verifier,
            resource,
          },
        });
        if (res.status !== 200) throw new Error(`token endpoint: ${res.status} ${res.text}`);
        return res.json;
      } finally {
        listener.close();
      }
    },
  };
}
