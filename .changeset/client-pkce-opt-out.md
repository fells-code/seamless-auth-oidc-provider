---
'@seamless-auth/oidc-provider': minor
---

`pkce.required` is now per client. PKCE stays required unless the API sends `urn:seamless:pkce_required: false` for a confidential client (`@seamless-auth/types` 0.34.0-next.4), as RFC 9700 section 2.1.1 allows. Such a client must send `nonce` on any code request without PKCE that asks for an ID token, or gets `invalid_request`. A code request without `openid` still needs PKCE, since a nonce only binds an ID token. An opt-out on a public client is ignored, so PKCE stays required for it.
