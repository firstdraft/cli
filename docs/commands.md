# First Draft CLI command reference

This page owns the detailed public semantics of the current command surface. Run `firstdraft --help` or a command
group's `--help` for concise executable syntax. See [Errors and recovery](errors.md) before retrying a failed mutation.

The current `0.2.x` source line contains the auditable command shell, local Foundation Plan initialization, local
application-key and UUID generation, conditional whole-document push, whole-graph analysis status polling,
compile-and-publish orchestration, and read-only retained-Compilation download. CLI `0.2.x` requires the service's
`0.3.x` API contract. See the [release policy](../RELEASING.md) for versioning and channel semantics and
[release history](release-history.md) for the transition from prereleases.

## Command map

| Command                               | Network | Purpose                                                    |
| ------------------------------------- | ------- | ---------------------------------------------------------- |
| `firstdraft plan init`                | No      | Create an empty local Foundation Plan and Project identity |
| `firstdraft generate application-key` | No      | Preview deterministic name-to-key derivation               |
| `firstdraft generate uuid`            | No      | Generate one or more Foundation Plan subject identities    |
| `firstdraft plan push`                | Yes     | Conditionally submit the exact whole Plan                  |
| `firstdraft plan status`              | Yes     | Read or wait for the current whole-graph analysis          |
| `firstdraft plan compile`             | Yes     | Push, analyze, compile, and publish the current Plan       |
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

This creates an empty `sketch/0.19` Plan and client-generated Project ID under `.firstdraft/`. A nested ignore file
keeps that local scratch area out of Git without changing the project's own `.gitignore`. Initialization makes no
network request and refuses to replace an existing `.firstdraft` path.

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

## Compile and publish the current Plan

When the candidate is ready, run:

```sh
firstdraft plan compile
```

`plan compile` is the single terminal action. It first pushes the exact current bytes in
`.firstdraft/foundation-plan.json`, even when those bytes are unchanged, and saves the accepted ETag using the same
contract as `plan push`. It then waits up to two minutes for an analysis whose graph version and
`head_source_sha256` exactly match that accepted push, polling past a terminal result retained for an older Head.
Invalid JSON, schema diagnostics, semantic diagnostics, a failed analysis, a superseded analysis, or a recurring
diagnostic stop the command with structured output; no Compilation or Publication is requested.

Only a `valid` analysis proceeds to the internal GitHub Publication lifecycle. Invoking `plan compile` is the
authorization to request that lifecycle. Immediately before its conditional mutation, the CLI re-reads the local
Plan and requires its exact bytes to match the accepted Head, so bytes changed after analysis cannot be published.
It extracts the accepted source SHA-256 from the saved ETag, hashes the current local bytes, and sends that complete
ETag in `If-Match`.

The command writes stable human-readable progress to stderr, with every line prefixed by `First Draft:`. It reports
analysis, compilation completion or terminal failure or cancellation, the current GitHub phase, and an allowlisted
reason, retry count, and exact UTC retry time when a GitHub preflight check is delayed. A retained retry with no next
time is reported as paused and requiring operator recovery. Progress never includes IDs, hashes, repository names or
URLs, raw server projections, local paths, or environment values. Success writes exactly the validated private
GitHub repository URL plus a newline to stdout. If the command fails after progress has begun, its structured JSON
error envelope is the final stderr document after the progress lines.

The closed API `0.3.x` progress-reason allowlist is `github.configuration_missing`, `github.oauth_unavailable`,
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
`plan publish` command and no local-start `plan compile --output` mode. It retains lower-level Compilation commands
for operational callers that acquire an ID separately, but they are intentionally not a continuation of the
URL-only `plan compile` journey.

## Inspect a retained Compilation

These lower-level commands are for callers that already hold a retained Compilation ID from authenticated API
metadata or operational tooling; `plan compile` prints only the final repository URL:

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
