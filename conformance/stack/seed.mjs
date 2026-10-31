// Registers the suite's clients in the API's registry and writes one suite configuration
// per plan to RUN_DIR/configs. Keys and secrets are generated per run.
import { execFileSync } from 'node:child_process';
import { createHmac, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const runDir = process.env.RUN_DIR;
const pgContainer = process.env.PG_CONTAINER ?? 'seamless-conformance-pg';
const issuer = process.env.ISSUER ?? 'https://op.seamless.test:5321';
const suiteBase = 'https://localhost.emobix.co.uk:8443';
const lookupSecret = /REFRESH_TOKEN_LOOKUP_SECRET=(\S+)/.exec(
  readFileSync(`${runDir}/secrets.env`, 'utf8'),
)[1];

// Same derivation as the API's createOidcClientSecretLookup.
const secretLookup = (secret) =>
  createHmac('sha256', lookupSecret).update(`oidc-client-secret:${secret}`).digest('hex');

function rsaJwk(kid) {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...privateKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  const { kty, n, e } = jwk;
  return { private: jwk, public: { kty, n, e, kid, alg: 'RS256', use: 'sig' } };
}

const endpoints = (alias) => ({
  redirectUris: [
    `${suiteBase}/test/a/${alias}/callback`,
    `${suiteBase}/test/a/${alias}/callback?dummy1=lorem&dummy2=ipsum`,
  ],
  postLogoutRedirectUris: [`${suiteBase}/test/a/${alias}/post_logout_redirect`],
});

const clients = [];
const configs = {};

function secretClient(id, alias, method = 'client_secret_basic') {
  const secret = randomBytes(24).toString('base64url');
  clients.push({ id, method, secret, ...endpoints(alias) });
  return { client_id: id, client_secret: secret };
}

function keyClient(id, alias) {
  const key = rsaJwk(`${id}-key`);
  clients.push({
    id,
    method: 'private_key_jwt',
    jwks: { keys: [key.public] },
    ...endpoints(alias),
  });
  return { client_id: id, jwks: { keys: [key.private] } };
}

const server = { discoveryUrl: `${issuer}/.well-known/openid-configuration` };

configs['basic'] = {
  alias: 'seamless-basic',
  description: 'Seamless OpenID Provider, client_secret_basic',
  server,
  client: secretClient('conformance-basic-1', 'seamless-basic'),
  client2: secretClient('conformance-basic-2', 'seamless-basic'),
  client_secret_post: secretClient(
    'conformance-basic-post',
    'seamless-basic',
    'client_secret_post',
  ),
};

configs['pkjwt'] = {
  alias: 'seamless-pkjwt',
  description: 'Seamless OpenID Provider, private_key_jwt',
  server,
  client: keyClient('conformance-pkjwt-1', 'seamless-pkjwt'),
  client2: keyClient('conformance-pkjwt-2', 'seamless-pkjwt'),
};

configs['config'] = {
  alias: 'seamless-config',
  description: 'Seamless OpenID Provider, discovery',
  server,
};

const sql = (value) => (value == null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`);
const json = (value) => sql(JSON.stringify(value));

const statements = clients.map(
  (
    c,
  ) => `INSERT INTO oidc_clients (id, name, "firstParty", "clientType", "tokenEndpointAuthMethod", jwks, "secretLookup", "redirectUris", "postLogoutRedirectUris", "grantTypes", "createdAt", "updatedAt")
VALUES (${sql(c.id)}, ${sql(c.id)}, true, 'confidential', ${sql(c.method)}, ${c.jwks ? json(c.jwks) : 'NULL'}, ${sql(c.secret ? secretLookup(c.secret) : null)}, ${json(c.redirectUris)}, ${json(c.postLogoutRedirectUris)}, ${json(['authorization_code', 'refresh_token'])}, now(), now())
ON CONFLICT (id) DO UPDATE SET jwks = EXCLUDED.jwks, "secretLookup" = EXCLUDED."secretLookup", "redirectUris" = EXCLUDED."redirectUris", "postLogoutRedirectUris" = EXCLUDED."postLogoutRedirectUris", "tokenEndpointAuthMethod" = EXCLUDED."tokenEndpointAuthMethod";`,
);

execFileSync(
  'docker',
  [
    'exec',
    '-i',
    pgContainer,
    'psql',
    '-q',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    'seamless',
    '-d',
    'seamless',
  ],
  {
    input: statements.join('\n'),
    stdio: ['pipe', 'inherit', 'inherit'],
  },
);

mkdirSync(`${runDir}/configs`, { recursive: true });
for (const [name, config] of Object.entries(configs)) {
  writeFileSync(`${runDir}/configs/${name}.json`, JSON.stringify(config, null, 2));
}
console.log(
  `seeded ${clients.length} clients, wrote ${Object.keys(configs).length} suite configurations`,
);
