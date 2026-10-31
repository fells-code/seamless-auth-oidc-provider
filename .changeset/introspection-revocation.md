---
'@seamless-auth/oidc-provider': minor
---

Token introspection (RFC 7662) and revocation (RFC 7009) at `/token/introspection` and `/token/revocation`, listed in discovery.

- A client may introspect its own tokens. A resource server, registered as a confidential application linked to its resource, may introspect tokens whose `aud` is that resource. Every answer comes from the API's store, so a token whose session has ended is inactive at once.
- JWT access tokens are now stored under their `jti` when issued, so they can be introspected and revoked. A presented JWT is mapped back to its record only after its signature checks out against the provider's keys, and the `jti` alone is not accepted as a token.
- Revoking a refresh token ends that app's grant and its tokens, not the user's first-party session. Each revocation is recorded in the API's audit log as `token_revoked`.
- Both endpoints are limited to 1200 requests a minute per client IP, per instance.
