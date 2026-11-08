---
'@seamless-auth/oidc-provider': minor
---

Carry roles, permissions and custom claims in provider tokens (#47).

- New scopes `permissions` (`roles`, `permissions`, `org_id`, `org_roles`, `org_permissions`, or `permissions_omitted`) and `custom_claims` (every custom claim the API resolves for the user and the application). They appear in ID tokens, `/userinfo`, and a user's RFC 9068 access token for a resource when the grant holds the scope. The consent page describes both.
- The values come from the API's `/oidc/accounts/:id` and the API signs only what it computes again, so the edge cannot add or change one. Reserved claim names are never released, and the permission claims are released whole or not at all.
- When the API refuses a sign with `claims_mismatch` (a role or membership changed between the account read and the sign), the edge reads the account again and signs once more, so the token request succeeds with the new values. A second mismatch answers `server_error` (500) with a description. Other refusals are not retried.
- `org_id` now names the session's active organization rather than the user's oldest membership. This changes `org_id` under the `seamless` scope too.
- Needs a seamless-auth-api release that returns these claims and signs them. Against an older API none are released.
- Depend on `@seamless-auth/types` `^0.40.0` for the shared reserved claim list, the account claims schema and the `claims_mismatch` refusal code.
