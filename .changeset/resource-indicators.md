---
'@seamless-auth/oidc-provider': minor
---

Issue access tokens for a named API. With `resource=<identifier>` (RFC 8707) the access token is an RFC 9068 JWT (`typ: at+jwt`) whose `aud` is the resource, carrying only the scopes the application is allowed there and the resource's own lifetime, read from the API's `GET /oidc/clients/:id/resources`. A resource the application is not linked to is refused with `invalid_target`. A resource named once at authorization is used at the token endpoint too. Without `resource`, the access token is the same opaque userinfo token as before. First-party apps have resource scopes granted with the sign-in. The consent page lists them for third-party apps.

Needs fells-code/seamless-auth-api#533 and `@seamless-auth/types` with `OidcEdgeRoutes.clientResources`.
