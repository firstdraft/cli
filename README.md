# First Draft CLI

`firstdraft` is the command-line client for [First Draft](https://github.com/firstdraft/firstdraft). It is being
built for agents that author and review Foundation Plans with their users.

Public alpha releases use npm's `next` tag. This release line contains the auditable command shell, local Foundation
Plan initialization, local application-key and UUID generation, conditional whole-document push, whole-graph
analysis status polling, explicit compilation, verified local artifact materialization, and conditional GitHub publication.
Interfaces may change between prereleases, and publishing the CLI does not make the wider First Draft service
generally available.

## Requirements

- Running the CLI: Node.js 22.0.0 or newer
- Working on this repository: Node.js 24.18.0 (pinned in `.tool-versions`)

## Installation

Once npm reports a public alpha, install the current prerelease explicitly:

```sh
npm install --global @firstdraft.com/cli@next
firstdraft --version
```

The npm package is `@firstdraft.com/cli`; it installs the `firstdraft` executable.

There is intentionally no stable `latest` release yet. Pin an exact prerelease version instead of `next` when a
repeatable installation matters. Remote Plan push, status, compilation, and publication commands require a
compatible First Draft service and are currently intended for coordinated trials.

## Authenticate API commands

Create an API token in First Draft and provide it only through the environment when running a network command:

```sh
export FIRSTDRAFT_API_TOKEN="your-token"
firstdraft plan push
```

`plan push`, `plan status`, `plan compile`, and `plan publish` send the token as a Bearer credential on every API
request. The CLI does not save it in `.firstdraft`, print it, or require it for local commands such as `plan init`
and `generate`. Revoke the token in First Draft if it is exposed. A missing token, or First Draft's validated
`401` problem response with the `authentication_required` code, produces that stable CLI error.

## Development

```sh
npm ci
npm run check
npm run pack:check
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

## Compile a valid Plan

After the current analysis is `valid`, choose an absent destination:

```sh
firstdraft plan compile --output ../oscar-party
```

The command conditionally starts one Compilation using the complete Foundation Plan ETag saved by the last
successful push. It never reads an API origin from the current environment, retries an ambiguous `POST`, follows a
replacement Compilation, or overwrites an output path. It polls the accepted Compilation sequentially once per
second for at most ten minutes. A failed or cancelled Compilation is returned as a handled domain failure.

On success, the CLI downloads the Compilation's deterministic artifact, verifies its media type, declared and actual
byte sizes, strong digest ETag, exact-byte SHA-256, canonical UTF-8 JSON envelope, provenance, metadata-only manifest
digest, portable paths, strict Base64 contents, file digests, modes, owners, and source-subject UUIDs. It writes
exclusively into a uniquely created sibling directory, verifies the complete tree, and atomically renames that
directory into the still-absent destination. On POSIX, generated directories, including the output root, are created
and verified at mode `0755` independent of the caller's umask; files use their artifact-declared `0644` or `0755`
mode. Windows cannot represent those POSIX permission distinctions, so the CLI still verifies the complete structure,
contents, and digests there without claiming exact mode bits. The success JSON names the pinned Project and
Compilation and reports the local output path, file count, and manifest digest; it never prints generated file
contents or private local state.

## Publish a valid Plan to GitHub

To compile the accepted Plan and publish it as a new private repository in your connected personal GitHub account:

```sh
firstdraft plan publish
```

The command first verifies that the exact local Plan bytes still match the strong ETag saved by the last successful
push. It then conditionally creates or reuses the Project's singleton GitHub Publication with one `PUT` and the full
saved ETag in `If-Match`. It sends no request when the Plan changed locally; run `plan push` to validate and accept
those bytes first.

For this application route, `If-Match` is a domain precondition, not a cache validator for the possibly absent
Publication representation. A first creation compares it with the Project's current Foundation Plan Head. A
singleton replay compares it with the Publication's retained Head provenance, even if the live Project has since
changed. The server route must apply those semantics directly instead of delegating to generic conditional-response
middleware.

A repeated command safely receives the same Publication instead of creating another. If the first mutation's
response is lost or invalid, the CLI makes one read-only singleton `GET` to reconcile it and never automatically
repeats the mutation. An unresolved request reports `request_outcome_unknown`; running the same command again safely
replays the singleton request. A `408` or `5xx` start response is ambiguous even with a valid problem, so the CLI
uses the same read-only reconciliation; every other validated rejection is definitive and must not have created or
changed a Publication.

When `request_outcome_unknown` includes `status` and `response`, a validated problem from the reconciliation `GET`
takes precedence; otherwise they describe the `PUT`. A `status` without `response` may be a success code when the
read returned a structurally invalid or foreign projection. Never infer from this error alone that no mutation
occurred.

The response's `project` object is immutable Publication provenance, not a projection of the live mutable Project.
Every `201`, `200`, and read-only `GET` response must retain the graph version and Head digest selected when the
Publication was created. The CLI requires that retained Head digest to equal the local Plan bytes and saved ETag,
requires the associated Compilation to agree with the retained Project snapshot, and pins the snapshot for the
rest of polling. This lets a command whose local state still names the original Head safely replay after the live
Project changes elsewhere. A local file/state pair advanced to a newer Head cannot adopt the older Publication.
This release supports one Publication bound to one retained Head for the lifetime of each Project. It cannot
re-point that Publication or publish a later accepted Head, and no same-Project republish path exists yet.

The CLI polls a validated Publication sequentially once per second for at most ten minutes and rejects changes to
its retained Project provenance, Compilation input, Publication identity, or allocated repository identity.
`repository_unknown` and `publication_unknown` are one-way server-side uncertainty states: polling remains
read-only, and the CLI rejects a regression from either state to the corresponding mutating phase. Either state may
still advance to a later phase or a terminal state when the server has enough evidence. The CLI does not offer a
publication-cancel mutation; it only reports a server-authoritative `cancelled` terminal state and does not infer
that cancellation reversed any remote side effect.

Any non-success outcome after publication processing began may leave a private GitHub repository. A `current`
projection identifies the last accepted repository when present; `publication_changed` also includes the rejected
next projection. A null or missing repository does not prove that none was created, especially after
`repository_unknown`. Use a safe command replay or direct GitHub inspection to find every repository. The CLI never
deletes one; inspect it before separately deciding whether destructive GitHub deletion is appropriate.

On success, stdout contains only the validated `https://github.com/OWNER/REPOSITORY` URL. Repository conflicts and
other failed publication phases include the validated terminal state in a handled `publication_failed` error. This
client currently assumes the provisional `{ project, compilation, publication }` response described by its tests;
the server route is not yet implemented, and no live GitHub publication smoke has been completed.

Every handled failure from `generate uuid`, `generate application-key`, `plan init`, `plan push`, `plan status`,
`plan compile`, or `plan publish` writes
exactly one JSON object to standard error. Agents should branch on its stable `error` value, not on the human-readable
`detail`:

| Commands                                                                                                             | `error`                          | Exit | Meaning                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ---: | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generate uuid`, `generate application-key`, `plan init`, `plan push`, `plan status`, `plan compile`, `plan publish` | `invalid_arguments`              |    2 | The command syntax is invalid; nothing was written and no request was made.                                                                                |
| `plan init`                                                                                                          | `local_initialization_failed`    |    1 | Local initialization failed. The directory may be incomplete; existing files were not overwritten.                                                         |
| `plan push`, `plan compile`, `plan publish`                                                                          | `invalid_configuration`          |    2 | API configuration or the saved ETag is incompatible with the requested command; no request was made.                                                       |
| `plan push`, `plan status`, `plan compile`, `plan publish`                                                           | `authentication_required`        |    1 | `FIRSTDRAFT_API_TOKEN` is missing, or First Draft returned a validated `401` problem with the `authentication_required` code; create or replace the token. |
| `plan push`, `plan status`, `plan compile`, `plan publish`                                                           | `local_input_unreadable`         |    1 | The required local Plan or private state could not be read; no request was made.                                                                           |
| `plan status`, `plan compile`, `plan publish`                                                                        | `project_not_pushed`             |    1 | Local state is valid but has no pinned remote Project yet; run `plan push` first.                                                                          |
| `plan push`, `plan compile`                                                                                          | `request_outcome_unknown`        |    1 | A sent mutation or its response could not be verified. Stop and reconcile instead of retrying it automatically.                                            |
| `plan publish`                                                                                                       | `request_outcome_unknown`        |    1 | The ambiguous PUT could not be reconciled. No mutation was retried; retry is safe, and a validated problem may be included.                                |
| `plan status`                                                                                                        | `status_unavailable`             |    1 | The network request or response stream failed. The object includes `status` when headers were received; retry the GET a bounded number of times.           |
| `plan status`                                                                                                        | `invalid_server_response`        |    1 | First Draft returned a response that does not satisfy the status contract. The object includes `status`; retrying unchanged will not repair the mismatch.  |
| `plan push`, `plan status`                                                                                           | `server_rejected`                |    1 | First Draft returned a validated rejection. The object includes `status` and a whitelisted `response` containing validated problem details or diagnostics. |
| `plan status --wait`                                                                                                 | `analysis_changed`               |    1 | A different current analysis appeared while polling. `current` contains its validated state; start a fresh wait to follow it explicitly.                   |
| `plan status --wait`                                                                                                 | `wait_timed_out`                 |    1 | The two-minute wait ended while processing continued. `current` contains the last validated state; another wait is safe.                                   |
| `plan push`                                                                                                          | `local_state_not_saved`          |    1 | The server accepted the Plan, but local state replacement failed. This is the only error that includes private `recovery_state`.                           |
| `plan compile`                                                                                                       | `compilation_start_rejected`     |    1 | First Draft rejected the conditional start; a validated problem may be included as `response`.                                                             |
| `plan compile`                                                                                                       | `compilation_status_unavailable` |    1 | The first failed read stopped polling the pinned Compilation; a validated problem may be included.                                                         |
| `plan compile`                                                                                                       | `invalid_compilation_status`     |    1 | A status response violated the exact Compilation contract.                                                                                                 |
| `plan compile`                                                                                                       | `compilation_changed`            |    1 | Compilation identity, immutable metadata, or lifecycle progression changed while polling.                                                                  |
| `plan compile`                                                                                                       | `compilation_wait_timed_out`     |    1 | The ten-minute deadline ended; `current` contains the last validated status.                                                                               |
| `plan compile`                                                                                                       | `compilation_failed`             |    1 | The pinned Compilation failed; `current` contains its validated failure.                                                                                   |
| `plan compile`                                                                                                       | `compilation_cancelled`          |    1 | The pinned Compilation was cancelled.                                                                                                                      |
| `plan compile`                                                                                                       | `artifact_unavailable`           |    1 | The artifact GET failed or was rejected before materialization.                                                                                            |
| `plan compile`                                                                                                       | `invalid_artifact`               |    1 | Artifact transport metadata, bytes, provenance, manifest, or files failed validation.                                                                      |
| `plan compile`                                                                                                       | `invalid_output_path`            |    2 | The output is not absent beneath an existing real directory; no request was made.                                                                          |
| `plan compile`                                                                                                       | `materialization_failed`         |    1 | After artifact validation, filesystem state changed or the verified tree could not be written and atomically published.                                    |
| `plan publish`                                                                                                       | `local_plan_changed`             |    1 | Local Plan bytes no longer match the last successful push; push the complete Plan before publishing.                                                       |
| `plan publish`                                                                                                       | `publication_start_rejected`     |    1 | First Draft definitively rejected the conditional singleton request; no Publication was created or changed, and a validated problem is included.           |
| `plan publish`                                                                                                       | `publication_status_unavailable` |    1 | The first failed singleton read stopped polling; rerun `plan publish` to replay the singleton and resume. A validated problem may be included.             |
| `plan publish`                                                                                                       | `invalid_publication_status`     |    1 | A status response violated the complete Project, Compilation, Publication, or repository projection contract.                                              |
| `plan publish`                                                                                                       | `publication_changed`            |    1 | Publication identity, metadata, repository, or lifecycle changed. `current` is the pinned projection and `rejected` is the next response; rerun to resume. |
| `plan publish`                                                                                                       | `publication_wait_timed_out`     |    1 | The ten-minute deadline ended; `current` contains the last validated status. Rerun `plan publish` to resume.                                               |
| `plan publish`                                                                                                       | `publication_failed`             |    1 | The pinned Publication failed or reached `repository_conflict`; `current` contains its validated failure.                                                  |
| `plan publish`                                                                                                       | `publication_cancelled`          |    1 | The pinned Publication was cancelled; `current` contains its validated terminal state.                                                                     |

Handled failure output never includes command arguments, local Plan bytes, runtime paths, raw filesystem or network
errors, or unvalidated response bodies. Optional fields inside a validated rejection diagnostic are omitted when
absent or when the CLI cannot validate their complete shape. Exit status remains a broad shell-level class; the
`error` value is the machine-readable recovery contract.

Root-level, `generate`, and `plan` command-group usage failures remain human-readable text on standard error with
exit 2. A failure before a subcommand can begin, such as an unavailable working directory, also remains uncaught,
as do unexpected programming defects.

## Trust model

- The published CLI will run the reviewed JavaScript source directly, without generated or bundled code.
- The CLI has no runtime dependencies, install scripts, telemetry, update checks, or network activity except an
  explicitly invoked API command.
- Package contents are allowlisted and checked before release.
- CI exercises the exact minimum Node.js version separately from current development tooling.
- Public packages carry npm provenance linking their registry bytes to the reviewed GitHub workflow and commit.

Security issues should follow the
[private reporting instructions](https://github.com/firstdraft/cli/security/advisories/new).
