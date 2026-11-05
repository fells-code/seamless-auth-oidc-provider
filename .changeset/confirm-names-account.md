---
'@seamless-auth/oidc-provider': patch
---

The confirmation for a native client now names the account as well as the client. `GET /interaction/:uid/details` returns `account: { identifier }` (the account's email, or its phone number if it has none), or `account: null` unless the browser is signed in as the interaction's account and the API can describe it. The hosted "Continue to <app>?" card shows the identifier, and with no account to name it offers only Cancel. If you serve your own pages through `uiDir`, show `account.identifier` beside the client name, send `{ "confirmed": true }` only from a real click, and do not offer to continue when `account` is `null`.
