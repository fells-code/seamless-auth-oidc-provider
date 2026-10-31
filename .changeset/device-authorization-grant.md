---
'@seamless-auth/oidc-provider': minor
---

The device authorization grant (RFC 8628) for first-party clients with the device flow turned on: `/device/auth` returns an 8-character base-20 user code (about 34.5 bits) that lives 10 minutes and an `interval` of 5 seconds, and `/device` is the verification page in the hosted UI. The page names the app and warns, before any sign-in, to continue only on a device you started yourself. Every approval signs in again, even in a browser that is already signed in. Polling sooner than the interval gets `slow_down` and a longer interval, per device code. Code entry is limited to 10 a minute per address and 600 a minute per instance. Device-flow tokens never carry `acr`, including after a refresh, and `acr_values` and `max_age` are refused on device requests (ADR D10). Sign requests now name the grant (`grantType`), which needs `@seamless-auth/types` 0.34.0-next.4 and the API with edge contract version 2.
