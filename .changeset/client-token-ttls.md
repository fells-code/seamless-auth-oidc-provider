---
'@seamless-auth/oidc-provider': minor
---

Apply each application's `accessTokenTtlSeconds`, `idTokenTtlSeconds` and `refreshTokenTtlSeconds`, which the API now sends as `urn:seamless:access_token_ttl`, `urn:seamless:id_token_ttl` and `urn:seamless:refresh_token_ttl` client metadata (`@seamless-auth/types` 0.34.0-next.4). An access token for a resource takes the shorter of the resource's and the application's lifetime. Unset values keep the defaults (600 seconds for access and ID tokens, 14 days for refresh tokens), and `ttl.RefreshToken` is now set explicitly, keeping the library's rule that a public browser app's rotated token never outlives the one it replaced.
