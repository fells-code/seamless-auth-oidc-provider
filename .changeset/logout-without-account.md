---
'@seamless-auth/oidc-provider': patch
---

`/session/end` no longer signs a browser out of the hosted pages when it has no provider sign-in. The library ends an empty provider session without a confirmation page, and the edge used to clear the first-party adapter cookies on that automatic post, so any site that sent a browser to `/session/end` signed it out. The first-party session and its cookies are now ended only when the provider session had an account and the user confirmed on the hosted page.
