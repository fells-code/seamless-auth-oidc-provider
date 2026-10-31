---
'@seamless-auth/oidc-provider': minor
---

Sign users in to OIDC apps with the authorization code flow and PKCE, discovery and userinfo. Interactions finish only after a first-party sign-in through this service's own adapter, through four JSON routes the hosted pages call: `GET /interaction/:uid/details`, and `POST /interaction/:uid/login`, `/consent` and `/abort`. The provider grant is saved against the first-party session before its auth context is read, and every stored record and signature names that session, so the API's grant binding holds. ID tokens carry the scope claims plus `acr`, `amr` and `auth_time` from the API.

- A recovery session cannot finish a sign-in, and `prompt=login` or `max_age` refuse a session older than the request.
- First-party clients have consent implied. Third-party clients do not exist while `third_party_clients_enabled` is off, and see the consent page on every authorization when it is on.
- The interaction routes refuse a state change unless `Sec-Fetch-Site` is `same-origin` or the `Origin` is the issuer's, so a sibling subdomain cannot drive them.

Needs fells-code/seamless-auth-api#524 for a session signed in to more than one app.
