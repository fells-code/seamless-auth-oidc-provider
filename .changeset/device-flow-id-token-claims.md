---
'@seamless-auth/oidc-provider': patch
---

Device-flow ID tokens no longer carry the approving session's `amr` and `auth_time`, first or after a refresh. Seamless Auth API 0.22.0 refuses to sign any device-flow token that states `acr`, `amr` or `auth_time` (ADR 0001 D10), so a device-flow request asking for `openid` ended in `server_error` against it.
