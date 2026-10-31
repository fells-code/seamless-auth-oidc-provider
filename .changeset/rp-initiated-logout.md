---
'@seamless-auth/oidc-provider': minor
---

RP-initiated logout at `/session/end`, confirmed on a hosted page. Signing out ends the provider session and the first-party session behind it through the API, which sends OpenID Back-Channel Logout tokens to every app the user signed in to with it. Signing out of the asking app only ends that app's grant. Discovery now lists `end_session_endpoint`, `backchannel_logout_supported` and `backchannel_logout_session_supported`, and ID tokens carry `sid` for clients registered for back-channel logout. Needs the API with back-channel logout (fells-code/seamless-auth-api#409).
