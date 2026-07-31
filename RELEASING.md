# Releasing First Draft CLI

Publishing is a separate, explicit action after a release-preparation pull request has merged. npm registry bytes
and package versions cannot be replaced, so do not create or push a release tag as a dry run.

## Repository and registry setup

Before the first release, a repository administrator must:

1. Confirm `firstdraft/cli` is public. The release workflow deliberately removes checkout credentials and re-fetches
   the public release refs anonymously.
2. Protect `main` with pull-request and CI requirements, and add a `v*` tag ruleset that restricts tag creation,
   update, and deletion.
3. Create a GitHub environment named `npm`, restrict it to release tags, require a reviewer, prevent self-review,
   and add the environment variable `NPM_RELEASE_ENABLED=true`. The workflow fails before publishing when this
   variable is absent.
4. Confirm that the bootstrap publisher account has write-protecting 2FA enabled. The first publish creates this
   unscoped package under that account; organization access cannot be granted before the package exists.
5. Create a one-day granular npm token with read/write access to All Packages, no organization-management access,
   and bypass 2FA enabled. A new unscoped package cannot yet be selected individually. Add it directly as the `npm`
   environment secret `NPM_TOKEN`; never put it in an Issue, chat, workflow file, repository file, or command
   history.

The token is a one-time bootstrap credential. After the package exists, use the repository-pinned Node.js 24.18.0
toolchain with npm 11.16.0 to give the npm organization durable read/write access and configure trusted publishing:

```sh
npm --version
npm access grant read-write firstdraft.com:developers firstdraft
```

```sh
npm trust github firstdraft \
  --repository firstdraft/cli \
  --file publish.yml \
  --environment npm \
  --allow-publish
npm trust list firstdraft
```

Confirm the listed relationship identifies `firstdraft/cli`, `publish.yml`, the `npm` environment, and publish
permission. Before creating another release tag, merge a follow-up pull request that removes the `NODE_AUTH_TOKEN`
environment from the publish step. Then remove the GitHub secret, revoke the bootstrap token, and configure the
package to disallow token publication. The workflow continues through GitHub OIDC without a persistent npm
credential.

## Prepare a release

1. Update `package.json` and `package-lock.json` to the exact release version.
2. Keep prereleases on the `next` dist-tag. Do not create `latest` until a stable release is intentionally approved.
3. Update user-facing documentation and release notes for behavior changes.
4. Run:

   ```sh
   npm ci --ignore-scripts
   npm audit
   npm run check
   ```

5. Merge the reviewed pull request only after local and hosted checks pass.

## Publish

The manual boundary is creation of the version tag. From an up-to-date, clean `main`, verify the intended commit and
then create and push `v<package-version>`. For version `0.1.0-alpha.1`, the tag is `v0.1.0-alpha.1`.
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
  publishes only under `next` with provenance.
- The unprivileged verification job passed for that exact commit.

Do not move or reuse a release tag. If the tagged commit is not a first-parent state of `main`, merge the intended
change and prepare a new version rather than moving an already shared tag.

## Verify and recover

After publication, inspect the registry before retrying any reported failure; the package may already exist. Verify
the exact version, `next` dist-tag, integrity metadata, and provenance metadata:

```sh
npm view firstdraft@0.1.0-alpha.1 \
  version dist.integrity dist.shasum repository.url engines bin --json
npm dist-tag ls firstdraft
```

Install `firstdraft@0.1.0-alpha.1` into a fresh temporary prefix, confirm `firstdraft --version`, compare the packed
file list with the release workflow, and run `npm audit signatures` after an exact installation.

A published version cannot be overwritten or reused. For a bad release, move `next` to a known-good version,
deprecate the bad version, and publish a corrected higher version. Treat unpublishing as an exceptional incident
response, not a routine rollback.
