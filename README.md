# First Draft CLI

`firstdraft` is the command-line client for [First Draft](https://github.com/firstdraft/firstdraft). It is being
built for agents that author and review Foundation Plans with their users.

Public alpha releases use npm's `next` tag. This release line contains the auditable command shell, local Foundation
Plan initialization, subject identity generation, conditional whole-document push, whole-graph analysis status
polling, explicit compilation, and verified local artifact materialization. Interfaces may change between
prereleases, and publishing the CLI does not make the wider First Draft service generally available.

## Requirements

- Running the CLI: Node.js 22.0.0 or newer
- Working on this repository: Node.js 24.18.0 (pinned in `.tool-versions`)

## Installation

Once npm reports a public alpha, install the current prerelease explicitly:

```sh
npm install --global firstdraft@next
firstdraft --version
```

There is intentionally no stable `latest` release yet. Pin an exact prerelease version instead of `next` when a
repeatable installation matters. Remote Plan push, status, and compilation commands require a compatible First
Draft service and are currently intended for coordinated trials.

## Development

```sh
npm ci
npm run check
npm run pack:check
```

## Start a Foundation Plan

From the project that the Plan describes:

```sh
firstdraft plan init --application-key oscar_party --name "Oscar Party"
```

This creates an empty `sketch/0.19` Plan and client-generated Project ID under `.firstdraft/`. A nested ignore file
keeps that local scratch area out of Git without changing the project's own `.gitignore`. Initialization makes no
network request and refuses to replace an existing `.firstdraft` path.

## Add Foundation Plan subjects

Generate an identity before adding each new independently mutable authored subject:

```sh
firstdraft plan subject-id
```

The command prints one UUIDv7 for the subject's `subject_uuid`. It does not read or modify the Plan, reserve the
value, or make a network request. Preserve that UUID when renaming the subject or moving it to a different semantic
owner without changing its kind. Use a new UUID for a replacement concept. Readable keys and paths may change and
remain the document's links; the UUID preserves continuity between complete-document pushes.

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

Every handled failure from `plan init`, `plan subject-id`, `plan push`, `plan status`, or `plan compile` writes
exactly one JSON object to standard error. Agents should branch on its stable `error` value, not on the human-readable
`detail`:

| Commands                                                                   | `error`                          | Exit | Meaning                                                                                                                                                    |
| -------------------------------------------------------------------------- | -------------------------------- | ---: | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plan init`, `plan subject-id`, `plan push`, `plan status`, `plan compile` | `invalid_arguments`              |    2 | The command syntax is invalid; nothing was written and no request was made.                                                                                |
| `plan init`                                                                | `local_initialization_failed`    |    1 | Local initialization failed. The directory may be incomplete; existing files were not overwritten.                                                         |
| `plan push`, `plan compile`                                                | `invalid_configuration`          |    2 | API configuration or the saved ETag is incompatible with the requested command; no request was made.                                                       |
| `plan push`, `plan status`, `plan compile`                                 | `local_input_unreadable`         |    1 | The required local Plan or private state could not be read; no request was made.                                                                           |
| `plan status`, `plan compile`                                              | `project_not_pushed`             |    1 | Local state is valid but has no pinned remote Project yet; run `plan push` first.                                                                          |
| `plan push`, `plan compile`                                                | `request_outcome_unknown`        |    1 | A sent mutation or its response could not be verified. Stop and reconcile instead of retrying it automatically.                                            |
| `plan status`                                                              | `status_unavailable`             |    1 | The network request or response stream failed. The object includes `status` when headers were received; retry the GET a bounded number of times.           |
| `plan status`                                                              | `invalid_server_response`        |    1 | First Draft returned a response that does not satisfy the status contract. The object includes `status`; retrying unchanged will not repair the mismatch.  |
| `plan push`, `plan status`                                                 | `server_rejected`                |    1 | First Draft returned a validated rejection. The object includes `status` and a whitelisted `response` containing validated problem details or diagnostics. |
| `plan status --wait`                                                       | `analysis_changed`               |    1 | A different current analysis appeared while polling. `current` contains its validated state; start a fresh wait to follow it explicitly.                   |
| `plan status --wait`                                                       | `wait_timed_out`                 |    1 | The two-minute wait ended while processing continued. `current` contains the last validated state; another wait is safe.                                   |
| `plan push`                                                                | `local_state_not_saved`          |    1 | The server accepted the Plan, but local state replacement failed. This is the only error that includes private `recovery_state`.                           |
| `plan compile`                                                             | `compilation_start_rejected`     |    1 | First Draft rejected the conditional start; a validated problem may be included as `response`.                                                             |
| `plan compile`                                                             | `compilation_status_unavailable` |    1 | The first failed read stopped polling the pinned Compilation; a validated problem may be included.                                                         |
| `plan compile`                                                             | `invalid_compilation_status`     |    1 | A status response violated the exact Compilation contract.                                                                                                 |
| `plan compile`                                                             | `compilation_changed`            |    1 | Compilation identity, immutable metadata, or lifecycle progression changed while polling.                                                                  |
| `plan compile`                                                             | `compilation_wait_timed_out`     |    1 | The ten-minute deadline ended; `current` contains the last validated status.                                                                               |
| `plan compile`                                                             | `compilation_failed`             |    1 | The pinned Compilation failed; `current` contains its validated failure.                                                                                   |
| `plan compile`                                                             | `compilation_cancelled`          |    1 | The pinned Compilation was cancelled.                                                                                                                      |
| `plan compile`                                                             | `artifact_unavailable`           |    1 | The artifact GET failed or was rejected before materialization.                                                                                            |
| `plan compile`                                                             | `invalid_artifact`               |    1 | Artifact transport metadata, bytes, provenance, manifest, or files failed validation.                                                                      |
| `plan compile`                                                             | `invalid_output_path`            |    2 | The output is not absent beneath an existing real directory; no request was made.                                                                          |
| `plan compile`                                                             | `materialization_failed`         |    1 | After artifact validation, filesystem state changed or the verified tree could not be written and atomically published.                                    |

Handled failure output never includes command arguments, local Plan bytes, runtime paths, raw filesystem or network
errors, or unvalidated response bodies. Optional fields inside a validated rejection diagnostic are omitted when
absent or when the CLI cannot validate their complete shape. Exit status remains a broad shell-level class; the
`error` value is the machine-readable recovery contract.

Root-level and `plan` command-group usage failures remain human-readable text on standard error with exit 2. A
failure before a subcommand can begin, such as an unavailable working directory, also remains uncaught, as do
unexpected programming defects.

## Trust model

- The published CLI will run the reviewed JavaScript source directly, without generated or bundled code.
- The CLI has no runtime dependencies, install scripts, telemetry, update checks, or network activity except an
  explicitly invoked API command.
- Package contents are allowlisted and checked before release.
- CI exercises the exact minimum Node.js version separately from current development tooling.
- Public packages carry npm provenance linking their registry bytes to the reviewed GitHub workflow and commit.

Security issues should follow the
[private reporting instructions](https://github.com/firstdraft/cli/security/advisories/new).
