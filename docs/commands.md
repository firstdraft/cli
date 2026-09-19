# First Draft CLI command reference

This page owns the detailed public semantics of the current command surface. Run `firstdraft --help` or a command
group's `--help` for concise executable syntax. See [Errors and recovery](errors.md) before retrying a failed mutation.

The current `0.3.x` source line contains the auditable command shell, local Foundation Plan initialization, local
application-key and UUID generation, conditional whole-document push, whole-graph analysis status polling, direct
Compile-and-materialize and private publish orchestration, and retained-Compilation inspection. CLI `0.3.x`
requires the service's `0.4.x` API contract. See the [release policy](../RELEASING.md) for versioning and channel
semantics and [release history](release-history.md) for the transition from prereleases.

## Command map

| Command                               | Network | Purpose                                                    |
| ------------------------------------- | ------- | ---------------------------------------------------------- |
| `firstdraft plan init`                | No      | Create an empty local Foundation Plan and Project identity |
| `firstdraft generate application-key` | No      | Preview deterministic name-to-key derivation               |
| `firstdraft generate uuid`            | No      | Generate one or more Foundation Plan subject identities    |
| `firstdraft plan push`                | Yes     | Conditionally submit the exact whole Plan                  |
| `firstdraft plan status`              | Yes     | Read or wait for the current whole-graph analysis          |
| `firstdraft plan compile`             | Yes     | Push and analyze, then materialize or publish              |
| `firstdraft compilation status`       | Yes     | Inspect a retained Compilation by ID                       |
| `firstdraft compilation download`     | Yes     | Verify and materialize a successful retained Compilation   |

## Authenticate API commands

Create an API token in First Draft and provide it only through the environment when running a network command:

```sh
export FIRSTDRAFT_API_TOKEN="your-token"
firstdraft plan push
```

`plan push`, `plan status`, `plan compile`, and `compilation` subcommands send the token as a Bearer credential on
every API request. The CLI does not save it in `.firstdraft`, print it, or require it for local commands such as
`plan init` and `generate`. Revoke the token in First Draft if it is exposed. A missing token, or First Draft's
validated `401` problem response with the `authentication_required` code, produces that stable CLI error.

## Start a Foundation Plan

From the project that the Plan describes:

```sh
firstdraft plan init --name "Oscar Party"
```

This creates an empty `firstdraft.foundation-plan.sketch/0.20` Plan targeting `rails-sketch/2026-09` and a
client-generated Project ID under `.firstdraft/`. A nested ignore file keeps that local scratch area out of Git
without changing the project's own `.gitignore`. Initialization makes no network request and refuses to replace an
existing `.firstdraft` path.

Provide either `--name`, `--application-key`, or both. Name-only initialization derives a lower-snake key. Key-only
initialization derives a humanized display name. Supplying both preserves both values exactly after validating them
against the Foundation Plan schema.

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

The initial API origin defaults to `https://firstdraft.com`. Set `FIRSTDRAFT_API_URL` to use another HTTPS origin or
a loopback HTTP development server. The first successful push pins the normalized origin in local state, and a later
override must match it.

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

The projection includes the exact Head digest, Analyzer and Compiler releases, selected target, and
`analysis.gap_set` plus `analysis.gap_set_sha256`. A `valid` run always returns the complete parsed canonical
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

To compile into a local application directory, run:

```sh
firstdraft plan compile --output ./application
```

Both `plan compile` modes first push the exact current bytes in
`.firstdraft/foundation-plan.json`, even when those bytes are unchanged, and saves the accepted ETag using the same
contract as `plan push`. It then waits up to two minutes for an analysis whose graph version and
`head_source_sha256` exactly match that accepted push, polling past a terminal result retained for an older Head.
Invalid JSON, schema diagnostics, semantic diagnostics, a failed analysis, a superseded analysis, or a recurring
diagnostic stop the command with structured output; no Compilation or Publication is requested.

Only a `valid` analysis proceeds to the selected completion mode. Immediately before either conditional mutation,
the CLI re-reads the local Plan and requires its exact bytes and saved state to match the accepted Head. It extracts
the accepted source SHA-256 from the saved ETag, hashes the current local bytes, and sends that complete ETag in
`If-Match`.

### Materialize a direct Compilation

With `--output`, the CLI accepts either an explicit absent destination beneath an existing real directory or a path
that resolves to the physical current directory. It validates either destination before pushing the Plan. An absent
destination is checked again after analysis; root adoption instead holds its owned lock and performs the exact
pre-move identity recheck described below. Other existing destinations remain invalid, so
`--output ./application` retains its absent-directory contract.

The nested archive layout below describes the unreleased `0.3.0` candidate.
[Published CLI `0.2.2`](release-history.md#022-publication-and-registry-observation) archives at top-level `design/`;
existing applications are not migrated automatically.

`--output .` is the noninteractive root-adoption mode. `./`, an absolute spelling of the current directory, and
another spelling that resolves to that same physical directory select the same mode. It works at any real current
directory that meets the preconditions below and does not recognize Drawing Board or another repository layout
specially. This first root-adoption contract supports POSIX filesystems; Windows retains absent-directory output
and refuses root adoption as `root_platform_unsupported`. Before starting Compilation, the CLI requires:

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

Without `--output`, the existing GitHub Publication journey remains unchanged:

```sh
firstdraft plan compile
```

Invoking this form authorizes the internal GitHub Publication lifecycle. The command writes stable human-readable
progress to stderr, with every line prefixed by `First Draft:`. It reports analysis, Compilation completion or
terminal failure or cancellation, the current GitHub phase, and an allowlisted reason, retry count, and exact UTC
retry time when a GitHub preflight check is delayed. A retained retry with no next time is reported as paused and
requiring operator recovery. Progress never includes IDs, hashes, repository names or URLs, raw server projections,
local paths, or environment values. Success writes exactly the validated private GitHub repository URL plus a
newline to stdout. If the command fails after progress has begun, its structured JSON error envelope is the final
stderr document after the progress lines.

The closed API `0.4.x` progress-reason allowlist is `github.configuration_missing`, `github.oauth_unavailable`,
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
metadata or operational tooling. The no-output `plan compile` form prints only the final repository URL, while
`plan compile --output` waits for and downloads its own direct Compilation:

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

Artifact validation accepts only Plan format `firstdraft.foundation-plan.sketch/0.20` and target profile
`rails-sketch/2026-09`, in addition to matching the retained Compilation's provenance and verifying file integrity.
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
