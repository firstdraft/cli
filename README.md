# First Draft CLI

`firstdraft` is the command-line client for [First Draft](https://github.com/firstdraft/firstdraft). It is being
built for agents that author and review Foundation Plans with their users.

The package is not released yet. This repository contains the auditable command shell, local Foundation Plan
initialization, subject identity generation, and conditional whole-document push; release behavior will arrive in
reviewed increments.

## Requirements

- Running the CLI: Node.js 22.0.0 or newer
- Working on this repository: Node.js 24.18.0 (pinned in `.tool-versions`)

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
fully verify. Until First Draft has a read or reconciliation endpoint, an accepted request whose response cannot be
verified may require manual recovery. If a verified response cannot replace local state, preserve the printed
recovery state; an adjacent `.tmp` file may contain the same private recovery copy.

Every handled failure from `plan init`, `plan subject-id`, or `plan push` writes exactly one JSON object to standard
error. Agents should branch on its stable `error` value, not on the human-readable `detail`:

| Commands                                    | `error`                       | Exit | Meaning                                                                                                                                                    |
| ------------------------------------------- | ----------------------------- | ---: | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plan init`, `plan subject-id`, `plan push` | `invalid_arguments`           |    2 | The command syntax is invalid; nothing was written and no request was made.                                                                                |
| `plan init`                                 | `local_initialization_failed` |    1 | Local initialization failed. The directory may be incomplete; existing files were not overwritten.                                                         |
| `plan push`                                 | `invalid_configuration`       |    2 | The configured API origin is invalid or conflicts with pinned local state; no request was made.                                                            |
| `plan push`                                 | `local_input_unreadable`      |    1 | The local Plan or state could not be read; no request was made.                                                                                            |
| `plan push`                                 | `request_outcome_unknown`     |    1 | A sent request or its response could not be verified. Stop and reconcile before pushing again. The object includes `status` when one was received.         |
| `plan push`                                 | `server_rejected`             |    1 | First Draft returned a validated rejection. The object includes `status` and a whitelisted `response` containing validated problem details or diagnostics. |
| `plan push`                                 | `local_state_not_saved`       |    1 | The server accepted the Plan, but local state replacement failed. This is the only error that includes private `recovery_state`.                           |

Handled failure output never includes command arguments, local Plan bytes, runtime paths, raw filesystem or network
errors, or unvalidated response bodies. Optional fields inside a validated diagnostic are omitted when absent or
when the CLI cannot validate their complete shape. Exit status remains a broad shell-level class; the `error` value
is the machine-readable recovery contract.

Root-level and `plan` command-group usage failures remain human-readable text on standard error with exit 2. A
failure before a subcommand can begin, such as an unavailable working directory, also remains uncaught, as do
unexpected programming defects.

## Trust model

- The published CLI will run the reviewed JavaScript source directly, without generated or bundled code.
- The CLI has no runtime dependencies, install scripts, telemetry, update checks, or network activity except an
  explicitly invoked API command.
- Package contents are allowlisted and checked before release.
- CI exercises the exact minimum Node.js version separately from current development tooling.
- Public releases will use npm provenance after the first useful version bootstraps trusted publishing.

Security issues should follow the
[private reporting instructions](https://github.com/firstdraft/cli/security/advisories/new).
