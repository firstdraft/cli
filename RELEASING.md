# Releasing First Draft CLI

Publishing is a separate, explicit action after a release-preparation pull request has merged. npm registry bytes
and package versions cannot be replaced, so do not create or push a release tag as a dry run.

## Coordinated candidate eligibility

`release/compatibility.json` declares this package's SemVer version, the First Draft API-contract range it accepts,
and the exact Foundation Plan formats it accepts. It is source-only release metadata and is intentionally absent from
the npm tarball. The normal test suite validates the manifest's shape, keeps its version equal to `package.json`, and
binds its Foundation Plan format to the implemented CLI constant.

The `script/release_compatibility_check` evaluator in `firstdraft/firstdraft` reads this declaration with the matching
declarations from exact, clean checkouts of `firstdraft/firstdraft` and `firstdraft/skills`. It implements SemVer 2.0
precedence. This CLI requires the service's `0.2.0` API contract because the always-present GitHub Publication
progress projection is incompatible with the strict alpha.2 response shape. Comparator arrays form one conjunction,
while `foundation_plan_formats` lists alternatives. A
prerelease satisfies a comparator set only when a comparator explicitly names a prerelease with the same major,
minor, and patch numbers; Skills therefore names this CLI alpha explicitly. `firstdraft.release-compatibility/1` is
intentionally closed. The evaluator in `firstdraft/firstdraft` rejects an unrecognized format and unknown keys, so
adding a key requires a coordinated compatibility-format bump rather than silently changing version 1.

A compatible result establishes candidate eligibility, not authorization or runtime proof. Exact Git SHAs identify
the three-repository candidate. A merge to `main` is integration only: report the merged SHA and ask the user whether
to coordinate the three repositories and promote that candidate. If promotion is declined, record the SHA as
unpromoted.

Promotion is manual and approval-gated. One operator serializes mutations: qualify the exact candidate on staging,
obtain human approval, and only then promote the approved service revision to production or authorize the
corresponding npm and plugin releases. Do not publish npm, deploy either environment, or release the plugin merely
because the compatibility check passes.

## Repository and registry setup

Before the first release, a repository administrator must:

1. Confirm `firstdraft/cli` is public. The release workflow deliberately removes checkout credentials and re-fetches
   the public release refs anonymously.
2. Protect `main` with pull-request and CI requirements, and add a `v*` tag ruleset that restricts tag creation,
   update, and deletion.
3. Create a GitHub environment named `npm`, restrict it to release tags, require an explicit reviewer, disable
   administrator bypass, and add the environment variable `NPM_RELEASE_ENABLED=true`. The workflow fails before
   publishing when this variable is absent.
4. Confirm that the `firstdraft.com` npm organization exists and that the bootstrap publisher belongs to it with
   permission to publish public packages. The publisher account must have write-protecting 2FA enabled. Before the
   first scoped tag, verify the authenticated identity, organization membership, and absence of an existing package:

   ```sh
   npm whoami
   npm org ls firstdraft.com --json
   npm view '@firstdraft.com/cli' name --json
   ```

   The last command should return `E404` before the first publication. It proves only that the package is absent;
   the first two commands establish authority over the scope. npm provides no non-mutating registry preflight that
   guarantees a new package will be accepted, but using an owned scope is npm's documented remedy for an unscoped
   similarity rejection.

5. Create a one-day granular npm token with read/write access limited to the `@firstdraft.com` scope, no
   organization-management access, and bypass 2FA enabled. The not-yet-created package cannot be selected
   individually. Add the token directly as the `npm` environment secret `NPM_TOKEN`; never put it in an Issue,
   chat, workflow file, repository file, or command history.

The token is a one-time bootstrap credential. After the package exists, use the repository-pinned Node.js 24.18.0
toolchain with npm 11.16.0 to verify the organization's durable read/write access. Grant it only if the package did
not inherit access for the `developers` team:

```sh
npm --version
npm access list packages firstdraft.com:developers '@firstdraft.com/cli' --json
npm access grant read-write firstdraft.com:developers '@firstdraft.com/cli'
```

Using an interactive npm login backed by the account's 2FA, configure trusted publishing for the exact package,
repository, workflow, and protected environment. Do not use the bypass-2FA bootstrap token for trust setup:

```sh
npm trust github '@firstdraft.com/cli' \
  --repository firstdraft/cli \
  --file publish.yml \
  --environment npm \
  --allow-publish
npm trust list '@firstdraft.com/cli'
```

Confirm the listed relationship identifies `firstdraft/cli`, `publish.yml`, the `npm` environment, and publish
permission. Before creating another release tag, merge a follow-up pull request that removes the `NODE_AUTH_TOKEN`
environment from the publish step. Then remove the GitHub secret, revoke the bootstrap token, and configure the
package to disallow token publication:

```sh
npm access set mfa=publish '@firstdraft.com/cli'
```

Confirm that the package's npm Publishing access now requires 2FA and disallows tokens. The workflow continues
through GitHub OIDC without a persistent npm credential. Apply this restriction only after the trusted publisher
has been verified.

## Previous publication attempt

The immutable `v0.1.0-alpha.1` tag records the first reviewed release candidate. On July 31, 2026, npm rejected its
unscoped `firstdraft` name as too similar to the existing `first-draft` package before creating a registry package.
Do not move or reuse that tag or version. The first organization-scoped candidate is `@firstdraft.com/cli` version
`0.1.0-alpha.2`.

## Prepare a release

1. Update `package.json`, `package-lock.json`, and `release/compatibility.json` to the exact release version.
2. When that version changes, coordinate the matching explicit CLI comparator in `firstdraft/skills` before
   qualification; an old alpha comparator intentionally makes the three-repository candidate ineligible.
3. Keep prereleases on the `next` dist-tag. Do not create `latest` until a stable release is intentionally approved.
4. Update user-facing documentation and release notes for behavior changes.
5. Run:

   ```sh
   npm ci --ignore-scripts
   npm audit
   npm run check
   ```

6. Merge the reviewed pull request only after local and hosted checks pass.

## Publish

The manual boundary is creation of the version tag. From an up-to-date, clean `main`, verify the intended commit and
then create and push `v<package-version>`. For version `0.1.0-alpha.3`, the tag is `v0.1.0-alpha.3`.
Push one release tag at a time; the workflow serializes publication, but GitHub retains at most one pending run in a
concurrency group.

The workflow rejects accidental or stale inputs unless they use a protected `v*` tag in `firstdraft/cli`, the tag
equals `v` plus the version in `package.json`, the remote tag still identifies the triggering commit, and that commit
appears in the first-parent history of `origin/main`. First-parent membership allows an older reviewed `main` state
after another change lands while rejecting intermediate commits from a merged side branch. The workflow reruns the
complete check, waits for approval in the `npm` environment, reverifies the remote refs, and publishes to the public
registry with provenance under `next`.

The tag ruleset and `npm` environment approval are the external trust boundary because a tag-push run loads its
workflow from the tagged commit. Before approving the `npm` deployment, the reviewer must confirm:

- The tag, package version, and commit SHA are the intended release.
- The commit is a known reviewed state in protected `main` history and its required checks passed.
- `.github/workflows/publish.yml` at that commit is the reviewed workflow, still selects the `npm` environment, and
  publishes the public `@firstdraft.com/cli` package only under `next` with provenance.
- The unprivileged verification job passed for that exact commit.

Do not move or reuse a release tag. If the tagged commit is not a first-parent state of `main`, merge the intended
change and prepare a new version rather than moving an already shared tag.

## Verify and recover

After publication, inspect the registry before retrying any reported failure; the package may already exist. Verify
the exact version, `next` dist-tag, integrity metadata, and provenance metadata:

```sh
npm view '@firstdraft.com/cli@0.1.0-alpha.3' \
  version dist.integrity dist.shasum repository.url engines bin --json
npm dist-tag ls '@firstdraft.com/cli'
```

Install `@firstdraft.com/cli@0.1.0-alpha.3` into a fresh temporary prefix, confirm `firstdraft --version`, compare the
packed file list with the release workflow, and run `npm audit signatures` after an exact installation.

A published version cannot be overwritten or reused. For a bad release, move `next` to a known-good version,
deprecate the bad version, and publish a corrected higher version. Treat unpublishing as an exceptional incident
response, not a routine rollback.
