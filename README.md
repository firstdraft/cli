# First Draft CLI

`firstdraft` is the command-line client for [First Draft](https://github.com/firstdraft/firstdraft). It is being
built for agents that author and review Foundation Plans with their users.

The current `0.1.x` line contains the auditable command shell, local Foundation Plan initialization, local
application-key and UUID generation, conditional whole-document push, whole-graph analysis status polling,
compile-and-publish orchestration, and read-only retained-Compilation download. Before `1.0.0`, increasing the minor
version starts a breaking compatibility line; increasing the patch version is otherwise backward-compatible within
that line. This policy applies to ordinary versions; historical prereleases are outside those compatibility
guarantees. `0.1.0` intentionally supersedes `0.1.0-alpha.2` and requires the service's `0.2.x` API contract.
Publishing the CLI does not make the wider First Draft service generally available.

## Requirements

- Running the CLI: Node.js 22.0.0 or newer
- Working on this repository: Node.js 24.18.0 (pinned in `.tool-versions`)

## Installation

Install the `latest`-selected stable release from npm's default channel:

```sh
npm install --global @firstdraft.com/cli
firstdraft --version
```

The npm package is `@firstdraft.com/cli`; it installs the `firstdraft` executable. A versionless installation resolves
npm's `latest` dist-tag. Pin an exact compatible version, such as `@firstdraft.com/cli@0.1.0`, when a repeatable
installation matters.

The release workflow first publishes an approved candidate under `next`; that channel has no SemVer meaning and the
workflow does not move `latest`. A stable release is complete only after the exact candidate passes its explicitly
named release-specific qualification, receives separate promotion approval, and becomes `latest`. As observed on
August 12, 2026, both `latest` and `next` identify ordinary version `0.1.0`. The earlier alpha remains immutable
registry history but is no longer selected by either channel. Remote Plan and Compilation commands require a
compatible First Draft service and are currently intended for coordinated trials.

Before creating any future release tag, an operator must inspect npm's exact listed
[GitHub Actions trusted-publisher](https://docs.npmjs.com/trusted-publishers/) relationship for
`@firstdraft.com/cli`, type `github`, the `firstdraft/cli` repository, `publish.yml`, the protected `npm` environment,
and permission `createPackage` (npm's trust-list vocabulary for the allowed publish operation). The release workflow
authenticates only with a short-lived GitHub OIDC credential. A persistent npm token, `NODE_AUTH_TOKEN`, or GitHub
Actions secret is not permitted as a publication fallback. Protected tag `v0.1.0` and package version `0.1.0` are
already consumed and immutable; never move or reuse either identity.

## Authenticate API commands

Create an API token in First Draft and provide it only through the environment when running a network command:

```sh
export FIRSTDRAFT_API_TOKEN="your-token"
firstdraft plan push
```

`plan push`, `plan status`, `plan compile`, and `compilation` subcommands send the token as a Bearer credential on
every API request. The CLI does not save it in `.firstdraft`, print it, or require it for local commands such as
`plan init` and `generate`. Revoke the token in First Draft if it is exposed. A missing token, or First Draft's validated
`401` problem response with the `authentication_required` code, produces that stable CLI error.

## Development

```sh
npm ci
npm run check
npm run pack:check
```

To reproduce the length-delimited SHA-256 used by external evidence to identify the packaged JavaScript runtime
inputs (`package.json`, `bin/firstdraft.js`, and every `.js` file under `src/`), run from the repository root:

```sh
node scripts/runtime-digest.js
```

## Start a Foundation Plan

From the project that the Plan describes:

```sh
firstdraft plan init --name "Oscar Party"
```

This creates an empty `sketch/0.19` Plan and client-generated Project ID under `.firstdraft/`. A nested ignore file
keeps that local scratch area out of Git without changing the project's own `.gitignore`. Initialization makes no
network request and refuses to replace an existing `.firstdraft` path.

Provide either `--name`, `--application-key`, or both. Name-only initialization derives a lower-snake key. Key-only
initialization derives a humanized display name. Supplying both preserves both values exactly after
validating them against the Foundation Plan schema. To inspect the name-to-key derivation without initializing a
project, run:

```sh
firstdraft generate application-key --name "Oscar Party"
```

The generated key is deterministic, starts with a letter, contains only lowercase ASCII letters, digits, and
underscores, and is at most 63 bytes so it can lower to the current iOS application identifier component. Names
without a readable ASCII form receive a stable digest-based key. Longer readable names are shortened to a readable
prefix plus a stable digest suffix. Explicit application keys retain the Foundation Plan's broader
`^[a-z][a-z0-9_]*$` boundary and are left for target analysis rather than silently rewritten.

## Add Foundation Plan subjects

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

The initial API origin defaults to `https://firstdraft.com`. Set `FIRSTDRAFT_API_URL` to use another HTTPS origin
or a loopback HTTP development server. The first successful push pins the normalized origin in local state, and a
later override must match it.

If a failure happens after sending the request, the CLI reports that the outcome may be ambiguous and leaves local
state unchanged. It never constructs an ETag from the Plan digest or trusts an ETag from a response it could not
fully verify. Until First Draft has a Foundation Plan head reconciliation endpoint, an accepted request whose
response cannot be verified may require manual recovery. If a verified response cannot replace local state,
preserve the printed recovery state; an adjacent `.tmp` file may contain the same private recovery copy.

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

Status reads require the API origin pinned by a successful push. They never select an origin from the current
environment, expose the private ETag, follow redirects, or modify local state. Each request has a bounded timeout,
every response is byte-bounded and fully validated, and polling will not silently switch to a replacement analysis.
The wait repeats only validated `processing` responses and stops on its first failed read. A network failure is safe
to retry a bounded number of times because the command sends only `GET` requests. If `status_unavailable` persists,
inspect the API origin pinned in `.firstdraft/state.json`; an invalid server response instead requires reconciling the
CLI and server contract.

## Compile and publish the current Plan

When the candidate is ready, run:

```sh
firstdraft plan compile
```

`plan compile` is the single terminal action. It first pushes the exact current bytes in
`.firstdraft/foundation-plan.json`, even when those bytes are unchanged, and saves the accepted ETag using the same
contract as `plan push`. It then waits up to two minutes for an analysis whose graph version exactly matches that
accepted push, polling past a terminal result retained for an older Head. Invalid JSON, schema diagnostics,
semantic diagnostics, a failed analysis, a superseded analysis, or a recurring diagnostic stop the command with
structured output; no Compilation or Publication is requested.

Only a `valid` analysis proceeds to the internal GitHub Publication lifecycle. Invoking `plan compile` is the
authorization to request that lifecycle. Immediately before its conditional mutation, the CLI re-reads the local
Plan and requires its exact bytes to match the accepted Head, so bytes changed after analysis cannot be published.
It extracts the accepted source SHA-256 from the saved ETag, hashes the current local bytes, and then sends that
complete ETag in `If-Match`.
The command writes stable human-readable progress to stderr, with every line prefixed by `First Draft:`. It reports
analysis, compilation completion or terminal failure or cancellation, the current GitHub phase, and an allowlisted
reason, retry count, and exact UTC retry time when a GitHub preflight check is delayed. A retained retry with no next
time is reported as paused and requiring operator recovery. Progress never includes IDs, hashes, repository names or
URLs, raw server projections, local paths, or environment values. Success writes exactly the validated private
GitHub repository URL plus a newline to stdout. If the command fails after progress has begun, its existing
structured JSON error envelope is the final stderr document after the progress lines.

The closed API `0.2.x` progress-reason allowlist is `github.configuration_missing`, `github.oauth_unavailable`,
`github.api_unavailable`, `github.reauthorization_required`, `github.account_mismatch`,
`github.installation_unavailable`, `github.installation_not_ready`, `github.preflight_unavailable`, the legacy-only
`github.preflight_unclassified`, and these stage-specific fallbacks: `github.preflight_unavailable.configuration`,
`github.preflight_unavailable.authorization`, `github.preflight_unavailable.repository_client`,
`github.preflight_unavailable.artifact_preparation`, `github.preflight_unavailable.installation_token`,
`github.preflight_unavailable.publication_preparation`, and `github.preflight_unavailable.repository_ref_client`.
Other values make the response invalid rather than becoming terminal output.

The internal Publication is a Project singleton in this release. A repeat safely receives the same Publication
instead of creating another. If the first conditional `PUT` has an ambiguous result, the CLI reconciles it with
one read-only singleton `GET` and never automatically repeats the mutation within that invocation. Do not run
concurrent Compile commands. After an invocation exits because the initial outcome or a later status read is
unavailable, wait and rerun `plan compile` with unchanged Plan bytes; its conditional request safely reconciles or
resumes the same retained singleton without creating another Compilation, repository, or push. Publication polling
is sequential, bounded to ten minutes, and pinned to the retained Project Head, Compilation input, Publication
identity, and repository identity.

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

Without `--wait`, the command makes exactly one metadata-only `GET`. With `--wait`, it polls that same
Compilation sequentially for at most ten minutes and rejects changes to its identity, Head provenance, target, or
lifecycle progression. `failed` and `cancelled` are successfully read terminal states with exit 0; branch on
`compilation.status` and inspect its validated `failure`.

## Download a retained Compilation

Materialize an already successful Compilation into an absent path:

```sh
firstdraft compilation download 01900000-0000-7000-8000-000000000001 --output ../movie-catalog
```

The command validates the UUID and output path before network access, makes one status `GET`, requires
`succeeded`, and makes one artifact `GET`. It never starts work or polls. Historical artifact validation uses
the retained `compilation.head_source_sha256`, not the current local Plan or ETag, to pin the artifact's exact
`head_source_sha256`. The artifact's canonical `foundation_plan.sha256` may differ because it identifies the
normalized Compiler input. It is validated as a SHA-256 digest inside the exact artifact bytes authenticated by
the status response's `artifact.sha256`; it is not equated to the submitted Head digest.

Before materialization, the CLI verifies the artifact media type, declared and actual byte sizes, strong digest
ETag, exact-byte SHA-256, canonical UTF-8 JSON envelope, provenance, metadata-only manifest digest, portable paths,
strict Base64 contents, file digests, modes, owners, and source-subject UUIDs. It writes only into a uniquely
created sibling directory, verifies the complete tree, and atomically renames it into the still-absent destination.
On POSIX, directories use mode `0755` and files use artifact-declared `0644` or `0755`; Windows verifies
structure, contents, and digests without claiming POSIX mode bits.

## Handled failures

Every handled subcommand failure ends with exactly one JSON object on standard error. `plan compile` may first write
progress lines; machine consumers can remove only lines beginning with the exact `First Draft: ` prefix and parse
the remaining JSON document. Branch on its stable `error` value rather than the human-readable `detail`; `plan
compile` also supplies `phase: "push" | "publication"` when `request_outcome_unknown` requires phase-specific
recovery:

- `phase: "push"` means the Plan mutation may have been accepted; stop and reconcile local Head state.
- `phase: "publication"` means the singleton Publication mutation was not resolved. Do not run concurrent Compile
  commands. After the prior invocation exits, wait and rerun `plan compile` with unchanged Plan bytes to safely
  reconcile or resume the retained singleton.

| Commands                                     | `error`                                                                                            | Exit | Meaning                                                                                                        |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---: | -------------------------------------------------------------------------------------------------------------- |
| Any leaf command                             | `invalid_arguments`                                                                                |    2 | Syntax was invalid; no request was made.                                                                       |
| `plan init`                                  | `local_initialization_failed`                                                                      |    1 | Initialization failed without overwriting an existing path.                                                    |
| `plan push`, `plan compile`                  | `invalid_configuration`                                                                            |    2 | API origin or saved Head state is incompatible.                                                                |
| Network commands                             | `authentication_required`                                                                          |    1 | The token is missing or First Draft returned a validated authentication problem.                               |
| Plan commands, `compilation *`               | `local_input_unreadable`                                                                           |    1 | Required local Plan or private state could not be read.                                                        |
| Status, Compile, Compilation commands        | `project_not_pushed`                                                                               |    1 | No API origin is pinned for the local Project.                                                                 |
| `plan push`, `plan compile`                  | `request_outcome_unknown`                                                                          |    1 | A mutation or its response could not be verified; `plan compile` identifies its `push` or `publication` phase. |
| `plan push`, `plan compile`                  | `local_state_not_saved`                                                                            |    1 | The Plan was accepted but the private ETag state could not be replaced; includes `recovery_state`.             |
| `plan push`, `plan compile`                  | `server_rejected`                                                                                  |    1 | First Draft returned validated Plan diagnostics or a validated problem.                                        |
| `plan status`                                | `status_unavailable`, `invalid_server_response`                                                    |    1 | The analysis read failed or violated its protocol.                                                             |
| `plan compile`                               | `analysis_status_unavailable`, `invalid_analysis_status`, `analysis_status_rejected`               |    1 | The bounded analysis read failed, was invalid, or was rejected.                                                |
| Analysis waits                               | `analysis_changed`, `wait_timed_out`, `analysis_wait_timed_out`                                    |    1 | The pinned analysis changed or remained processing at the deadline.                                            |
| `plan compile`                               | `plan_not_valid`                                                                                   |    1 | Analysis completed without `valid`; `current` contains diagnostics and status.                                 |
| `plan compile`                               | `local_plan_changed`                                                                               |    1 | Local bytes changed after acceptance or analysis, before Publication mutation.                                 |
| `plan compile`                               | `publication_start_rejected`, `publication_status_unavailable`, `invalid_publication_status`       |    1 | Publication start or status failed its validated transport contract.                                           |
| `plan compile`                               | `publication_changed`, `publication_wait_timed_out`, `publication_failed`, `publication_cancelled` |    1 | The pinned Publication changed, timed out, or reached a non-success terminal state.                            |
| `compilation status`, `compilation download` | `compilation_status_unavailable`, `invalid_compilation_status`                                     |    1 | The retained status could not be read or violated its exact contract.                                          |
| `compilation status --wait`                  | `compilation_changed`, `compilation_wait_timed_out`                                                |    1 | Retained identity/provenance changed or the wait ended.                                                        |
| `compilation download`                       | `compilation_not_succeeded`                                                                        |    1 | Status was not `succeeded`; no artifact request was made.                                                      |
| `compilation download`                       | `artifact_unavailable`, `invalid_artifact`                                                         |    1 | Artifact transport or integrity validation failed before materialization.                                      |
| `compilation download`                       | `invalid_output_path`                                                                              |    2 | The destination was not an absent path beneath an existing real directory.                                     |
| `compilation download`                       | `materialization_failed`                                                                           |    1 | The output raced or the verified tree could not be atomically installed.                                       |

Handled output never includes command arguments, local Plan bytes, raw artifact bytes, raw filesystem or network
errors, or unvalidated response bodies. `local_state_not_saved` is the sole exception to private-state redaction:
its `recovery_state` is required to repair the accepted ETag locally. Root-level and command-group usage failures
remain human-readable text on standard error with exit 2. Unexpected programming defects remain loud.

## Trust model

- The published CLI will run the reviewed JavaScript source directly, without generated or bundled code.
- The CLI has no runtime dependencies, install scripts, telemetry, update checks, or network activity except an
  explicitly invoked API command.
- Package contents are allowlisted and checked before release.
- CI exercises the exact minimum Node.js version separately from current development tooling.
- Public packages carry npm provenance linking their registry bytes to the reviewed GitHub workflow and commit.

Security issues should follow the
[private reporting instructions](https://github.com/firstdraft/cli/security/advisories/new).
