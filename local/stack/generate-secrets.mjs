// Writes the secrets the stack reads to a directory that git ignores. Each is generated once:
// the database holds data under the provider keys and the TOTP key, so a new set needs a new
// database (./down.sh --wipe).
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? '/generated';
const apiEnv = join(dir, 'api.env');

if (existsSync(apiEnv)) {
  console.log('secrets already generated');
  process.exit(0);
}

const secret = () => randomBytes(32).toString('hex');
const rsa = () => generateKeyPairSync('rsa', { modulusLength: 2048 });
const line = (name, value) => `${name}='${value}'\n`;
const write = (path, content) => writeFileSync(path, content, { mode: 0o600 });

const stamp = Date.now().toString(36);
const firstPartyKid = `local${stamp}`;
const providerKid = `provider-${stamp}`;
const firstParty = rsa();
const provider = rsa();
const dbPassword = secret();
const oidcServiceToken = secret();

write(join(dir, 'postgres.env'), line('POSTGRES_PASSWORD', dbPassword));
write(
  join(dir, 'edge.env'),
  line('SEAMLESS_OIDC_SERVICE_TOKEN', oidcServiceToken) +
    line('SEAMLESS_COOKIE_SECRET', secret()) +
    line('OIDC_COOKIE_KEYS', secret()),
);

const publicPem = firstParty.publicKey.export({ type: 'spki', format: 'pem' });
const privatePem = firstParty.privateKey.export({ type: 'pkcs8', format: 'pem' });

// Written last: its presence means the set is complete.
write(
  apiEnv,
  line('DB_PASSWORD', dbPassword) +
    line('SEAMLESS_SERVICE_TOKEN', secret()) +
    line('SEAMLESS_OIDC_SERVICE_TOKEN', oidcServiceToken) +
    line('REFRESH_TOKEN_LOOKUP_SECRET', secret()) +
    line('DECOY_SUBJECT_SECRET', secret()) +
    line('TOTP_SECRET_ENCRYPTION_KEY', secret()) +
    line('OAUTH_STATE_SECRET', secret()) +
    line('SEAMLESS_JWKS_ACTIVE_KID', firstPartyKid) +
    line(
      'SEAMLESS_JWKS_PUBLIC_KEYS',
      JSON.stringify({ keys: [{ kid: firstPartyKid, pem: publicPem }] }),
    ) +
    // Compose's env_file reader keeps single-quoted text as it is, line breaks included.
    line(`SEAMLESS_JWKS_KEY_${firstPartyKid}_PRIVATE`, privatePem) +
    line('OIDC_JWKS_ACTIVE_KID', providerKid) +
    line(
      'OIDC_JWKS_KEYS',
      JSON.stringify({
        keys: [{ ...provider.privateKey.export({ format: 'jwk' }), kid: providerKid }],
      }),
    ),
);
console.log(`secrets written to ${dir}`);
