# OpenID conformance

The OpenID Foundation [conformance suite](https://gitlab.com/openid/conformance-suite)
against this service, the API behind it and Postgres, run by
[`.github/workflows/conformance.yml`](../.github/workflows/conformance.yml) on pull requests
that touch the service and nightly.

## What runs

| Piece                       | Where                                                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| The suite                   | [`suite/docker-compose.yml`](suite/docker-compose.yml): the published images, pinned by release                   |
| Postgres, the API, fake SES | [`stack/start.sh`](stack/start.sh): the API built from a `seamless-auth-api` checkout, email codes kept in memory |
| This service                | [`stack/edge-https.mjs`](stack/edge-https.mjs): `dist/` behind TLS as `https://op.seamless.test:5321`             |
| Clients                     | [`stack/seed.mjs`](stack/seed.mjs): inserted into the API's registry, with per-run secrets and keys               |
| Plans                       | [`plans.json`](plans.json)                                                                                        |
| Front channel               | [`runner/`](runner): Playwright with a virtual authenticator, because the hosted pages sign in with a passkey     |
| Expected results            | [`expected.json`](expected.json): every result that is not a pass, with the reason                                |

CI builds the API at the ref in [`api-ref`](api-ref) (`main`, or a commit while the API is
ahead of this service). The edge refuses to start when the API's `/oidc` contract version is
not its own, so a pull request that moves `@seamless-auth/types` to a new contract version
sets `api-ref` to an API commit that speaks it, or back to `main`. The `api-ref` input of a
manual run overrides it.

The runner registers one account by email code and passkey on the first sign-in, then
copies that passkey into each module's fresh browser, as the suite expects a new browser per
module. When a module asks for a screenshot (the provider's own error page, or the second
login for `prompt=login` and `max_age`), the runner uploads the page it acted on.

The OIDCC plans send no `code_challenge`, and one module sends no `nonce`, so the suite's
clients are seeded with the per-application PKCE and nonce opt-out. `conformance-pkce` keeps
both requirements. Before the plans, the runner sends each a plain authorization request:
the job fails if `conformance-pkce` is not refused, and the outcome for the other clients
picks the expectations marked `"when": "pkce-opt-out"` or `"when": "pkce-required"` (an API
without the opt-out, where every client requires PKCE).

The back-channel plan has its own clients, `conformance-backchannel-1/2`, whose
`backchannelLogoutUri` points at the suite. Only they have one, because the API posts a logout
token whenever a session ends and a module of another plan fails on a call it does not expect.
The suite's certificate is self-signed, so the stack's API runs with
`NODE_TLS_REJECT_UNAUTHORIZED=0`; that setting lives only in `stack/start.sh`. On the hosted
logout page the runner presses "Sign out", which ends the first-party session and sends the
tokens.

A module fails the job when it ends `FAILED`, is interrupted or times out and is not listed
in `expected.json`, or when a listed expectation no longer happens. `WARNING`, `REVIEW` and
`SKIPPED` results pass, and the ones we know about are listed with their reason so the
summary explains them. The job summary, every plan's HTML export, the screenshots and the
service logs are uploaded as the `openid-conformance-results` artifact.

## Device flow

The suite has no plan for the device grant, so [`runner/device-flow.mjs`](runner/device-flow.mjs)
runs it on the same stack before the plans: a device asks for `openid`, a browser approves it
with a passkey, and the device's tokens, first and refreshed, must carry no `acr`, `amr` or
`auth_time` (ADR 0001 D10), which the API refuses to sign on a device-flow token. Its client,
`conformance-device`, is seeded by `seed.mjs`. Run it locally after `seed.mjs`:

```bash
(cd conformance && node runner/device-flow.mjs)
```

## Running it locally

Needs Docker, Node from `.nvmrc`, and a built `seamless-auth-api` checkout.

```bash
npm ci && npm run build
(cd conformance && npm ci && npx playwright install chromium)
API_DIR=../seamless-auth-api conformance/stack/start.sh
RUN_DIR=$PWD/conformance/.run node conformance/stack/seed.mjs
(cd conformance/suite && docker compose up -d)
(cd conformance && NODE_TLS_REJECT_UNAUTHORIZED=0 node runner/run.mjs)
```

`PLANS=basic` and `MODULES=oidcc-prompt-login` narrow a run, and `DEBUG_BROWSER=1` prints
each page the browser lands on. The suite's own UI is at `https://localhost:8443`.
`conformance/stack/stop.sh` stops the stack and removes the database container.

## Adding a plan

Add an entry to `plans.json` (the suite's plan name, its variant, and the configuration
`seed.mjs` writes for it). Entries with `"enabled": false` are kept for features that have
not merged yet; enable them in the pull request that ships the feature.
