---
'@seamless-auth/oidc-provider': minor
---

Refresh token reuse detection and the client credentials grant.

- A rotated refresh token presented again still revokes the grant, and now also asks the API to end the first-party session it was issued under (`POST /oidc/sessions/:id/revoke`, reason `refresh_token_reuse`).
- A refresh reads the session's auth context, so the refreshed ID token carries the current `acr`, `amr` and `auth_time`. Before this, any step-up after sign-in made `/oidc/sign` refuse every later refresh.
- `client_credentials` is on for clients registered for it. The token is an RFC 9068 JWT for a resource (the one named with `resource`, or the client's only linked one, else `invalid_target`), with `sub` and `client_id` set to the client and scopes cut to what it is allowed there.
