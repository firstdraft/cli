# First Draft CLI errors and recovery

This page owns handled-error interpretation, retry safety, and recovery guidance. Read the
[command reference](commands.md) for successful command behavior.

## Handled output contract

Every handled subcommand failure ends with exactly one JSON object on standard error. `plan compile` may first write
progress lines; machine consumers can remove only lines beginning with the exact `First Draft: ` prefix and parse the
remaining JSON document. Branch on the stable `error` value rather than the human-readable `detail`.

Handled output never includes command arguments, local Plan bytes, raw artifact bytes, raw filesystem or network
errors, or unvalidated response bodies. `local_state_not_saved` is the sole exception to private-state redaction:
its `recovery_state` is required to repair the accepted ETag locally. Root-level and command-group usage failures
remain human-readable text on standard error with exit 2. Unexpected programming defects remain loud.

## Ambiguous mutations

`plan compile` supplies `phase: "push" | "publication"` when `request_outcome_unknown` requires phase-specific
recovery:

- `phase: "push"` means the Plan mutation may have been accepted. Stop and reconcile local Head state. Until First
  Draft has a Foundation Plan Head reconciliation endpoint, an accepted request whose response cannot be verified
  may require manual recovery. Do not construct an ETag from the Plan digest or trust an unverified response.
- `phase: "publication"` means the singleton Publication mutation was not resolved. Do not run concurrent Compile
  commands. After the prior invocation exits, wait and rerun `plan compile` with unchanged Plan bytes to safely
  reconcile or resume the retained singleton.

`plan push` also reports `request_outcome_unknown` if a failure happens after sending its request. Local state remains
unchanged. Stop and reconcile rather than assuming the request failed and repeating the mutation.

If a verified Plan response cannot replace local state, preserve the printed `recovery_state`; an adjacent `.tmp`
file may contain the same private recovery copy. Do not push again until the accepted ETag state is repaired.

## Read-only status failures

A network failure from `plan status` is safe to retry a bounded number of times because the command sends only
`GET` requests. If `status_unavailable` persists, inspect the API origin pinned in `.firstdraft/state.json`.
`invalid_server_response` instead means the response violated the CLI/server contract; retrying the unchanged read
will not repair it.

The lower-level `compilation status` command is also read-only. `compilation_status_unavailable` is safe to retry;
`invalid_compilation_status` requires contract reconciliation. A wait stops rather than following a changed
analysis or Compilation identity.

## Publication recovery

The Publication is a Project singleton. If its initial conditional `PUT` is ambiguous, the CLI attempts one
read-only singleton `GET` and never automatically repeats the mutation in that invocation.

After `publication_status_unavailable` or `publication_wait_timed_out`, retained work may still continue. Do not run
concurrent Compile commands. Wait, then rerun `plan compile` with unchanged Plan bytes; the conditional request
safely reconciles or resumes the same retained singleton without creating another Compilation, repository, or push.
The same recovery applies when an invocation exits after an unresolved Publication start.

A GitHub preflight retry with no `retry_at` is paused and requires operator recovery. `publication_failed` and
`publication_cancelled` are terminal; inspect the validated phase and failure information rather than blindly
retrying. `publication_changed` means the pinned Publication identity or provenance changed, so the CLI deliberately
stopped without following the replacement.

## Error index

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
| `plan push`, `plan compile`                  | `server_rejected`                                                                                  |    1 | First Draft returned validated Plan diagnostics or rejected the request with a validated problem.              |
| `plan status`                                | `server_rejected`                                                                                  |    1 | First Draft rejected the analysis status request with a validated non-authentication problem.                  |
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
