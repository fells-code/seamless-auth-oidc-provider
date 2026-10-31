---
'@seamless-auth/oidc-provider': minor
---

Refresh tokens, authorization codes and device codes are now single use under concurrency too. The API's consume answers whether this request marked the record used (`@seamless-auth/types` 0.34.0-next.4). A request that loses gets `invalid_grant`. A lost refresh is handled as refresh token reuse, which ends the first-party session, and a lost code revokes its grant, as a sequential reuse does. A token request whose session ended while it ran now gets `invalid_grant` instead of a server error.
