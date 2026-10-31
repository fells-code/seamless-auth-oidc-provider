# Seamless Auth OpenID Provider

The OpenID Provider for [Seamless Auth](https://seamlessauth.com). Any app that speaks OpenID
Connect (Grafana, GitLab, Argo CD, Auth.js and the rest) can sign users in with Seamless Auth
through this service, with no Seamless SDK.

It is the public "login edge" in front of a private Seamless Auth API:

```
any OIDC app ──► seamless-auth-oidc-provider (public: OIDC endpoints, hosted pages, cookies)
                      │   service token, like any adapter
                      ▼
               Seamless Auth API (private, no cookies) ── Postgres
```

- Built on [`oidc-provider`](https://github.com/panva/node-oidc-provider) 9.x.
- Holds no private keys and no database. The API signs every token after checking its claims,
  and stores all provider state.
- Code flow with PKCE only, refresh rotation always on, `private_key_jwt` for confidential
  clients.

The design is in
[ADR 0001](https://github.com/fells-code/seamless-auth-api/blob/main/docs/adr/0001-openid-provider.md).

> **Status:** under construction for Seamless Auth v0.21. Discovery, the authorization code
> flow with PKCE, userinfo and the hosted login and consent pages work. The remaining grants
> land in the open [issues](https://github.com/fells-code/seamless-auth-oidc-provider/issues).

## Requirements

- Node 22 or newer.
- A Seamless Auth API with the provider enabled (`oidc_provider_enabled`), `oidc_issuer` set
  to this service's public URL, and the provider signing keys (`OIDC_JWKS_*`) configured.
- This service's hostname must be the API's `rpid` or a subdomain of it, so passkeys work on the
  hosted pages.
- HTTPS. Provider cookies are `__Host-` cookies, which browsers only accept over TLS.

## Run the image

```bash
docker run -p 5314:5314 --env-file .env ghcr.io/fells-code/seamless-auth-oidc-provider:latest
```

## Configuration

| Variable                      | Required | Description                                                                                                                                                                                            |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SEAMLESS_API_URL`            | yes      | The private API, as this service reaches it.                                                                                                                                                           |
| `SEAMLESS_API_ISSUER`         | no       | The API's `ISSUER`, when it differs from `SEAMLESS_API_URL`.                                                                                                                                           |
| `SEAMLESS_OIDC_SERVICE_TOKEN` | yes      | This service's own service token secret, `SEAMLESS_OIDC_SERVICE_TOKEN` on the API. It must differ from the adapters' `SEAMLESS_SERVICE_TOKEN`, which this service never holds. At least 32 characters. |
| `SEAMLESS_JWKS_KID`           | no       | The `kid` on the service tokens this service signs.                                                                                                                                                    |
| `SEAMLESS_COOKIE_SECRET`      | yes      | Signs the first-party session cookies. At least 32 characters.                                                                                                                                         |
| `OIDC_COOKIE_KEYS`            | yes      | Comma-separated provider cookie keys. The first signs, the rest verify.                                                                                                                                |
| `TRUST_PROXY`                 | no       | `true` when TLS ends at a proxy in front of this service.                                                                                                                                              |
| `PORT`                        | no       | Defaults to `5314`.                                                                                                                                                                                    |

The issuer comes from the API (`oidc_issuer`), not from this service's environment. The service
answers only requests for the issuer's own scheme and host, and refuses to start when the API
has the provider disabled or speaks a different version of the `/oidc/*` contract.

## Endpoints

| Path                                | What                                               |
| ----------------------------------- | -------------------------------------------------- |
| `/.well-known/openid-configuration` | Discovery                                          |
| `/authorize`, `/token`, `/userinfo` | Authorization code with PKCE, and userinfo         |
| `/jwks`                             | The provider's public keys, read from the API      |
| `/auth/*`                           | This service's first-party adapter, for the pages  |
| `GET /interaction/:uid/details`     | What the current interaction needs, for the pages  |
| `POST /interaction/:uid/login`      | Finishes login with the page's first-party session |
| `POST /interaction/:uid/consent`    | Grants what the client asked for                   |
| `POST /interaction/:uid/abort`      | Returns `access_denied` to the client              |

The interaction routes are for the hosted pages only. A state change needs `Sec-Fetch-Site:
same-origin` or an `Origin` equal to the issuer's, so a page on a sibling subdomain cannot
drive them.

## Hosted pages

The login and consent pages are a SPA in `ui/`, built on `@seamless-auth/react` and shipped
in `dist/ui`. They sign users in through this service's own adapter routes (`/auth/*`), the
same way any Seamless app does, then finish the OIDC interaction.

- **Methods.** Every method the API has enabled in `login_methods`, through the SDK's bundled
  screens. A recovery session goes to enrollment before it can finish a sign-in.
- **Consent.** First-party clients have consent implied. Third-party clients see the client
  name, the host they are sent back to and the requested scopes, on every authorization.
- **Branding.** The app name comes from the API's config each time a page is served, so a
  config change needs no build and no restart.
- **Headers.** A strict CSP (`script-src 'self'`, styles from this origin or with the
  response's nonce, `frame-ancestors 'none'`), `no-store`, `nosniff` and `no-referrer`.

Every cookie this service sets is `__Host-` (host-only, `Secure`, `Path=/`), so serve it over
HTTPS, including in development: the library refuses to set a `Secure` cookie on a plain
HTTP request.

## Embed in an Express app

```ts
import express from 'express';
import { createOidcEdge } from '@seamless-auth/oidc-provider';

const edge = await createOidcEdge({
  apiUrl: process.env.SEAMLESS_API_URL!,
  serviceSecret: process.env.SEAMLESS_OIDC_SERVICE_TOKEN!,
  cookieKeys: process.env.OIDC_COOKIE_KEYS!.split(','),
  adapterCookieSecret: process.env.SEAMLESS_COOKIE_SECRET!,
  trustProxy: true,
});

const app = express();
app.set('trust proxy', 1);
app.use(edge.router);
app.listen(5314);
```

Mount `edge.router` at the root of the app that serves the issuer's origin.

## Development

```bash
nvm use
npm ci
npm run typecheck && npm run lint && npm run format:check && npm run coverage && npm run build
```

See [AGENTS.md](AGENTS.md) for the repo's standards and [RELEASES.md](RELEASES.md) for releases.

## License

Apache-2.0. See [LICENSE](LICENSE).
