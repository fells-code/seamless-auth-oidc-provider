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

// Only the back-channel plan's clients get a logout URI: the API posts to it whenever a
// session ends, and a module of another plan answers an unexpected call by failing.
const withBackchannel = (alias) => ({
  ...endpoints(alias),
  backchannelLogoutUri: `${suiteBase}/test/a/${alias}/backchannel_logout`,
});

const clients = [];
const configs = {};

// The OIDCC plans send neither code_challenge nor, in one module, nonce, so the suite's
// clients use the per-application opt-out. conformance-pkce keeps both requirements.
function secretClient(
  id,
  alias,
  method = 'client_secret_basic',
  optOut = true,
  uris = endpoints(alias),
) {
  const secret = randomBytes(24).toString('base64url');
  clients.push({ id, method, secret, optOut, ...uris });
  return { client_id: id, client_secret: secret };
}

function keyClient(id, alias) {
  const key = rsaJwk(`${id}-key`);
  clients.push({
    id,
    method: 'private_key_jwt',
    optOut: true,
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

secretClient('conformance-pkce', 'seamless-basic', 'client_secret_basic', false);

const backchannelAlias = 'seamless-backchannel';
const backchannelClient = (id) =>
  secretClient(
    id,
    backchannelAlias,
    'client_secret_basic',
    true,
    withBackchannel(backchannelAlias),
  );

configs['backchannel'] = {
  alias: backchannelAlias,
  description: 'Seamless OpenID Provider, back-channel logout',
  server,
  client: backchannelClient('conformance-backchannel-1'),
  client2: backchannelClient('conformance-backchannel-2'),
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
  ) => `INSERT INTO oidc_clients (id, name, "firstParty", "clientType", "tokenEndpointAuthMethod", jwks, "secretLookup", "redirectUris", "postLogoutRedirectUris", "backchannelLogoutUri", "grantTypes", "createdAt", "updatedAt")
VALUES (${sql(c.id)}, ${sql(c.id)}, true, 'confidential', ${sql(c.method)}, ${c.jwks ? json(c.jwks) : 'NULL'}, ${sql(c.secret ? secretLookup(c.secret) : null)}, ${json(c.redirectUris)}, ${json(c.postLogoutRedirectUris)}, ${sql(c.backchannelLogoutUri)}, ${json(['authorization_code', 'refresh_token'])}, now(), now())
ON CONFLICT (id) DO UPDATE SET jwks = EXCLUDED.jwks, "secretLookup" = EXCLUDED."secretLookup", "redirectUris" = EXCLUDED."redirectUris", "postLogoutRedirectUris" = EXCLUDED."postLogoutRedirectUris", "backchannelLogoutUri" = EXCLUDED."backchannelLogoutUri", "tokenEndpointAuthMethod" = EXCLUDED."tokenEndpointAuthMethod";`,
);

// For runner/device-flow.mjs. The API grants the device flow to first-party clients only.
statements.push(`INSERT INTO oidc_clients (id, name, "firstParty", "clientType", "tokenEndpointAuthMethod", "redirectUris", "postLogoutRedirectUris", "grantTypes", "deviceFlowEnabled", "createdAt", "updatedAt")
VALUES ('conformance-device', 'Conformance Device', true, 'public', 'none', '[]', '[]', ${json(['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'])}, true, now(), now())
ON CONFLICT (id) DO NOTHING;`);

// For runner/resource-token.mjs: a public app with a resource, which the device client may use too.
statements.push(`INSERT INTO oidc_clients (id, name, "firstParty", "clientType", "tokenEndpointAuthMethod", "redirectUris", "postLogoutRedirectUris", "grantTypes", "createdAt", "updatedAt")
VALUES ('conformance-resource', 'Conformance Resource', true, 'public', 'none', ${json(['https://app.seamless.test/callback'])}, '[]', ${json(['authorization_code', 'refresh_token'])}, now(), now())
ON CONFLICT (id) DO NOTHING;
INSERT INTO oidc_resources (id, identifier, name, scopes, "createdAt", "updatedAt")
VALUES (gen_random_uuid(), 'https://api.seamless.test', 'Conformance API', ${json(['library:read'])}, now(), now())
ON CONFLICT (identifier) DO NOTHING;
INSERT INTO oidc_client_resources (id, "clientId", "resourceId", scopes, "createdAt", "updatedAt")
SELECT gen_random_uuid(), c.id, r.id, ${json(['library:read'])}, now(), now()
FROM oidc_clients c, oidc_resources r
WHERE c.id IN ('conformance-resource', 'conformance-device') AND r.identifier = 'https://api.seamless.test'
ON CONFLICT ("clientId", "resourceId") DO NOTHING;`);

// An API without the opt-out has no such columns, and then every client requires PKCE.
const optedOut = clients.filter((c) => c.optOut).map((c) => sql(c.id));
statements.push(`DO $$ BEGIN
IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'oidc_clients' AND column_name = 'pkceRequired') THEN
  UPDATE oidc_clients SET "pkceRequired" = false, "nonceRequired" = false WHERE id IN (${optedOut.join(', ')});
END IF;
END $$;`);

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
