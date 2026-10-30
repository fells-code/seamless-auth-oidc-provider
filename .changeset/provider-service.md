---
'@seamless-auth/oidc-provider': minor
---

First release of the Seamless Auth OpenID Provider service, on `oidc-provider` 9.13 and `@seamless-auth/express`. It stores every provider model through the API's `/oidc/payloads/*` routes, reads clients from the API's registry, and signs every token through `POST /oidc/sign`, so it holds no private key and no database. The configuration is locked to the code flow with PKCE for every client, refresh rotation, no dev interactions and no dynamic registration. At startup it checks `GET /oidc/config` and refuses to run when the API has the provider disabled or speaks a different `/oidc/*` contract version. It answers only requests for the issuer's own origin. Ships as a Docker image and as an npm package that exports `createOidcEdge` for mounting into an Express app.

Requires a Seamless Auth API with the v0.21 `/oidc/*` routes and `@seamless-auth/types` 0.34.0.
