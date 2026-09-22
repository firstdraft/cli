# Releasing First Draft CLI

An approved coordinated release publishes directly to npm's `latest` channel. Tests and review belong before merge;
publication reuses successful CI for the exact source. It does not repeat the suite or require a second
`next`-to-`latest` promotion. Dated observations remain in [release history](docs/release-history.md).

A merge alone does not authorize publication. Obtain one approval for the intended coordinated release, or use the
approval already given for that scope. The existing GitHub `npm` environment protection still applies; its approval
executes the same release decision. Do not ask for another conversational approval between already-approved steps.

## Version and compatibility policy

Before `1.0.0`, use ordinary `0.MINOR.PATCH` versions: increase `MINOR` for a breaking compatibility-line change and
`PATCH` for a backward-compatible change within that line. Never reuse a published version or move a protected
release tag. An unpublished, untagged candidate can retain its proposed version while its source changes.

CLI `0.4.x` makes `firstdraft plan compile` equivalent to `firstdraft plan compile --output .`; the former GitHub
default becomes explicit `--github`. This is a breaking CLI change from `0.3.x`, without a Service API change.
Both lines use API `0.4.x`, Plan `firstdraft.foundation-plan.sketch/0.20`, target `rails-sketch/2026-09`, and the
`.firstdraft/design` root archive. Existing applications and old Plans are not migrated.

`release/compatibility.json` declares the package version, accepted API-contract range, and accepted Plan formats.
It is source-only metadata, validated by the normal test suite and absent from the npm tarball. Coordinate the
explicit CLI comparator and bundled CLI pin in `firstdraft/skills` when this version changes. The service's
`script/release_compatibility_check` compares the three exact revisions; compatibility establishes eligibility,
not authorization or runtime proof. Its closed `firstdraft.release-compatibility/1` format rejects unknown keys.

## Prepare before merge

1. Update `package.json`, `package-lock.json`, and `release/compatibility.json`, and align the Skills CLI requirement.
2. Update the command, error, and Skill guidance affected by the change. Preserve dated release evidence.
3. Run focused checks while developing and the repository's required CI for the merge candidate. For a fresh
   checkout, the complete local check is `npm ci --ignore-scripts`, `npm audit`, then `npm run check`.
4. Review and merge the change. Wait for the existing `CI` workflow to pass for the selected `main` SHA; publication
   uses that run instead of starting another one.

Use existing smoke evidence when it covers the changed behavior. If changed CLI/Service/Skill behavior warrants a
live smoke, use a simple Plan, compile locally with `firstdraft plan compile --output .`, and boot the generated app locally
when runtime behavior changed. A CLI dispatch-only change can be covered by local command and packed-package tests.
Do not require Codespaces, GitHub Publication, native builds, or Revyl for a routine release. Codespaces is a fallback
development environment. Additional integration checks belong only to changes affecting those integrations.

## Publish the approved source

From a clean checkout of the selected `main` revision:

1. Confirm the exact package version and `v<package-version>` tag are both unused. If either identity is already
   consumed, prepare the next version required by the pre-1.0 policy rather than moving or reusing it.
2. Confirm the intended three revisions are compatible and the coordinated release approval covers them.
3. Create and push `v<package-version>` at that source revision. Push one release tag at a time; the workflow
   serializes publication and GitHub retains at most one pending run in a concurrency group.
4. Approve the existing `npm` environment deployment for that tag. The workflow publishes with provenance under
   `latest`; no separate dist-tag mutation is needed.

The workflow requires a protected `v*` tag in `firstdraft/cli`, the matching `package.json` version, an unchanged
remote tag, and a commit in the first-parent history of protected `main`. It finds a successful `CI` push run for
that exact SHA using `gh run list`, checks the package file allowlist, then rechecks mutable refs after environment
approval. It does not install development dependencies, rerun tests or audit, or request interactive npm login.

If CI is still running, let that run finish and rerun the failed publication verification job. Resolve failing
checks in CI itself; publication does not start a duplicate suite. A source fix after tagging requires a new version.
Do not retest unrelated surfaces merely because time has passed since merge.

## Verify and recover

After publication, inspect the registry before retrying a failed workflow; the immutable version may already exist:

```sh
FD_CLI_RELEASE_VERSION="$(node -p "require('./package.json').version")"
npm view "@firstdraft.com/cli@$FD_CLI_RELEASE_VERSION" \
  version dist.integrity dist.shasum dist.attestations repository.url engines bin --json
npm dist-tag ls '@firstdraft.com/cli'
```

Confirm the intended version is `latest` and has integrity/provenance metadata. Install that exact version in a
temporary prefix, confirm `firstdraft --version`, and run `npm audit signatures` there to verify the published
artifact. This checks distribution; it does not repeat application qualification. Record the version, source,
package integrity, and any relevant smoke evidence in the dated release record.

If OIDC authentication fails, reconcile the registry version and protected tag before retrying. Correct a broken
trusted-publisher relationship when necessary, then rerun failed jobs at the existing tag. If the tagged workflow
identity itself is wrong, prepare a new version; never move the tag or add a persistent-token fallback.

For a bad release, move `latest` to a known-good compatible version as an incident rollback, or deprecate the bad
version and publish a corrected higher version. Unpublishing is exceptional incident response, not routine rollback.

## Publisher configuration

These are durable repository and npm controls, not a per-release account audit. Verify them when provisioning,
changing publisher configuration, or diagnosing an actual failure:

- `firstdraft/cli` is public; `main` requires pull requests and CI, and a `v*` ruleset restricts tag mutation.
- The `npm` GitHub environment is limited to release tags, requires its existing reviewer, disables administrator
  bypass, and defines `NPM_RELEASE_ENABLED=true`.
- npm trusted publishing identifies package `@firstdraft.com/cli`, repository `firstdraft/cli`, workflow
  `publish.yml`, environment `npm`, and permission `createPackage`. The publishing account retains the intended
  organization access and write-protecting 2FA. Configure these with an administrator only when needed.
- Publication runs on a GitHub-hosted runner with `id-token: write`, pinned Node.js 24.18.0 and npm 11.16.0. npm's
  short-lived OIDC exchange is the only publication credential; no persistent npm token or Actions secret is used.
  The CI lookup uses GitHub's read-only workflow token.

Ordinary installation and use require no npm login. Ordinary trusted publication requires no local maintainer
login or per-release security-key ceremony. Request npm interaction only when npm requires it for a governance
change or an actual authentication failure. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
