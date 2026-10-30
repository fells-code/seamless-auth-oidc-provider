# Release Management

This repo uses npm plus Changesets, matching the rest of the fells-code packages. A release
publishes the npm package `@seamless-auth/oidc-provider` and the Docker image
`ghcr.io/fells-code/seamless-auth-oidc-provider`.

## Daily Development

1. Make the change.
2. Run `npm run changeset` and choose the bump.
3. Write release notes for adopters and operators, not implementation notes.

## Choosing the bump

The package is pre-1.0. **Never use `major`**: CI rejects it (`npm run check:changeset-bump`).

- **minor** for new features, and for anything an operator or embedding app must react to (a
  new required environment variable, a newer required API version, a changed default).
  Describe the break in the body.
- **patch** for fixes with no effect on configuration or behaviour adopters rely on.

## API compatibility

The service checks `GET /oidc/config` on the API at startup and refuses to run when the
provider is disabled there or the API reports a different `contractVersion`. A release that
needs a newer API says so in its changeset, and the API is released first.

## Stable Releases

When changesets are merged to `main`, the `Release` workflow opens or updates a release PR with
the version bump, `CHANGELOG.md` and the lockfile. Merging it publishes the npm package with
provenance, creates the Git tag and GitHub Release, and publishes, scans and signs the image.

The `NPM_TOKEN` repository secret needs publish access before the first release PR is merged.
