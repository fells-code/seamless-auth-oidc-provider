---
'@seamless-auth/oidc-provider': patch
---

Errors the provider cannot send back to the app now render on the hosted pages, with your branding, instead of the library's default "oops! something went wrong" page. That covers an unknown `client_id`, an unregistered `redirect_uri` at `/authorize`, and a refused `/session/end` (an unregistered `post_logout_redirect_uri`, or an `id_token_hint` that cannot be read). The page shows the error code, the provider's description and a plain explanation, and answers with the hosted pages' CSP and `no-store`. A server error shows a generic description.
