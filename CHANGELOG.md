# @seamless-auth/oidc-provider

## 0.1.0

### Minor Changes

- dcf17cc: Sign users in to OIDC apps with the authorization code flow and PKCE, discovery and userinfo. Interactions finish only after a first-party sign-in through this service's own adapter, through four JSON routes the hosted pages call: `GET /interaction/:uid/details`, and `POST /interaction/:uid/login`, `/consent` and `/abort`. The provider grant is saved against the first-party session before its auth context is read, and every stored record and signature names that session, so the API's grant binding holds. ID tokens carry the scope claims plus `acr`, `amr` and `auth_time` from the API.
  
  - A recovery session cannot finish a sign-in, and `prompt=login` or `max_age` refuse a session older than the request.
  - First-party clients have consent implied. Third-party clients do not exist while `third_party_clients_enabled` is off, and see the consent page on every authorization when it is on.
  - The interaction routes refuse a state change unless `Sec-Fetch-Site` is `same-origin` or the `Origin` is the issuer's, so a sibling subdomain cannot drive them.
  
  Needs fells-code/seamless-auth-api#524 for a session signed in to more than one app.
- 1697942: Client authentication per ADR D6. Confidential clients use `private_key_jwt` by default, and each assertion is single-use through the API's replay store (a replay is `invalid_client`, not a 500). Public clients use `none` with PKCE. `client_secret_basic` and `client_secret_post` are offered only when the API allows client secrets (`allow_client_secrets`, read at startup), and only work for clients opted in on the API.
  
  A presented secret is checked with `POST /oidc/clients/:id/verify-secret` before the library runs. When the API accepts it, the request carries a one-time value in its place, and the client's metadata carries that value for that request only, so this service never holds a client's real secret. `client_secret_jwt` and HS* algorithms are never offered.
- 4d9492a: Hosted login and consent pages. A SPA on `@seamless-auth/react`, served by this service at `/interaction/:uid` and the bundled sign-in paths (`/login`, `/verify-email-otp`, `/register-passkey` and the rest), signs users in through this service's own first-party adapter, so every enabled method and every first-party protection applies. It finishes the interaction once the user is signed in, sends a recovery session to enrollment, and has the user sign in again when the app asks for `prompt=login` or `max_age`.
  
  - Third-party clients get a consent page naming the client, the host it sends you back to, and what it asks for.
  - Branding is read from the API's config when a page is served (`app_name` today), with no build step. A config change shows within 30 seconds.
  - Every page gets a strict CSP: scripts from this origin only, styles from this origin or carrying the response's nonce, `frame-ancestors 'none'`, plus `no-store`, `nosniff` and `no-referrer`.
  - The adapter routes under `/auth` now need `Sec-Fetch-Site: same-origin` or the issuer's `Origin` for a state change, like the interaction routes.
  - The resume cookie is now `__Host-oidc_resume` with `Path=/`, and resuming an authorization other than the one it names is refused.
  - The package ships the built pages in `dist/ui`. `createOidcEdge` takes `uiDir` to serve another build.
- a167b9d: The hosted pages take their branding from the API's `hosted_ui` system config, read from `GET /oidc/config` on each page load like `app_name`. `appName` overrides the name, `logoUrl` shows a logo (its origin is added to the page's `img-src`), `colors` and `fontFamily` become CSS variables in a `<style>` carrying the response's nonce. A branded palette replaces the dark palette, since it was chosen against a light page. The bundled sign-in screens now take their accent, text, surface and border colors from the same variables, so branding reaches every screen. Needs `@seamless-auth/types` with `hostedUi` on the config response.
- a6de395: Token introspection (RFC 7662) and revocation (RFC 7009) at `/token/introspection` and `/token/revocation`, listed in discovery.
  
  - A client may introspect its own tokens. A resource server, registered as a confidential application linked to its resource, may introspect tokens whose `aud` is that resource. Every answer comes from the API's store, so a token whose session has ended is inactive at once.
  - JWT access tokens are now stored under their `jti` when issued, so they can be introspected and revoked. A presented JWT is mapped back to its record only after its signature checks out against the provider's keys, and the `jti` alone is not accepted as a token.
  - Revoking a refresh token ends that app's grant and its tokens, not the user's first-party session. Each revocation is recorded in the API's audit log as `token_revoked`.
  - Both endpoints are limited to 1200 requests a minute per client IP, per instance.
- a81ad61: First release of the Seamless Auth OpenID Provider service, on `oidc-provider` 9.13 and `@seamless-auth/express`. It stores every provider model through the API's `/oidc/payloads/*` routes, reads clients from the API's registry, and signs every token through `POST /oidc/sign`, so it holds no private key and no database. The configuration is locked to the code flow with PKCE for every client, refresh rotation, no dev interactions and no dynamic registration. At startup it checks `GET /oidc/config` and refuses to run when the API has the provider disabled or speaks a different `/oidc/*` contract version. It answers only requests for the issuer's own origin. Ships as a Docker image and as an npm package that exports `createOidcEdge` for mounting into an Express app.
  
  Requires a Seamless Auth API with the v0.21 `/oidc/*` routes and `@seamless-auth/types` 0.34.0.
- 45ea34c: Refresh token reuse detection and the client credentials grant.
  
  - A rotated refresh token presented again still revokes the grant, and now also asks the API to end the first-party session it was issued under (`POST /oidc/sessions/:id/revoke`, reason `refresh_token_reuse`).
  - A refresh reads the session's auth context, so the refreshed ID token carries the current `acr`, `amr` and `auth_time`. Before this, any step-up after sign-in made `/oidc/sign` refuse every later refresh.
  - `client_credentials` is on for clients registered for it. The token is an RFC 9068 JWT for a resource (the one named with `resource`, or the client's only linked one, else `invalid_target`), with `sub` and `client_id` set to the client and scopes cut to what it is allowed there.
- 30b4115: Issue access tokens for a named API. With `resource=<identifier>` (RFC 8707) the access token is an RFC 9068 JWT (`typ: at+jwt`) whose `aud` is the resource, carrying only the scopes the application is allowed there and the resource's own lifetime, read from the API's `GET /oidc/clients/:id/resources`. A resource the application is not linked to is refused with `invalid_target`. A resource named once at authorization is used at the token endpoint too. Without `resource`, the access token is the same opaque userinfo token as before. First-party apps have resource scopes granted with the sign-in. The consent page lists them for third-party apps.
  
  Needs fells-code/seamless-auth-api#533 and `@seamless-auth/types` with `OidcEdgeRoutes.clientResources`.
- b3048a8: Honour `acr_values`, `max_age` and `prompt=login` from the API's auth context, with step-up in the hosted pages.
  
  - Every authorization from an existing provider session reads `GET /oidc/sessions/:id/auth-context` and carries the reported `acr`, `amr` and `auth_time` into the tokens, so a step-up made elsewhere shows up on the next authorization and `/oidc/sign` never sees a stale value. A session the API reports as ended or in recovery goes back to sign-in.
  - `acr_values` is met when the session's acr ranks at least the weakest value asked for (`phrh` satisfies `phr`). `max_age` is met by the API's `auth_time`, or an authentication during the request.
  - `POST /interaction/:uid/login` answers `409 { error: 'step_up_required', methods }` instead of `reauthentication_required`. The pages run the step-up through the adapter (`/step-up/webauthn/*`, or `/totp/verify-mfa` for freshness on a session with no acr), then post again with `{ "afterStepUp": true }`. If the requirement is still not met, the client receives `unmet_authentication_requirements`.
  
  Needs fells-code/seamless-auth-api#529.

### Patch Changes

- 1397fcd: Document how the provider meets OAuth 2.1 and RFC 9700 in `docs/oauth-security.md`, with the test behind each row, and cover RFC 8252 native clients (loopback redirects on any port, the IPv6 loopback, private-use schemes, and refusal of any other host, path or scheme). No behaviour change.
