---
'@seamless-auth/oidc-provider': patch
---

A failure while finishing a login no longer leaves a grant behind, and unexpected errors are answered as JSON. `POST /interaction/:uid/login` saves the grant before it reads the auth context; when that read failed (the API unreachable, say), the grant stayed and bound the first-party session to the client without a finished sign-in. The edge router also had no error handler, so such failures reached Express's default handler, which answers HTML with a stack trace whenever `NODE_ENV` is not `production`. They now answer `500 {"error":"server_error"}` (logged by name and message), and a malformed request body answers its 4xx status with `{"error":"invalid_request"}`.
