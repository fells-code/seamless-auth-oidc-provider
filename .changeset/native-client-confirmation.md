---
'@seamless-auth/oidc-provider': patch
---

A first-party native client (`application_type: native`) no longer gets a code without a click. Any program on the device can listen on a loopback port or claim a private-use scheme, so a signed-in user's browser could otherwise hand a code to it with no interaction (RFC 8252 section 8.6). The hosted pages now show a "Continue to <app>" confirmation for every native client request, after sign-in and on later requests that ride the provider session, and `POST /interaction/:uid/consent` answers `403 confirmation_required` for a native client's prompt unless the body is `{ "confirmed": true }`. A custom hosted UI must send that body from the user's click. Web clients and device-flow approvals are unchanged.
