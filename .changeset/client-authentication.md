---
'@seamless-auth/oidc-provider': minor
---

Client authentication per ADR D6. Confidential clients use `private_key_jwt` by default, and each assertion is single-use through the API's replay store (a replay is `invalid_client`, not a 500). Public clients use `none` with PKCE. `client_secret_basic` and `client_secret_post` are offered only when the API allows client secrets (`allow_client_secrets`, read at startup), and only work for clients opted in on the API.

A presented secret is checked with `POST /oidc/clients/:id/verify-secret` before the library runs. When the API accepts it, the request carries a one-time value in its place, and the client's metadata carries that value for that request only, so this service never holds a client's real secret. `client_secret_jwt` and HS* algorithms are never offered.
