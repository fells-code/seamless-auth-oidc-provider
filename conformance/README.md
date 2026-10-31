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

The runner registers one account by email code and passkey on the first sign-in, then
copies that passkey into each module's fresh browser, as the suite expects a new browser per
module. When a module asks for a screenshot (the provider's own error page, or the second
login for `prompt=login` and `max_age`), the runner uploads the page it acted on.

A module fails the job when it ends `FAILED`, is interrupted or times out and is not listed
in `expected.json`, or when a listed expectation no longer happens. `WARNING`, `REVIEW` and
`SKIPPED` results pass, and the ones we know about are listed with their reason so the
summary explains them. The job summary, every plan's HTML export, the screenshots and the
service logs are uploaded as the `openid-conformance-results` artifact.

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
