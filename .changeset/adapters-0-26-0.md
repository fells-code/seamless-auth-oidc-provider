---
'@seamless-auth/oidc-provider': patch
---

Depend on `@seamless-auth/core` and `@seamless-auth/express` `^0.26.0`. On 0.x, `^0.23.0` stopped at 0.23, so the edge ran on 0.23 and an application installing the provider got a second, older copy of both. The edge now has the adapter fixes from 0.25: the CSRF origin check on form posts to the auth routes (seamless-auth-server#256), no replay of a completed bearer refresh rotation (#258), no client-chosen client IP under a `trust proxy` that trusts every address (#257), and a bundled adapter manifest with the v0.23 routes.

The hosted pages build against `@seamless-auth/react` 0.20 and `@seamless-auth/client` 0.9. Client 0.8.2 sent body-less requests such as the passkey step-up start without a JSON content type or the transport header, and adapters from 0.25 refuse those with 415, so step-up needs the newer client.
