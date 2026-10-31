---
'@seamless-auth/oidc-provider': minor
---

Honour `acr_values`, `max_age` and `prompt=login` from the API's auth context, with step-up in the hosted pages.

- Every authorization from an existing provider session reads `GET /oidc/sessions/:id/auth-context` and carries the reported `acr`, `amr` and `auth_time` into the tokens, so a step-up made elsewhere shows up on the next authorization and `/oidc/sign` never sees a stale value. A session the API reports as ended or in recovery goes back to sign-in.
- `acr_values` is met when the session's acr ranks at least the weakest value asked for (`phrh` satisfies `phr`). `max_age` is met by the API's `auth_time`, or an authentication during the request.
- `POST /interaction/:uid/login` answers `409 { error: 'step_up_required', methods }` instead of `reauthentication_required`. The pages run the step-up through the adapter (`/step-up/webauthn/*`, or `/totp/verify-mfa` for freshness on a session with no acr), then post again with `{ "afterStepUp": true }`. If the requirement is still not met, the client receives `unmet_authentication_requirements`.

Needs fells-code/seamless-auth-api#529.
