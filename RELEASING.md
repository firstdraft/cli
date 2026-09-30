# Releasing First Draft CLI

This page covers the mechanics of publishing `@firstdraft.com/cli` to npm. The service repository coordinates each
release of the Service, this CLI, and the Skills plugin, and it owns the approval and smoke policy. A merge alone
does not authorize publication.

## Versions

Before `1.0.0`, raise `MINOR` for a breaking change and `PATCH` for a backward-compatible one. npm never accepts a
published version twice, and a pushed `v<version>` tag must not move. A fix after tagging therefore takes a new
version.

`release/compatibility.json` declares the package version, the accepted API-contract range, and the accepted Plan
formats. The tests validate it, and it stays out of the npm package. `firstdraft/skills` pins an exact CLI revision
and version and keeps a copy of the package file list. Skills updates all three when it bundles a new CLI version.

## Prepare the version pull request

1. Set the version:

   ```sh
   npm version <x.y.z> --no-git-tag-version --ignore-scripts=false
   ```

   npm updates `package.json` and `package-lock.json`. The package's `version` lifecycle then copies the version
   into `release/compatibility.json`. The last flag is required because `.npmrc` sets `ignore-scripts=true`. If it
   was left off, run `node scripts/sync-version.js --apply`.

2. Add the version's entry to [CHANGELOG.md](CHANGELOG.md): a `## <x.y.z>` heading, then what changed and what
   callers need to do. `node scripts/check-changelog.js` confirms the entry.
3. Run `npm ci --ignore-scripts`, `npm audit`, and `npm run check`. CI also fails when the version has no tag and
   no changelog entry.
4. Merge, then wait for the `CI` push run on `main` to pass. Publication reuses that run.

## Publish

1. Tag the merged commit and push the tag:

   ```sh
   git tag v<x.y.z> <sha>
   git push origin v<x.y.z>
   ```

   Push one release tag at a time. The workflow's concurrency group keeps one pending run and cancels an older one.

2. The tag starts the [publish workflow](.github/workflows/publish.yml). Its `verify` job requires:
   - a protected `v*` tag that names the `package.json` version and still points at the pushed commit;
   - a commit in the first-parent history of `main`;
   - a successful `CI` push run for that exact commit;
   - an entry for the version in CHANGELOG.md; and
   - the exact package file list.

3. Approve the pending `npm` environment deployment in the workflow run. The `publish` job rechecks the tag and
   `main`, then publishes to `latest` with provenance. It does not install development dependencies or rerun tests.

If `verify` fails because CI was still running, let CI finish and rerun the failed job. Fix a failing check in CI
itself; publication never starts a second test run.

## Verify and recover

Check the registry before retrying a failed publication, because the version may already exist:

```sh
FD_CLI_RELEASE_VERSION="$(node -p "require('./package.json').version")"
npm view "@firstdraft.com/cli@$FD_CLI_RELEASE_VERSION" \
  version dist.integrity dist.shasum dist.attestations repository.url engines bin --json
npm dist-tag ls '@firstdraft.com/cli'
```

Confirm that `latest` selects the version and that the version has integrity and provenance metadata. Install that
exact version into a temporary prefix, check `firstdraft --version`, and run `npm audit signatures` there.

If OIDC authentication fails, reconcile the registry version and the tag before retrying. Correct a broken
trusted-publisher relationship if needed, then rerun the failed jobs at the same tag. If the tagged workflow itself
is wrong, prepare a new version. Never move the tag or add a persistent npm token.

For a bad release, deprecate the version and publish a corrected higher one. Alternatively, move `latest` back to a
known-good version with the [dist-tag repair](https://github.com/firstdraft/skills/blob/main/docs/dist-tag-repair.md)
procedure. Unpublishing is exceptional incident response.

## Publisher configuration

These repository and npm settings are durable. Check them when provisioning, when changing publisher configuration,
or when diagnosing a failure, not on every release.

- `firstdraft/cli` is public. `main` requires pull requests and the `CI` checks.
- The `v*` tag rulesets limit tag creation to organization administrators. They block deleting a tag and moving it
  to a commit that does not descend from its current one.
- The `npm` GitHub environment accepts only `v*` tags, requires its reviewer, disallows administrator bypass, and
  defines `NPM_RELEASE_ENABLED=true`.
- npm trusted publishing identifies package `@firstdraft.com/cli`, repository `firstdraft/cli`, workflow
  `publish.yml`, environment `npm`, and permission `createPackage`. The publishing account keeps its organization
  access and write-protecting 2FA. Change these with an administrator only when needed.
- Publication runs on a GitHub-hosted runner with `id-token: write`, Node.js 24.18.0, and npm 11.16.0. npm's
  short-lived OIDC exchange is the only publication credential; no persistent npm token or Actions secret is used.
  The CI lookup uses GitHub's read-only workflow token.

Installing and using the package requires no npm login. Trusted publication requires no local maintainer login or
per-release security-key ceremony. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
