---
'@seamless-auth/oidc-provider': patch
---

A device client polling an expired device code faster than its interval now gets `expired_token`, so it stops, rather than `slow_down` on every poll. The poll throttle only tracks codes that have not expired. With an API that keeps expired device codes readable for a while (seamless-auth-api#542), the token endpoint answers `expired_token` for them; a code the API does not know still gets `invalid_grant`.
