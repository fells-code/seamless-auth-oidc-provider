---
'@seamless-auth/oidc-provider': patch
---

Depend on `@seamless-auth/core` and `@seamless-auth/express` `^0.26.0`. On 0.x, `^0.23.0` stopped at 0.23, so the edge ran on 0.23 and an application installing the provider got a second, older copy of both. The edge now has the adapter fixes from 0.25: the CSRF origin check on form posts to the auth routes (seamless-auth-server#256), no replay of a completed bearer refresh rotation (#258), no client-chosen client IP under a `trust proxy` that trusts every address (#257), and a bundled adapter manifest with the v0.23 routes.
