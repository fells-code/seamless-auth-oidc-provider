---
'@seamless-auth/oidc-provider': patch
---

Document how the provider meets OAuth 2.1 and RFC 9700 in `docs/oauth-security.md`, with the test behind each row, and cover RFC 8252 native clients (loopback redirects on any port, the IPv6 loopback, private-use schemes, and refusal of any other host, path or scheme). No behaviour change.
