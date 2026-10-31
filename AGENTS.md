# AGENTS.md

This file is for coding agents working in the `seamless-auth-oidc-provider` repository.

## Purpose

`seamless-auth-oidc-provider` is the Seamless Auth OpenID Provider: a public "login edge"
service that lets any OpenID Connect app sign users in with Seamless Auth. It is built on
[`oidc-provider`](https://github.com/panva/node-oidc-provider) 9.x and
`@seamless-auth/express`, and ships as a Docker image and as the npm package
`@seamless-auth/oidc-provider`.

The design is fixed by
[ADR 0001](https://github.com/fells-code/seamless-auth-api/blob/main/docs/adr/0001-openid-provider.md)
in seamless-auth-api. Read it before changing anything here. The parts that bind this repo:

- **The API stays private.** This service is the public tier. The auth API is bearer only and
  cookie-free, and only this service and the adopter's backends reach it.
- **No private keys here.** Provider tokens are signed by the API through `POST /oidc/sign`
  (`oidc-provider`'s external signing). The API checks every claim before it signs.
- **No database here.** Provider state lives in the API's Postgres and is reached through the
  service-token `/oidc/payloads/*` routes. Clients come from the API's registry.
- **Sign-in is first-party sign-in.** The hosted pages sign users in through the same JSON
  routes every SDK app uses, through this service's own `@seamless-auth/express` adapter, so
  decoys, lockout and rate limits apply unchanged.
- **The configuration is locked** (ADR D1, #410): code flow only, PKCE for every client,
  refresh rotation always on, no dev interactions, no dynamic registration, no
  `client_secret_jwt` or HS\* algorithms.

## Working Standards (fells-code baseline)

These rules apply to every repository in the fells-code org. Repo-specific
guidance may extend them but must not contradict them.

### Attribution

- Commit and open PRs solely under the repository owner's identity. Never
  commit under an agent or assistant identity.
- Never attribute work to an AI assistant: no `Co-Authored-By: Claude` (or any
  assistant) trailers, no "Generated with" / "Created with Claude" notes, and no
  assistant branding or emoji anywhere in commit messages, PR or issue titles
  and descriptions, changesets, code comments, or docs.

### Comments

- Comment only when the code genuinely needs explaining: a non-obvious reason, a
  gotcha, or an invariant. Never narrate what the code plainly does.

### TODOs

- Every `TODO`/`FIXME` must reference a ticket, e.g. `// TODO(#123): ...`.
  Do not leave a bare TODO. If no ticket exists, create one first.

### Commits & branches

- Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `ci:`, `test:`).
- Descriptive branch names (`feat/...`, `fix/...`); never a `claude/` or other
  tool-generated prefix.

### Public-facing text

- No em dashes in commit messages, code comments, PR or issue text, changesets,
  or docs. Use a comma, parentheses, or a separate sentence.

### Before declaring work done

- All code quality checks must pass before you open a PR or call the work done:
  tests, linting, type checks, and formatting. Run them and report the real
  output; do not open a PR while any check is failing.
- Typical commands: `npm run typecheck`, `npm run lint`, `npm run format:check`
  (or `npm run format`), and `npm test`. Never claim a change works without
  running them.
- Match the surrounding code's style, naming, and comment density.

## Architecture Map

```text
src/
  index.ts           public package surface (createOidcEdge and building blocks)
  server.ts          the service entry point (Docker image, npm bin)
  env.ts             environment parsing
  createOidcEdge.ts  builds the provider and the Express router, origin pinning
  startup.ts         version check against the API's /oidc/config
  apiClient.ts       service-token client for the API's /oidc/* routes
  adapter.ts         oidc-provider storage adapter over /oidc/payloads/* and /oidc/clients/:id
  signingKey.ts      ExternalSigningKey that signs through POST /oidc/sign
  providerConfig.ts  the locked oidc-provider configuration
  requestContext.ts  per-request context (client IP, user agent, linked session)
  configCache.ts     the API's /oidc/config, re-read so flag changes apply without a restart
  interactions.ts    JSON routes the hosted pages call to finish login and consent
  firstPartySession.ts  reads the adapter's access cookie (user and first-party session)
  originGuard.ts     same-origin check for state-changing browser routes
  hostedPages.ts     serves the SPA with serve-time branding, CSP nonce and headers
  resumeCookie.ts    moves the library's resume cookie to Path=/ so it can be __Host-
  clientSecrets.ts   checks shared client secrets with the API, swaps in a one-time stand-in
  authRequirements.ts  acr_values, max_age and prompt=login against the API's auth context
  resourceServers.ts resource indicators (RFC 8707) and JWT access tokens from the API's links
  refreshReuse.ts    ends the first-party session when a rotated refresh token is reused
  jwtAccessTokens.ts stores JWT access tokens by jti so introspection and revocation see them
  tokenAudit.ts      records revocations in the API's audit log
  rateLimit.ts       per-IP limit on introspection and revocation
ui/                  the hosted pages: Vite + React on @seamless-auth/react, built to dist/ui
tests/               vitest, against a fake API in tests/fakeApi.ts
```

**How a provider sign-in is bound to a first-party session.** The hosted pages sign in
through `/auth/*`, then call `POST /interaction/:uid/login`. That route reads the session id
from the adapter's access cookie, pins it with `bindSession`, saves the Grant, and only then
reads the auth context (the API answers only for a session holding a grant for the client).
Every later request recovers the session from the record it acts on (`adoptSession` in the
storage adapter), so codes, tokens and signatures all name the same `sessions` row.

The `/oidc/*` contract is defined in `@seamless-auth/types` (`oidcEdge` module). Validate
every API response with those schemas and never hand-write a duplicate type.

## Tooling

| Task          | Command                |
| ------------- | ---------------------- |
| Build         | `npm run build`        |
| Build the UI  | `npm run build:ui`     |
| Typecheck     | `npm run typecheck`    |
| Lint          | `npm run lint`         |
| Format check  | `npm run format:check` |
| Tests         | `npm test`             |
| Coverage      | `npm run coverage`     |
| Add changeset | `npm run changeset`    |

- Supported Node is `>=22`. `.nvmrc` pins Node 24 for development and releases.
- Every `src/**/*.ts` and `tests/**/*.ts` file starts with the Apache-2.0 header in
  `resources/license-header.js` (eslint enforces it), and imports are auto-sorted.
- No `any` (`@typescript-eslint/no-explicit-any` is an error).
- commitlint enforces Conventional Commits; husky runs lint-staged on commit.

## Releases

Releases go through Changesets. See `RELEASES.md`.

- **Never write a `major` changeset.** The package is pre-1.0 and stays there until cutting
  1.0 is a deliberate decision. Under 0.x a `minor` bump already signals a break, so use
  `minor` and describe the break in the body. CI enforces this
  (`npm run check:changeset-bump`).
- Don't hand-edit `CHANGELOG.md` or the version in `package.json`.

## Security posture

This is the public tier of an authentication system. Treat everything here as high stakes:
fail closed, never log secrets or tokens, keep cookies `__Host-` and `Secure`, and check
`Sec-Fetch-Site` and `Origin` on every state change.

- `oidc-provider` is pinned to a 9.x minor. Upgrade it on its own, read its changelog, and
  gate the upgrade on the OpenID conformance suite (#9).
- External signing is experimental in the library. Falling back to keys on this service
  loses ADR D4's protection and needs an ADR update first.

## Ecosystem

This service is a Tier 1 dependent of seamless-auth-api (the `/oidc/*` routes) and of
seamless-auth-server (`@seamless-auth/express`). The hosted UI (#3) builds on
`@seamless-auth/react` from seamless-auth-js. Changes to the `/oidc/*` contract start in
seamless-auth-types, then the API, then here; `OIDC_EDGE_CONTRACT_VERSION` makes this service
refuse to start against an API on a different contract.
