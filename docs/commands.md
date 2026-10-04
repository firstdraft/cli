# First Draft CLI command reference

This page owns the detailed public semantics of the current command surface. Run `firstdraft --help` or a command
group's `--help` for concise executable syntax. See [Errors and recovery](errors.md) before retrying a failed mutation.

The current `0.8.x` source line contains the auditable command shell, browser and device login, local Foundation Plan initialization, local
application-key and UUID generation, conditional whole-document push, whole-graph analysis status polling, direct
Compile-and-materialize and private publish orchestration, and retained-Compilation inspection and cancellation.
CLI `0.8.x` requires the service's `0.7.x` API contract. The
[changelog](https://github.com/firstdraft/cli/blob/main/CHANGELOG.md) describes each version.

## Command map

| Command                               | Network | Purpose                                                     |
| ------------------------------------- | ------- | ----------------------------------------------------------- |
| `firstdraft plan init`                | No      | Create an empty local Foundation Plan and Project identity  |
| `firstdraft generate application-key` | No      | Preview deterministic name-to-key derivation                |
| `firstdraft generate uuid`            | No      | Generate one or more Foundation Plan subject identities     |
| `firstdraft login`                    | Yes     | Approve the CLI in a browser and save a token for an origin |
| `firstdraft logout`                   | Yes     | Revoke and remove the saved token for an origin             |
| `firstdraft plan push`                | Yes     | Conditionally submit the exact whole Plan                   |
| `firstdraft plan status`              | Yes     | Read or wait for the current whole-graph analysis           |
| `firstdraft plan compile`             | Yes     | Push and analyze, then materialize in the current folder    |
| `firstdraft plan compile --github`    | Yes     | Push and analyze, then publish to private GitHub            |
| `firstdraft compilation status`       | Yes     | Inspect a retained Compilation by ID                        |
| `firstdraft compilation download`     | Yes     | Verify and materialize a successful retained Compilation    |
| `firstdraft compilation cancel`       | Yes     | Cancel a queued or running Compilation by ID                |

## Select an environment and authenticate

Production at `https://firstdraft.com` is the default. Log in once per environment:

```sh
firstdraft login
```

The command prints an authorization URL on standard error. Open it in a browser on the same machine, sign in, and
approve **First Draft CLI**. The CLI then saves a token and prints `Logged in to <origin>` on standard output.

For staging, select it on the login and on the first remote command:

```sh
firstdraft --staging login
firstdraft --staging plan push
firstdraft plan compile --staging
```

### How login works

The default login uses the OAuth 2.0 authorization code flow with PKCE (`S256`) and a loopback redirect
(RFC 8252). The CLI listens on `127.0.0.1` at an ephemeral port for one `GET /callback`, sends a random `state`
and code challenge, and waits up to five minutes. Only a callback with the exact `state` is accepted. Requests
for other paths, with a missing or different `state`, or with another `Host` get an error page and do not end
the wait, so a stray local request can neither inject a code nor cancel the login. The first matching callback
closes the listener and shows a page that says you can close the tab. The CLI then exchanges the single-use code
and its PKCE verifier at `POST /oauth/token`. The token never appears in a URL.

On a machine without a browser, such as an SSH session or a container, use the device flow (RFC 8628):

```sh
firstdraft login --interactive   # also -i or --device
```

The CLI prints a verification URL, a short user code, and a URL that already includes the code. Open either URL on
any device, confirm the code, and approve. The CLI polls at the server's interval, adds five seconds when asked to
slow down, and stops when the code expires.

Both flows send this machine's hostname as the device name shown on the approval page and in the token's name on
`/api-tokens`. A denied approval exits with `authorization_denied`. A login that is not approved in time exits with
`authorization_expired`. Other failures exit with `login_failed`. No credential is saved unless the login succeeds.
See [Errors and recovery](errors.md#login-and-logout-errors).

### Saved credentials

The token is saved in `$XDG_CONFIG_HOME/firstdraft/credentials.json`, or `~/.config/firstdraft/credentials.json`
when `XDG_CONFIG_HOME` is unset or not absolute. The directory is created with mode `0700`. The file is written
with mode `0600` through a temporary file and an atomic rename. Each update holds `credentials.json.lock` in the
same directory from its read to its rename, so concurrent commands cannot drop each other's entries. An update
waits up to 10 seconds for another command's lock, then fails with reason `credentials_locked`. The CLI never removes
a lock by itself: if no other `firstdraft` command is running, the lock was left by one that exited mid-update, and
you can delete it. The file stores one entry per exact origin, so production, staging, and local development logins
can exist side by side. Logging in again to the same origin replaces its
entry. Run `firstdraft logout` first if the old token should also be revoked. The CLI never prints a saved token or
writes it to `.firstdraft`.

`firstdraft logout` (or `firstdraft --staging logout`) asks First Draft to revoke the saved token for the selected
origin through `POST /oauth/revoke`. It then removes the local entry even when revocation cannot be confirmed; in
that case it says so on standard error, and you can revoke the token on `/api-tokens`. With nothing saved, it
reports that and exits 0. If a newer login saved a different token for the origin while revocation was pending,
logout keeps that token and says so on standard error. If the local update fails after revocation, logout exits with `logout_failed` and reports
whether revocation was confirmed; see [Errors and recovery](errors.md#login-and-logout-errors). Logout never changes
token environment variables.

### Environment tokens

Tokens from the environment still work and take precedence over a saved login. Create one on
[First Draft](https://firstdraft.com/api-tokens) and provide it through `FIRSTDRAFT_API_TOKEN`. For staging, create a
separate token at [First Draft staging](https://staging.firstdraft.com/api-tokens) and provide it through
`FIRSTDRAFT_STAGING_API_TOKEN`. Keep token values out of shell history and command arguments. `login` and `logout`
note on standard error when an environment token will override the saved login.

### Origins and projects

`--staging` may precede the command group or appear among a remote command's options, including `login` and
`logout`. It selects `https://staging.firstdraft.com`. `plan init` and `generate` remain local; a global flag on a
local command does not save an environment selection. The first successful push, including the push within
`plan compile`, pins the API origin in `.firstdraft/state.json`.

Existing Projects keep their pinned origin with or without the flag. A CLI upgrade does not migrate a Project or its
credentials. A staging flag that disagrees with a Project's pin stops before any request.
To work with another environment, initialize a separate project directory and submit the Plan there; do not edit
the existing Project's private state to redirect it.

`FIRSTDRAFT_API_URL` remains available for an initial custom HTTPS origin or loopback HTTP development server, and
it also selects the origin for `login` and `logout`, for example `FIRSTDRAFT_API_URL=http://127.0.0.1:3000
firstdraft login`. `--staging` together with a different URL is an error; the equivalent normalized staging URL is
allowed. Later pushes and compilation reject an override that differs from the pin. Status, retained download, and
cancel commands use the pin and ignore `FIRSTDRAFT_API_URL` unless checking its conflict with an explicit
`--staging`.

Every remote command selects credentials from its effective origin. First it uses the environment: the exact
`https://staging.firstdraft.com` origin uses `FIRSTDRAFT_STAGING_API_TOKEN`; production and custom origins use
`FIRSTDRAFT_API_TOKEN`. When that variable is unset or empty, it uses the token saved by `firstdraft login` for that
exact origin. No token is a fallback for a different origin: neither environment variable substitutes for the other,
and a saved login for one origin never authenticates another. This includes existing staging Projects and retained
status or artifact reads, even when no flag is supplied. An unreadable or malformed credentials file counts as no
saved login.

The CLI sends the selected token as a Bearer credential on every API request. It does not save it in `.firstdraft`,
print it, or require it for local commands. Revoke a token in the environment that issued it if it is exposed. A
missing token, or First Draft's validated `401` problem response with the `authentication_required` code, produces
that stable CLI error.

## Start a Foundation Plan

From the project that the Plan describes:

```sh
firstdraft plan init --name "Oscar Party"
```

This creates an empty `firstdraft.foundation-plan.sketch/0.23` Plan targeting `rails-sketch/2026-09-bookmark-assets` and a
client-generated Project ID under `.firstdraft/`. A nested ignore file keeps that local scratch area out of Git
without changing the project's own `.gitignore`. Initialization makes no network request and refuses to replace an
existing `.firstdraft` path.

Provide either `--name`, `--application-key`, or both. Name-only initialization derives a lower-snake key. Key-only
initialization derives a humanized display name. Supplying both preserves both values exactly after validating them
against the Foundation Plan schema.

Plan `0.23` has no `application.pwa` option. The Rails target includes ordinary icons and bookmark metadata for
the application owner to edit. The CLI sends authored bytes unchanged; the Service diagnoses unsupported Plan
fields rather than the CLI removing them. These assets do not establish offline support or a complete PWA, and
the CLI does not qualify browser or device installation.

### Generate an application key

To inspect the name-to-key derivation without initializing a project, run:

```sh
firstdraft generate application-key --name "Oscar Party"
```

The generated key is deterministic, starts with a letter, contains only lowercase ASCII letters, digits, and
underscores, and is at most 63 bytes so it can lower to the current iOS application identifier component. Names
without a readable ASCII form receive a stable digest-based key. Longer readable names are shortened to a readable
prefix plus a stable digest suffix. Explicit application keys retain the Foundation Plan's broader
`^[a-z][a-z0-9_]*$` boundary and are left for target analysis rather than silently rewritten.

### Generate Foundation Plan subject identities

Generate an identity before adding each new independently mutable authored subject:

```sh
firstdraft generate uuid
```

The command prints one UUIDv7 for the subject's `subject_uuid`. It does not read or modify the Plan, reserve the
value, or make a network request. Preserve that UUID when renaming the subject or moving it to a different semantic
owner without changing its kind. Use a new UUID for a replacement concept. Readable keys and paths may change and
remain the document's links; the UUID preserves continuity between complete-document pushes.

Use `--count <n>` to print several independently generated UUIDv7 values, one per line.

## Push a Foundation Plan

From the initialized project:

```sh
firstdraft plan push
```

The command sends the exact bytes in `.firstdraft/foundation-plan.json`. The first push conditionally creates the
Project; later pushes replay the complete ETag saved in `.firstdraft/state.json` so a stale writer cannot replace a
newer Plan. Successful responses and server diagnostics are printed as JSON for an agent to inspect.

The first successful push pins the normalized API origin in local state. See
[environment selection and authentication](#select-an-environment-and-authenticate) for production, staging, custom
origins, and the credentials each requires.

If a failure happens after sending the request, the CLI leaves local state unchanged. It never constructs an ETag
from the Plan digest or trusts an ETag from a response it could not fully verify. Follow
[ambiguous-mutation recovery](errors.md#ambiguous-mutations) rather than blindly retrying.

## Read analysis status

After a successful push:

```sh
firstdraft plan status
firstdraft plan status --wait
```

Without `--wait`, the command makes one `GET` and prints the current analysis as one JSON object. With `--wait`, it
polls sequentially once per second for at most two minutes and stops at `valid`, `issues_found`, `analysis_failed`,
or `superseded`. Every validated analysis status is a successful read with exit 0; agents should branch on the
`analysis.status` value and inspect `analysis.diagnostics` rather than treating a completed analysis with issues as
a transport failure.

The projection includes the exact [Head](#head-and-its-etag) digest, Analyzer and Compiler releases, selected target,
and `analysis.gap_set` plus `analysis.gap_set_sha256`. A `valid` run always returns the complete parsed canonical
`firstdraft.foundation-gaps/2` object, including every ordered gap record and an empty `gaps` array when nothing is
missing. Both GapSet fields are `null` for every other status. The CLI validates the GapSet's Head, Project,
generation, releases, target, canonical digest, and complete record shapes, then prints the records without
truncating or rewriting them.

Status reads require the API origin pinned by a successful push. They never select an origin from the current
environment, expose the private ETag, follow redirects, or modify local state. Each request has a bounded timeout,
ordinary response reads retain a 2 MiB bound, while this potentially gap-heavy response has a dedicated 128 MiB
bound. Every response is fully validated, and polling will not silently switch to a replacement analysis. The wait
repeats only validated `processing` responses and stops on its first failed read. A network failure is safe to retry
a bounded number of times because the command sends only `GET` requests. See
[read-only failures](errors.md#read-only-status-failures) if the problem persists.

## Compile the current Plan

Compile into the current local folder:

```sh
firstdraft plan compile
```

This is equivalent to `firstdraft plan compile --output .`. Use `--output ./application` for another absent
directory, or `--github` to publish to a private GitHub repository. `--github` and `--output` are mutually exclusive.
No GitHub connection, repository clone, or push is required for local compilation. Compilation runs on the First
Draft service; output and the application runtime are local.

Both `plan compile` modes first push the exact current bytes in
`.firstdraft/foundation-plan.json`, even when those bytes are unchanged, and save the accepted ETag using the same
contract as `plan push`. It then waits up to two minutes for an analysis whose graph version and
`head_source_sha256` exactly match that accepted push, polling past a terminal result retained for an older Head.
Invalid JSON, schema diagnostics, semantic diagnostics, a failed analysis, a superseded analysis, or a recurring
diagnostic stop the command with structured output; no Compilation or Publication is requested.

Only a `valid` analysis proceeds to the selected completion mode. Immediately before either conditional mutation,
the CLI re-reads the local Plan and requires its exact bytes and saved state to match the accepted Head. It extracts
the accepted source SHA-256 from the saved ETag, hashes the current local bytes, and sends that complete ETag in
`If-Match`.

### Materialize a direct Compilation

Without `--github`, the CLI accepts either an explicit absent destination beneath an existing real directory or a path
that resolves to the physical current directory. It validates either destination before pushing the Plan. An absent
destination is checked again after analysis; root adoption instead holds its owned lock and performs the exact
pre-move identity recheck described below. Other existing destinations remain invalid, so
`--output ./application` retains its absent-directory contract.

The default `--output .` is the noninteractive root-adoption mode. `./`, an absolute spelling of the current directory, and
another spelling that resolves to that same physical directory select the same mode. It works at any real current
directory that meets the preconditions below and does not recognize Drawing Board or another repository layout
specially. Root adoption supports POSIX filesystems; on Windows, use `--output ./application` because current-folder
output returns `root_platform_unsupported`. Before starting Compilation, the CLI requires:

- the current directory to be a real, writable, non-filesystem-root directory;
- no existing `.firstdraft/design` archive or top-level `.firstdraft-root-output` transaction path, including
  portable, case-insensitive spellings;
- every top-level entry other than `.git` to be a regular file or real directory on the current directory's
  filesystem. Interior symlinks, dependency trees, sockets, and nested repositories move opaquely with their
  top-level directory; the CLI neither follows nor repairs them; and
- when the current directory is the root of a Git worktree, a clean tracked worktree and index with no unmerged
  entries, sparse checkout, or in-progress merge, rebase, cherry-pick, or revert. Untracked and ignored design
  material may remain present. Submodules and tracked `.gitmodules` files are refused in this first root-adoption
  contract rather than moved with broken Git wiring. A directory nested inside a higher Git worktree is refused
  rather than treated as non-Git. A valid top-level `.git` file for a linked worktree is retained like a `.git`
  directory.

Git-backed root adoption invokes the installed Git executable explicitly. Read-only discovery uses
`git --no-optional-locks` with stable NUL-delimited porcelain so it does not refresh the index. Before remote work,
the CLI verifies in a temporary preview that every currently ignored entry remains ignored after its path and
applicable worktree `.gitignore` files move beneath `.firstdraft/design`; repository-local and configured global
exclusions are both honored. A refusal is `invalid_output_path` with a machine-readable `reason` and happens before Plan push.

The CLI creates `.firstdraft-root-output` with exclusive creation during the pre-push output check and holds it
through analysis, Compilation, and materialization. That directory is both the single-writer lock and the owned
transaction journal, so a concurrent root adoption is refused before either command sends a request. Immediately
after acquiring it, the CLI captures every other top-level entry's exact name, entry type, device, and inode. After
staging the artifact and any replacement Git index, it rechecks that set immediately before moving anything. Size,
modification time, and contents are deliberately not part of this identity: interior changes are not recursively
inventoried, and a top-level directory moves intact at the transaction boundary. A replaced, added, or removed
top-level entry stops materialization. The reserved-path precondition ignores only the transaction directory
created and still held by this invocation.

`compilation download --output .` acquires the same lock before its first status request and holds it through
artifact download and materialization. Either command removes its own transaction directory on every ordinary exit
before the journal records an irreversible move or index installation. Its signal handlers do the same when Node
dispatches the signal before that boundary. A journal whose phase records no irreversible operation is likewise
safe to remove; the manual reconciliation rule below applies only after `root_rollback_incomplete`.

The complete generated artifact is written and verified inside that in-root transaction directory before any
existing path moves. Staging inside the destination makes every later rename same-filesystem even when the current
directory itself is a container mount point. The artifact may not own `.firstdraft/design`, its descendants, or
the top-level `.firstdraft-root-output` path, including portable, case-insensitive spellings. `.firstdraft` must be
a directory with that exact spelling when present; artifact validation already excludes `.git` at any depth.

The transaction creates `.firstdraft/design` inside the verified artifact stage with mode `0755` on POSIX and moves
every preexisting non-Git top-level entry beneath it. It keeps an existing top-level `.git` file or directory at the
root, then installs the artifact's top-level entries there. Installing the staged `.firstdraft` places the archive
directly at `.firstdraft/design`; there is no intermediate top-level `design` directory. The original planning
`.firstdraft` remains intact at `.firstdraft/design/.firstdraft`, separate from the generated submitted Plan and
gaps at `.firstdraft/`.

Immediately before each artifact entry is installed, its root destination must still be absent; an unexpected
entry stops the transaction and is never overwritten. If the root contains no entry other than `.git`, it does not
retain an empty archive. A nested mount that cannot travel with its top-level directory may make its rename fail;
that is a transactional failure, not permission to copy or traverse the mount.

For a Git root, the CLI first prepares a replacement index that stages each formerly tracked path at
`.firstdraft/design/<old-path>` and stages every exact generated artifact path at the root. This handles overlapping
names such as `README.md` and `.gitignore` without leaving the old design blob indexed at a generated path. Previously
untracked and ignored paths are never added to the index. Preparing that index writes the generated blobs into the
Git object database; a rollback may therefore leave unreachable blobs for ordinary Git garbage collection, while
`HEAD`, refs, configuration, and history remain unchanged. After the worktree renames finish, the CLI installs the
prepared index through Git's actual index lock path and atomic lock-file commit protocol, including in a linked
worktree whose index is outside the adopted root. The transaction journal retains whether an index existed plus an
exact private copy, mode, and digest of its prior bytes until final verification succeeds. The preflighted ignore
protection is rechecked after the move. The caller should inspect and commit this staged root-adoption change before
using destructive worktree or index restoration commands. A non-Git root remains non-Git and is not initialized.

The journal is a versioned private JSON record plus owned staging files. It records the physical root and original
top-level identity set, the transaction phase, completed design and artifact renames, and, for Git, the resolved
index path and original and prepared index digests. Each irreversible phase is recorded before the next one starts.
On any failure after a move, index installation, or post-install verification, the CLI first restores the exact
prior index through the same Git lock boundary, then reverses artifact moves in reverse recorded order, followed
by design moves in reverse recorded order. Reversing the installed `.firstdraft` first returns the archive to
staging so the original planning `.firstdraft` can move back to its original root path. A fully
successful rollback removes only the owned transaction. If rollback itself cannot finish,
`materialization_failed` reports `reason: "root_rollback_incomplete"` and includes
`recovery_path: ".firstdraft-root-output"`; it leaves the journal and owned copies in place rather than guessing.
Do not delete that directory or run Git restoration commands. Follow the
[manual recovery order](errors.md#direct-compilation-recovery), reconcile the versioned journal with the current
path identities, and verify its original snapshot before removing the transaction directory. Another root adoption
reports `root_busy` until that state is reconciled; a foreign preexisting directory with the same reserved name
reports `root_reserved_path`.

After valid analysis, the CLI requests one Compilation for that exact reviewed Head and never starts GitHub
Publication. It validates that the `202` response identifies the same Project, graph version, Head, Analysis,
Compiler release, and target; polls only that retained Compilation for up to ten minutes; downloads its exact
artifact; and applies the same integrity and atomic materialization contract as `compilation download`. An ambiguous
Compilation start is not retried automatically. After a validated `202`, later status, artifact, authentication,
and materialization failures retain the last validated Compilation projection so the caller can recover by ID
without starting duplicate work. Follow the [direct Compilation recovery procedure](errors.md#direct-compilation-recovery).

Success writes one JSON object to stdout containing the validated Project, Compilation, and absolute output path.
Root adoption additionally reports `root_adoption.design_path` (or `null` when no design directory was needed), its
top-level moved-entry count, whether a Git repository was preserved, and whether its index was replaced.
After final verification succeeds, the CLI removes its owned `.firstdraft-root-output` transaction directory.
An absent output directory contains exactly the artifact files and modes. Root adoption additionally contains the
preserved `.firstdraft/design` archive and an existing root `.git`, when present. Verification skips only the
archive and retained Git/transaction paths; it still checks every generated file, including
`.firstdraft/submitted-foundation-plan.json` and `.firstdraft/gaps.json`, and rejects unexpected generated paths. The
CLI does not add a Git repository, run a formatter, or repair generated source. When an absent output is nested
inside another Git worktree, initialize the application as its own repository before running generated checks that
inspect Git; otherwise Git resolves to the parent worktree. Progress on stderr reports analysis and Compilation
only.

### Publish through GitHub

Use the explicit GitHub option for the Publication journey:

```sh
firstdraft plan compile --github
```

Invoking this form authorizes the internal GitHub Publication lifecycle. The command writes stable human-readable
progress to stderr, with every line prefixed by `First Draft:`. It reports analysis, Compilation completion or
terminal failure or cancellation, the current GitHub phase, and an allowlisted reason, retry count, and exact UTC
retry time when a GitHub preflight check is delayed. A retained retry with no next time is reported as paused and
requiring operator recovery. Progress never includes IDs, hashes, repository names or URLs, raw server projections,
local paths, or environment values. Success writes exactly the validated private GitHub repository URL plus a
newline to stdout. If the command fails after progress has begun, its structured JSON error envelope is the final
stderr document after the progress lines.

The closed API `0.7.x` progress-reason allowlist is `github.configuration_missing`, `github.oauth_unavailable`,
`github.api_unavailable`, `github.reauthorization_required`, `github.account_mismatch`,
`github.installation_unavailable`, `github.installation_not_ready`, `github.preflight_unavailable`, the legacy-only
`github.preflight_unclassified`, and these stage-specific fallbacks: `github.preflight_unavailable.configuration`,
`github.preflight_unavailable.authorization`, `github.preflight_unavailable.repository_client`,
`github.preflight_unavailable.artifact_preparation`, `github.preflight_unavailable.installation_token`,
`github.preflight_unavailable.publication_preparation`, and `github.preflight_unavailable.repository_ref_client`.
Other values make the response invalid rather than becoming terminal output.

The internal Publication is a Project singleton in this release. A repeat safely receives the same Publication
instead of creating another. If the first conditional `PUT` has an ambiguous result, the CLI reconciles it with one
read-only singleton `GET` and never automatically repeats the mutation within that invocation. Publication polling
is sequential, bounded to ten minutes, and pinned to the retained Project Head, Compilation input, Publication
identity, and repository identity. Do not run concurrent Compile commands; use the
[publication recovery procedure](errors.md#publication-recovery) after an invocation exits.

This release cannot repoint a Project's Publication to a later accepted Head. The public CLI therefore has no
`plan publish` command. Direct local Compilation and GitHub Publication are separate completion modes after the same
exact Plan push and valid Analysis.

## Inspect a retained Compilation

These lower-level commands are for callers that already hold a retained Compilation ID from authenticated API
metadata or operational tooling. `plan compile --github` prints only the final repository URL, while the default
`plan compile` form waits for and downloads its own direct Compilation:

```sh
firstdraft compilation status 01900000-0000-7000-8000-000000000001
firstdraft compilation status 01900000-0000-7000-8000-000000000001 --wait
```

Without `--wait`, the command makes exactly one metadata-only `GET`. With `--wait`, it polls that same Compilation
sequentially for at most ten minutes and rejects changes to its identity, Head provenance, target, or lifecycle
progression. `failed` and `cancelled` are successfully read terminal states with exit 0; branch on
`compilation.status` and inspect its validated `failure`.

## Download a retained Compilation

Materialize an already successful Compilation into an absent path:

```sh
firstdraft compilation download 01900000-0000-7000-8000-000000000001 --output ../movie-catalog
```

The same command accepts `--output .` and applies the root-adoption transaction above. This is the recovery path
when a retained direct Compilation succeeded but an earlier root materialization failed _and fully rolled back_; it
never starts replacement work. An incomplete rollback leaves `.firstdraft-root-output` and requires journal
reconciliation before this command can run again.

Artifact validation accepts only Plan format `firstdraft.foundation-plan.sketch/0.23` and target profile
`rails-sketch/2026-09-bookmark-assets`, in addition to matching the retained Compilation's provenance and verifying file integrity.
An earlier format or profile is rejected before materialization, even when the retained status names that profile.

Successful root adoption is intentionally one-way. The original `.firstdraft` authoring state moves under
`.firstdraft/design/.firstdraft`; run later First Draft commands from `.firstdraft/design`. Run ordinary Rails
setup, preview, and tests from the generated application root. Retain the archive when further First Draft
authoring is useful. The CLI does not run or qualify the generated application's setup, preview, or test commands.
Compiling a later Plan revision does not overwrite an already adopted root: choose a new absent output and
deliberately reconcile it with application work.

The command validates the UUID and output path before network access, makes one status `GET`, requires `succeeded`,
and makes one artifact `GET`. It never starts work or polls. Historical artifact validation uses the retained
`compilation.head_source_sha256`, not the current local Plan or ETag, to pin the artifact's exact
`head_source_sha256`. The artifact's canonical `foundation_plan.sha256` may differ because it identifies the
normalized Compiler input. It is validated as a SHA-256 digest inside the exact artifact bytes authenticated by the
status response's `artifact.sha256`; it is not equated to the submitted Head digest.

Before materialization, the CLI verifies the artifact media type, declared and actual byte sizes, strong digest
ETag, exact-byte SHA-256, canonical UTF-8 JSON envelope, provenance, metadata-only manifest digest, portable paths,
strict Base64 contents, file digests, modes, owners, and source-subject UUIDs. It writes only into a uniquely created
sibling directory, verifies the complete tree, and atomically renames it into the still-absent destination. On
POSIX, directories use mode `0755` and files use artifact-declared `0644` or `0755`; Windows verifies structure,
contents, and digests without claiming POSIX mode bits. The declared and streamed artifact envelope is bounded at
128 MiB.

## Cancel a stuck Compilation

A Project allows one active Compilation. While it is queued or running, First Draft refuses to replace the Plan or
start another Compilation with `409 compilation_active`, so `plan push` and `plan compile` fail. If that Compilation
will not finish, for example because its worker process died, cancel it from the Project's directory:

```sh
firstdraft compilation cancel 01900000-0000-7000-8000-000000000001
```

The `compilation_active` problem names the active Compilation's ID in its `response.detail`, and a `plan compile`
failure after a validated start carries it as `current.compilation.id`. Read the Compilation with
`compilation status` first. Cancelling one that is still making progress throws away its work, and the next
`plan compile` starts over.

The command validates the UUID before network access and makes one `POST` to the origin pinned for the Project, with
that origin's credential. It sends no Plan bytes or precondition header and changes no local state. Success prints
the validated cancelled Compilation in the same shape as `compilation status`, with `compilation.status` set to
`cancelled`. First Draft clears the Project's active Compilation, so the next `plan push` or `plan compile` can
proceed. A worker that finishes later cannot attach an artifact to a cancelled Compilation; stopping that worker is
best effort.

Cancel is idempotent for queued, running, and cancelled Compilations, so repeating it prints the same cancelled
Compilation. First Draft never changes a succeeded or failed Compilation: it answers
`409 compilation_not_cancellable`, which the CLI reports as `compilation_cancel_rejected`. Because a repeat is
safe, an outcome the CLI cannot confirm is `compilation_cancel_unavailable` rather than `request_outcome_unknown`.
See [stuck Compilation recovery](errors.md#stuck-compilation-recovery).

If the Compilation was started by `plan compile --github`, Cancel also cancels the Project's Publication. The
Publication is a Project singleton in this release, so `plan compile --github` cannot start another one for that
Project.

## Service endpoints

The CLI calls these Service API routes. The `/v1` routes go to the origin pinned for the Project and send the
selected token as a Bearer credential. The `/oauth` routes go to the origin selected for `login` or `logout` and
send form-encoded OAuth parameters without a Bearer credential. Every request refuses redirects and has a bounded
timeout. Each request takes its method and path from one
`SERVICE_ROUTES` entry in `src/api-response.js`. `test/service-endpoints.test.js` fails when this table and
`SERVICE_ROUTES` differ, or when no file in `src/` uses a declared route.

| Method | Path                                                               | Purpose                              |
| ------ | ------------------------------------------------------------------ | ------------------------------------ |
| `PUT`  | `/v1/projects/{project_id}/foundation-plan`                        | Create or replace the Head           |
| `GET`  | `/v1/projects/{project_id}/analysis`                               | Read the Head's current analysis     |
| `POST` | `/v1/projects/{project_id}/compilations`                           | Start a Compilation of the Head      |
| `GET`  | `/v1/projects/{project_id}/compilations/{compilation_id}`          | Read one retained Compilation        |
| `POST` | `/v1/projects/{project_id}/compilations/{compilation_id}/cancel`   | Cancel that Compilation              |
| `GET`  | `/v1/projects/{project_id}/compilations/{compilation_id}/artifact` | Download that Compilation's artifact |
| `PUT`  | `/v1/projects/{project_id}/github-publication`                     | Start or rejoin the Publication      |
| `GET`  | `/v1/projects/{project_id}/github-publication`                     | Poll or reconcile the Publication    |
| `POST` | `/oauth/token`                                                     | Exchange a login grant for a token   |
| `POST` | `/oauth/device_authorization`                                      | Start a device-flow login            |
| `POST` | `/oauth/revoke`                                                    | Revoke a saved token                 |

`plan push` sends the Plan `PUT`, and `plan status` reads the analysis. `plan compile` does both. It then starts a
Compilation, polls it, and downloads its artifact. With `--github`, it starts and polls the Publication instead.
`compilation status` reads one retained Compilation. `compilation download` reads it and downloads its artifact.
`compilation cancel` cancels it.
`login` exchanges its authorization code at `/oauth/token`. With `--interactive`, it starts at
`/oauth/device_authorization` and then polls `/oauth/token`. `logout` calls `/oauth/revoke`. The browser, not the
CLI, opens `/oauth/authorize` and `/device`, so they have no rows.

The first push sends `If-None-Match: *`. Later pushes, the Compilation start `POST`, and the Publication `PUT` send
the saved Head ETag in `If-Match`. The cancel `POST` sends no precondition header.

The `/v1` routes belong to the API-contract range that `release/compatibility.json` accepts. The CLI does not read the
Service's `FirstDraft-API-Contract` response header. Instead, the Service's release compatibility check compares the
declared ranges before a release. The Service documents the routes in its Foundation Plan machine reference,
`docs/architecture/reference/README.md` in the private `firstdraft/firstdraft` repository.

### Head and its ETag

The Head is the exact Foundation Plan bytes that First Draft holds for a Project. The latest accepted
`PUT /v1/projects/{project_id}/foundation-plan` sets it. The Service stores those bytes unchanged. A byte change that
keeps the Plan's meaning still makes a new Head, although the Project's `graph_version` stays the same.

A successful Plan `PUT` returns a strong `ETag` of the form `"sha256:<hex>"`, quotes included. `<hex>` is the
64-character lowercase SHA-256 of the Head bytes. The CLI saves the complete header value in `.firstdraft/state.json`
and replays it in `If-Match`. `plan compile` also extracts `<hex>` to check that the local Plan still matches the
Head before it starts a Compilation or Publication. A saved ETag in any other form stops that check with
`invalid_configuration`.

The same digest appears as `head_source_sha256` in analysis and Compilation responses. To tell whether the local Plan
is the Head, compare the SHA-256 of `.firstdraft/foundation-plan.json` with `analysis.head_source_sha256` from
`plan status`. The artifact download expects an ETag of the same form over the artifact bytes.

The Service reference asks clients to replay the Plan ETag without interpreting it. This CLI parses it anyway. A
Service ETag in another form would make every `plan compile` stop with `invalid_configuration`.

## Add a command

Use this checklist when a change adds a command or subcommand. Each step names the file to change.

1. **Implement it.** Put the command's logic in a module under `src/commands/`, usually `<group>-<name>.js`. Accept
   `fetchFunction`, file system functions, clocks, and request signals as options, as the existing commands do, so
   tests can replace them. Throw a named error class for each failure the command handles. Build each Service
   request with `serviceEndpoint` and a route declared in `SERVICE_ROUTES` in `src/api-response.js`.
2. **Dispatch it in `src/cli.js`.**
   - Add a `<GROUP>_<NAME>_HELP` string, and list the command in its group's help: `PLAN_HELP`,
     `COMPILATION_HELP`, or `GENERATE_HELP`. A new group also needs a line in `ROOT_HELP` and a branch in `run`.
   - Add the branch in `runPlan`, `runCompilation`, or `runGenerate`, and a `run<Group><Name>` function.
   - Parse arguments with strict `parseArgs`. Invalid syntax writes `invalid_arguments` and exits 2.
   - A command that calls the Service also accepts `--staging` and calls `authenticateApiCommand`. It maps each
     error class to one `writeJson(stderr, …)` envelope and its exit status.
3. **Test it.**
   - Add `test/<group>-<name>.test.js`. Cover the help text, invalid arguments, the success output, and every
     handled `error` value.
   - Update the exact group help in the tests: `HELP` in `test/cli.test.js`, `PLAN_HELP` in `test/plan-init.test.js`,
     or `GENERATE_HELP` in `test/generate-uuid.test.js`. No test asserts the whole `compilation` group help.
   - Append a command that calls the Service to `REMOTE_COMMANDS` in `test/api-environments.test.js`. Some tests
     there select entries by index, so add it at the end. The command's first request must reach the pinned origin
     with that origin's token, and one `401` must produce `authentication_required`.
   - Add packed-package cases to `scripts/smoke-package.js`, including at least an invalid-arguments case.
4. **Package it.** Add each new `src/` file to the exact list in `scripts/check-pack.js`. `firstdraft/skills` keeps
   a copy of that list as `packedFileAllowlist` in `script/cli-contract/config.mjs`. The copy must change when
   Skills bundles this CLI version.
5. **Document it.**
   - In this page, add a row to the [command map](#command-map) and a section for the command. Add a row to
     [Service endpoints](#service-endpoints) for each new route, and name the command in the paragraph below the
     table.
   - In [errors.md](errors.md#error-index), add an Error index row for each new `error` value. Add recovery guidance
     when retrying the command is safe in a different way than for the existing commands.
   - When the Skill will call the command, update the Skill's CLI references and contract checks in
     `firstdraft/skills` with its CLI pin.
6. **Review it.** New command names, flags, `error` values, and exit statuses need the independent review named in
   `AGENTS.md`.
7. **Version it.** Choose the next version with the
   [version rule](https://github.com/firstdraft/cli/blob/main/RELEASING.md#versions), and apply it with the
   [version pull request](https://github.com/firstdraft/cli/blob/main/RELEASING.md#prepare-the-version-pull-request)
   steps. If the command needs a route or response that the accepted API range lacks, the Service ships it first
   under a new API-contract version. Then raise `requires.api_contract` in `release/compatibility.json`, and align
   the Skills CLI requirement. Because the CLI does not read the contract header, an older Service rejects the new
   route as not found.
