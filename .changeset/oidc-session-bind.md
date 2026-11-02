---
'@seamless-auth/oidc-provider': minor
---

Bind each sign-in to its client through the API. The login step presents the user's access token to `POST /oidc/sessions/:id/bind`, and a browser that already has a provider session binds a new client from its access cookie, or is asked to sign in again when it has none. Requires a Seamless Auth API that speaks provider contract version 3.
