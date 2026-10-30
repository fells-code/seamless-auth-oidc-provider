# Changesets

Add a changeset for every consumer-facing change:

```sh
npm run changeset
```

Use the summary as release notes for the repos that import `@seamless-auth/types`,
not as implementation notes. Because every downstream repo depends on these
contracts, a schema change is breaking by default: say what changed and what a
consumer has to do about it.

The release workflow turns merged changesets into a version PR. When that PR is
reviewed and merged, the workflow publishes the npm package, Git tag, changelog,
and GitHub Release.
