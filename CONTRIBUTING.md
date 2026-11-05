# Contributing

## Development

Use Node.js 24 LTS and the pnpm version pinned in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm verify
pnpm verify:package
pnpm --filter @azurdream/meowpush-app-connect exec playwright install chromium firefox webkit
pnpm test:e2e
```

`pnpm verify` runs type checks, unit tests and all package builds. Package checks
inspect the tarball contents, install it in an isolated consumer and check exports,
SSR imports, TypeScript declarations and browser-script integrity. Browser evidence
is written outside the repository. To run a command for one package, use
`pnpm --filter @azurdream/meowpush-app-connect <command>`.

Public package names use the `@azurdream` scope, for example
`@azurdream/meowpush-app-connect`. New packages belong under `packages/` and should
define their own scripts, exports, `files` allowlist and publishing metadata. Mark internal
packages with `"private": true`.

## Changesets

Packages use independent [Changesets](https://changesets.dev/guide/getting-started)
versions and changelogs. For a user-facing change, run `pnpm changeset`, select the
affected packages and write a concise release note describing the impact on users.

Use patch for compatible fixes, minor for features, and major for breaking changes.
Before 1.0, use a minor bump for breaking changes. Documentation and tooling changes
do not need a release. Preview pending bumps with `pnpm changeset:status`.

## Releases

Public packages use the `@azurdream` scope and are released independently.

1. Merge the change and its Changeset into `master`.
2. Review the version pull request created by the release workflow. It updates
   package versions and changelogs together.
3. Merge the version pull request to run validation and publish the packages to npm.
   The workflow creates the corresponding package tags and GitHub releases.

Release tags follow `<package-name>@<version>`, for example
`@azurdream/meowpush-app-connect@1.2.3`. Keep the tag version consistent with the
published package version. Use the generated version pull request to manage
version and changelog updates.
