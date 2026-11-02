---
'@seamless-auth/oidc-provider': minor
---

A user's JWT access token for a resource (RFC 9068) now carries the session's `acr`, `amr` and `auth_time`, the same values the ID token states, and introspection returns them. A resource server can require a recent phishing-resistant sign-in on a route from the token alone (RFC 9470), and a refreshed token carries the session's current values, so a step-up shows on the next refresh. Device-flow and client credentials tokens carry none of the three, and opaque `/userinfo` tokens are unchanged. Needs no API change: Seamless Auth API 0.22.0 signs these claims and checks them against the session.
