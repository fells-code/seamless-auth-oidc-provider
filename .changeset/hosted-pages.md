---
'@seamless-auth/oidc-provider': minor
---

Hosted login and consent pages. A SPA on `@seamless-auth/react`, served by this service at `/interaction/:uid` and the bundled sign-in paths (`/login`, `/verify-email-otp`, `/register-passkey` and the rest), signs users in through this service's own first-party adapter, so every enabled method and every first-party protection applies. It finishes the interaction once the user is signed in, sends a recovery session to enrollment, and has the user sign in again when the app asks for `prompt=login` or `max_age`.

- Third-party clients get a consent page naming the client, the host it sends you back to, and what it asks for.
- Branding is read from the API's config when a page is served (`app_name` today), with no build step. A config change shows within 30 seconds.
- Every page gets a strict CSP: scripts from this origin only, styles from this origin or carrying the response's nonce, `frame-ancestors 'none'`, plus `no-store`, `nosniff` and `no-referrer`.
- The adapter routes under `/auth` now need `Sec-Fetch-Site: same-origin` or the issuer's `Origin` for a state change, like the interaction routes.
- The resume cookie is now `__Host-oidc_resume` with `Path=/`, and resuming an authorization other than the one it names is refused.
- The package ships the built pages in `dist/ui`. `createOidcEdge` takes `uiDir` to serve another build.
