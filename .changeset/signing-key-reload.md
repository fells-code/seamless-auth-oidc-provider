---
'@seamless-auth/oidc-provider': minor
---

The edge now follows the API's provider key rotation without a restart. It used to load the signing keys once at startup, so after the API rotated its active key every token request failed with `unknown_key` until the edge restarted, and `/jwks` and JWT access token introspection kept the startup keys. It now re-reads the keys every five minutes and at once when the API refuses a key as unknown (at most the request that meets the rotation fails), and `/jwks` serves the current set. Embedders can set the interval with the new `signingKeyRefreshMs` option (`0` turns the timer off). A rotation to a key with a different algorithm is refused with a logged error and still needs a restart. `SigningKeyRing` is exported for custom setups.
