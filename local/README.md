# Run the OpenID Provider on your laptop

From nothing to a passkey sign-in on the hosted page and a JWT access token for your own API, on
one page. You need Docker with Compose, and Node 22 or newer for the two small client scripts.

```
sign-in.mjs (your native app) ─► https://auth.myapp.localhost:9443 ─ Caddy ─► edge ─► API ─► Postgres
backend-token.mjs (your backend) ──┘                                                  │
                                                       mailbox, in place of SES ◄─────┘
```

The checks a deployment has to meet stay on: the API and the edge both run with
`NODE_ENV=production`, the issuer is https and differs from the API's `ISSUER`, its host sits
under `rpid`, provider cookies are `__Host-` and `Secure`, and the per-route sign-in rate limits apply. The recipe meets
those checks locally rather than relaxing them. Three things differ from a deployment: the certificate
authority (Caddy's own), the mailbox in place of SES, and a higher overall per-address request
budget (`RATE_LIMIT` and `DELAY_AFTER` in [`compose.yaml`](compose.yaml), which explains why).

## 1. Start it

```bash
local/up.sh
```

The first run takes a few minutes, because it builds the API (see
[Unreleased API](#unreleased-api)). It stops and tells you if a port is taken: change `TLS_PORT`,
`API_PORT` or `MAILBOX_PORT` in `local/settings.env`, which it creates from
[`settings.env.example`](settings.env.example). `APP_NAME` there sets the hostnames.

| Step                   | What happens                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Secrets                | Generated once into `local/.generated/`, which git ignores: the API's and the provider's signing keys, `SEAMLESS_OIDC_SERVICE_TOKEN`, cookie keys, the database password.                                    |
| Stack                  | Postgres, the API, then the seed, then the edge behind Caddy. Postgres has no host port, and the edge is reachable only through Caddy. The API is on `127.0.0.1:<API_PORT>` for your backends.               |
| [Seed](stack/seed.mjs) | Signs in as the owner through the API, steps up with TOTP, sets `oidc_issuer`, turns `oidc_provider_enabled` on, and registers the records below. Rerunning `local/up.sh` runs it again and changes nothing. |

The seed writes the ids to `local/.generated/recipe.json`:

| Record         | Default name                  | What it is                                                                                                                                                 |
| -------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native client  | `myapp desktop app`           | Public, PKCE, loopback redirect (`http://127.0.0.1/callback` on any port, RFC 8252)                                                                        |
| Backend client | `myapp backend`               | Confidential, `private_key_jwt`, `client_credentials`. Its private key is `local/.generated/backend-key.json`                                              |
| Resource       | `https://api.myapp.localhost` | Your API, with the scopes `notes:read` and `notes:write`. Both clients are allowed it                                                                      |
| Link           | backend to native client      | The backend acts for the native client ([ADR 0002 N4](https://github.com/fells-code/seamless-auth-api/blob/main/docs/adr/0002-native-and-desktop-apps.md)) |

## 2. Trust the local CA

Passkeys refuse a page with a certificate error, so clicking through the browser's warning does
not work. `local/up.sh` copies Caddy's root certificate to `local/.generated/ca.crt`. Check it from
a terminal first, with no change to your machine:

```bash
curl --cacert local/.generated/ca.crt https://auth.myapp.localhost:9443/.well-known/openid-configuration
```

To sign in from your own browser, trust it. This is your decision and the recipe never does it for
you. The key signs only what this stack's Caddy signs, but anyone holding it could impersonate any
site to your browser, so remove it when you finish.

- **macOS:**
  ```bash
  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain local/.generated/ca.crt
  # To remove it:
  sudo security remove-trusted-cert -d local/.generated/ca.crt
  ```
- **Debian or Ubuntu:**
  ```bash
  sudo cp local/.generated/ca.crt /usr/local/share/ca-certificates/seamless-local.crt && sudo update-ca-certificates
  # To remove it:
  sudo rm /usr/local/share/ca-certificates/seamless-local.crt && sudo update-ca-certificates --fresh
  ```
- **Firefox** keeps its own list: Settings, Privacy & Security, Certificates, View Certificates,
  Authorities, Import.

Browsers need a restart to notice. `*.localhost` needs no `/etc/hosts` entry: it is loopback by
definition (RFC 6761). `local/down.sh --wipe` makes a new CA next time, so trust the new one and
remove the old one.

## 3. Sign in with a passkey

```bash
node local/sign-in.mjs
```

This is a native app's side of the flow: it listens on a free loopback port and prints the
authorization URL with PKCE and `resource`. Open that URL.

1. The hosted page asks for an email address. Any address works, such as `you@myapp.localhost`.
2. Read the code at `http://127.0.0.1:9025` (the mailbox) and enter it.
3. Create the passkey when the page asks.
4. Save the recovery codes, confirm, and approve the app's access.

The browser returns to the loopback listener, and the script prints the access token with its
claims, after verifying the signature against `/jwks`:

```json
{
  "aud": "https://api.myapp.localhost",
  "client_id": "<the native client>",
  "iss": "https://auth.myapp.localhost:9443",
  "scope": "notes:read notes:write",
  "sub": "<your user>",
  "amr": ["otp"]
}
```

That first session started from an email code, so its token has no `acr`. To see a passkey sign-in,
clear the cookies for `auth.myapp.localhost`, run the script again, and choose "Already have an
account? Sign in". The token now states `"acr": "phr"` (or `phrh`), and `amr` has `swk` or `hwk`.

Your API accepts such a token after these checks: the signature against the JWKS, `typ` of
`at+jwt`, `iss`, `aud` equal to its own resource, `exp`, and `scope`.
[`verifyAccessToken`](lib.mjs) shows them with nothing but Node.

## 4. A token for your backend

```bash
node local/backend-token.mjs
```

The backend client signs an assertion with its key and uses the client credentials grant, naming
the resource. The token's `sub` and `client_id` are the backend itself, and it has no `acr`, `amr`
or `auth_time`.

## From your own code

|                                | Where                                                                |
| ------------------------------ | -------------------------------------------------------------------- |
| Issuer, on the host            | `https://auth.myapp.localhost:9443`, with `local/.generated/ca.crt`  |
| Issuer, from a compose service | Same URL, on the project's network: Caddy holds the name as an alias |
| API, for a backend on the host | `http://127.0.0.1:9312`                                              |

Node reads a CA from `NODE_EXTRA_CA_CERTS`. Some resolvers answer `::1` first for `*.localhost`,
and the stack publishes on `127.0.0.1` only, so a client without address fallback should connect to
`127.0.0.1` with the hostname as the TLS server name, as [`lib.mjs`](lib.mjs) does.

## Check it

```bash
node local/smoke.mjs
(cd local && npm ci && npx playwright install chromium)
node local/passkey-sign-in.mjs
```

[`smoke.mjs`](smoke.mjs) checks health, discovery and JWKS over TLS against the CA, production
mode, `__Host-` cookies, the hosted page, a verified client credentials token, and that a second
seed changes nothing. [`passkey-sign-in.mjs`](passkey-sign-in.mjs) performs steps 3 and 4 of this
page in Chromium with a virtual authenticator, including `sign-in.mjs` itself. Chromium takes no CA
file, so it accepts the served certificate by its key hash, after the script checks that
certificate against the CA. [CI](../.github/workflows/local-recipe.yml) runs all of this.

## Stop it

```bash
local/down.sh         # Stops the stack and keeps its data.
local/down.sh --wipe  # Also removes its volumes and local/.generated/: back to nothing.
```

Both act only on this compose project (`COMPOSE_PROJECT_NAME`). Remove the CA from your trust
store yourself.

## Unreleased API

The client link routes are on the API's `main` branch and arrive in API v0.23.0, which is not
published yet. Until then `COMPOSE_FILE` in `settings.env` adds
[`compose.api-source.yaml`](compose.api-source.yaml), which builds the API at a pinned commit. The
edge is the published image. Against the published API v0.22.0, the seed stops at the link and says
why.
