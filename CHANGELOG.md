# @seamless-auth/oidc-provider

## 0.4.0

### Minor Changes

- 18b472c: The edge now follows the API's provider key rotation without a restart. It used to load the signing keys once at startup, so after the API rotated its active key every token request failed with `unknown_key` until the edge restarted, and `/jwks` and JWT access token introspection kept the startup keys. It now re-reads the keys every five minutes and at once when the API refuses a key as unknown (at most the request that meets the rotation fails), and `/jwks` serves the current set. Embedders can set the interval with the new `signingKeyRefreshMs` option (`0` turns the timer off). A rotation to a key with a different algorithm is refused with a logged error and still needs a restart. `SigningKeyRing` is exported for custom setups.
- 18b472c: `TRUST_PROXY` now takes a hop count (`2` for a CDN in front of a load balancer) or a comma-separated list of proxy addresses and subnets (`10.0.0.0/8, 172.16.0.5`, or Express's `loopback`, `linklocal` and `uniquelocal`), and is passed to Express's `trust proxy` as is. Behind more than one proxy the edge used to forward the last proxy's address as the client IP, so users shared the API's per-IP rate limits and lockouts. `true` still means one hop and `false` none, so existing deployments are unchanged; a value that is neither a hop count nor valid addresses now stops the service at startup. Keep the container port reachable only through the proxy.

### Patch Changes

- 216b785: The confirmation for a native client now names the account as well as the client. `GET /interaction/:uid/details` returns `account: { identifier }` (the account's email, or its phone number if it has none), or `account: null` unless the browser is signed in as the interaction's account and the API can describe it. The hosted "Continue to <app>?" card shows the identifier, and with no account to name it offers only Cancel. If you serve your own pages through `uiDir`, show `account.identifier` beside the client name, send `{ "confirmed": true }` only from a real click, and do not offer to continue when `account` is `null`.
- 7858f18: A device client polling an expired device code faster than its interval now gets `expired_token`, so it stops, rather than `slow_down` on every poll. The poll throttle only tracks codes that have not expired. With an API that keeps expired device codes readable for a while (seamless-auth-api#542), the token endpoint answers `expired_token` for them; a code the API does not know still gets `invalid_grant`.
- 7858f18: Errors the provider cannot send back to the app now render on the hosted pages, with your branding, instead of the library's default "oops! something went wrong" page. That covers an unknown `client_id`, an unregistered `redirect_uri` at `/authorize`, and a refused `/session/end` (an unregistered `post_logout_redirect_uri`, or an `id_token_hint` that cannot be read). The page shows the error code, the provider's description and a plain explanation, and answers with the hosted pages' CSP and `no-store`. A server error shows a generic description.
- 7858f18: The hosted pages meet WCAG 2.2 AA with the default palette and a sound custom one (see `docs/accessibility-audit.md`).
  
  - The sign-in screens' mode toggle, error text and hovered button now take this service's palette, and follow `hosted_ui` branding, instead of fallback colors that fell below 4.5:1.
  - Text field edges are darker (`#7a828e` light, `#8a93a0` dark) so they meet 3:1, which also darkens card borders.
  - Sign-out, device and error pages are titled for what they do rather than "Sign in to <app>".
  - The device code error is tied to the code field.
  - When the hosted pages render with a `hosted_ui` palette whose pairs fall below AA contrast, the service logs one warning naming each pair. Nothing is refused.
- 18b472c: A failure while finishing a login no longer leaves a grant behind, and unexpected errors are answered as JSON. `POST /interaction/:uid/login` saves the grant before it reads the auth context; when that read failed (the API unreachable, say), the grant stayed and bound the first-party session to the client without a finished sign-in. The edge router also had no error handler, so such failures reached Express's default handler, which answers HTML with a stack trace whenever `NODE_ENV` is not `production`. They now answer `500 {"error":"server_error"}` (logged by name and message), and a malformed request body answers its 4xx status with `{"error":"invalid_request"}`.
- 18b472c: `/session/end` no longer signs a browser out of the hosted pages when it has no provider sign-in. The library ends an empty provider session without a confirmation page, and the edge used to clear the first-party adapter cookies on that automatic post, so any site that sent a browser to `/session/end` signed it out. The first-party session and its cookies are now ended only when the provider session had an account and the user confirmed on the hosted page.
- 18b472c: A first-party native client (`application_type: native`) no longer gets a code without a click. Any program on the device can listen on a loopback port or claim a private-use scheme, so a signed-in user's browser could otherwise hand a code to it with no interaction (RFC 8252 section 8.6). The hosted pages now show a "Continue to <app>" confirmation for every native client request, after sign-in and on later requests that ride the provider session, and `POST /interaction/:uid/consent` answers `403 confirmation_required` for a native client's prompt unless the body is `{ "confirmed": true }`. A custom hosted UI must send that body from the user's click. Web clients and device-flow approvals are unchanged.
- 7858f18: A request object that asks for `response_mode=form_post` now gets its `request_not_supported` refusal by form post rather than in the query string. Request objects are still not supported. Only `response_mode` is read from the refused object, without verifying it, and only the value `form_post` changes anything: the error still goes only to the request's own `redirect_uri` once it is checked against the client's registered URIs, and no other value from the object is used or shown. This lets the Form Post OP conformance profile pass `oidcc-unsigned-request-object-supported-correctly-or-rejected-as-unsupported`.
- 18b472c: The device poll throttle and the resume cookie check now match paths the way the provider's router does. A device client polling `/token/` was never told `slow_down`, because the throttle only recognised the exact path `/token`; it now follows the provider's own routing, so every spelling the provider accepts is throttled. The check that a resumed authorization is the one the resume cookie names now also covers `/authorize/<uid>/` and a differently cased `/AUTHORIZE/<uid>`.
- abb4834: Depend on `@seamless-auth/types` `^0.36.0`, which adds the session exchange contract.

## 0.3.0

### Minor Changes

- 047779c: A user's JWT access token for a resource (RFC 9068) now carries the session's `acr`, `amr` and `auth_time`, the same values the ID token states, and introspection returns them. A resource server can require a recent phishing-resistant sign-in on a route from the token alone (RFC 9470), and a refreshed token carries the session's current values, so a step-up shows on the next refresh. Device-flow and client credentials tokens carry none of the three, and opaque `/userinfo` tokens are unchanged. Needs no API change: Seamless Auth API 0.22.0 signs these claims and checks them against the session.

### Patch Changes

- 7c86020: Device-flow ID tokens no longer carry the approving session's `amr` and `auth_time`, first or after a refresh. Seamless Auth API 0.22.0 refuses to sign any device-flow token that states `acr`, `amr` or `auth_time` (ADR 0001 D10), so a device-flow request asking for `openid` ended in `server_error` against it.

## 0.2.0

### Minor Changes

- faecaf8: Bind each sign-in to its client through the API. The login step presents the user's access token to `POST /oidc/sessions/:id/bind`, and a browser that already has a provider session binds a new client from its access cookie, or is asked to sign in again when it has none. Requires a Seamless Auth API that speaks provider contract version 3.

## 0.1.1

### Patch Changes

- 1f8803f: Depend on `@seamless-auth/core` and `@seamless-auth/express` ^0.23.0, which carry the fix for proxying the user's identity right after a silent refresh, and build the hosted pages against `@seamless-auth/react` ^0.19.2.

## 0.1.0

### Minor Changes

- 793a30c: Refresh tokens, authorization codes and device codes are now single use under concurrency too. The API's consume answers whether this request marked the record used (`@seamless-auth/types` 0.34.0). A request that loses gets `invalid_grant`. A lost refresh is handled as refresh token reuse, which ends the first-party session, and a lost code revokes its grant, as a sequential reuse does. A token request whose session ended while it ran now gets `invalid_grant` instead of a server error.
- dcf17cc: Sign users in to OIDC apps with the authorization code flow and PKCE, discovery and userinfo. Interactions finish only after a first-party sign-in through this service's own adapter, through four JSON routes the hosted pages call: `GET /interaction/:uid/details`, and `POST /interaction/:uid/login`, `/consent` and `/abort`. The provider grant is saved against the first-party session before its auth context is read, and every stored record and signature names that session, so the API's grant binding holds. ID tokens carry the scope claims plus `acr`, `amr` and `auth_time` from the API.
  
  - A recovery session cannot finish a sign-in, and `prompt=login` or `max_age` refuse a session older than the request.
  - First-party clients have consent implied. Third-party clients do not exist while `third_party_clients_enabled` is off, and see the consent page on every authorization when it is on.
  - The interaction routes refuse a state change unless `Sec-Fetch-Site` is `same-origin` or the `Origin` is the issuer's, so a sibling subdomain cannot drive them.
  
  Needs fells-code/seamless-auth-api#524 for a session signed in to more than one app.
- 1697942: Client authentication per ADR D6. Confidential clients use `private_key_jwt` by default, and each assertion is single-use through the API's replay store (a replay is `invalid_client`, not a 500). Public clients use `none` with PKCE. `client_secret_basic` and `client_secret_post` are offered only when the API allows client secrets (`allow_client_secrets`, read at startup), and only work for clients opted in on the API.
  
  A presented secret is checked with `POST /oidc/clients/:id/verify-secret` before the library runs. When the API accepts it, the request carries a one-time value in its place, and the client's metadata carries that value for that request only, so this service never holds a client's real secret. `client_secret_jwt` and HS* algorithms are never offered.
- 2532a7c: `pkce.required` is now per client. PKCE stays required unless the API sends `urn:seamless:pkce_required: false` for a confidential client (`@seamless-auth/types` 0.34.0), as RFC 9700 section 2.1.1 allows. Such a client must send `nonce` on any code request without PKCE that asks for an ID token, or gets `invalid_request`, unless the API also sends `urn:seamless:nonce_required: false`. A code request without `openid` still needs PKCE, since a nonce only binds an ID token. An opt-out on a public client is ignored, so PKCE stays required for it.
- d3b779e: Apply each application's `accessTokenTtlSeconds`, `idTokenTtlSeconds` and `refreshTokenTtlSeconds`, which the API now sends as `urn:seamless:access_token_ttl`, `urn:seamless:id_token_ttl` and `urn:seamless:refresh_token_ttl` client metadata (`@seamless-auth/types` 0.34.0). An access token for a resource takes the shorter of the resource's and the application's lifetime. Unset values keep the defaults (600 seconds for access and ID tokens, 14 days for refresh tokens), and `ttl.RefreshToken` is now set explicitly, keeping the library's rule that a public browser app's rotated token never outlives the one it replaced.
- 4c74314: The device authorization grant (RFC 8628) for first-party clients with the device flow turned on: `/device/auth` returns an 8-character base-20 user code (about 34.5 bits) that lives 10 minutes and an `interval` of 5 seconds, and `/device` is the verification page in the hosted UI. The page names the app and warns, before any sign-in, to continue only on a device you started yourself. Every approval signs in again, even in a browser that is already signed in. Polling sooner than the interval gets `slow_down` and a longer interval, per device code. Code entry is limited to 10 a minute per address and 600 a minute per instance. Device-flow tokens never carry `acr`, including after a refresh, and `acr_values` and `max_age` are refused on device requests (ADR D10). Sign requests now name the grant (`grantType`), which needs `@seamless-auth/types` 0.34.0 and the API with edge contract version 2.
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
- b31200c: RP-initiated logout at `/session/end`, confirmed on a hosted page. Signing out ends the provider session and the first-party session behind it through the API, which sends OpenID Back-Channel Logout tokens to every app the user signed in to with it. Signing out of the asking app only ends that app's grant. Discovery now lists `end_session_endpoint`, `backchannel_logout_supported` and `backchannel_logout_session_supported`, and ID tokens carry `sid` for clients registered for back-channel logout. Needs the API with back-channel logout (fells-code/seamless-auth-api#409).
- b3048a8: Honour `acr_values`, `max_age` and `prompt=login` from the API's auth context, with step-up in the hosted pages.
  
  - Every authorization from an existing provider session reads `GET /oidc/sessions/:id/auth-context` and carries the reported `acr`, `amr` and `auth_time` into the tokens, so a step-up made elsewhere shows up on the next authorization and `/oidc/sign` never sees a stale value. A session the API reports as ended or in recovery goes back to sign-in.
  - `acr_values` is met when the session's acr ranks at least the weakest value asked for (`phrh` satisfies `phr`). `max_age` is met by the API's `auth_time`, or an authentication during the request.
  - `POST /interaction/:uid/login` answers `409 { error: 'step_up_required', methods }` instead of `reauthentication_required`. The pages run the step-up through the adapter (`/step-up/webauthn/*`, or `/totp/verify-mfa` for freshness on a session with no acr), then post again with `{ "afterStepUp": true }`. If the requirement is still not met, the client receives `unmet_authentication_requirements`.
  
  Needs fells-code/seamless-auth-api#529.

### Patch Changes

- 1397fcd: Document how the provider meets OAuth 2.1 and RFC 9700 in `docs/oauth-security.md`, with the test behind each row, and cover RFC 8252 native clients (loopback redirects on any port, the IPv6 loopback, private-use schemes, and refusal of any other host, path or scheme). No behaviour change.
- dfd86f2: Depend on `@seamless-auth/types` `^0.34.0`, the stable release, instead of the 0.34.0 prerelease.
