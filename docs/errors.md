# First Draft CLI errors and recovery

This page owns handled-error interpretation, retry safety, and recovery guidance. Read the
[command reference](commands.md) for successful command behavior.

## Handled output contract

Every handled subcommand failure ends with exactly one JSON object on standard error. `plan compile` may first write
progress lines; machine consumers can remove only lines beginning with the exact `First Draft: ` prefix and parse the
remaining JSON document. `login` may first write its human-readable authorization instructions; its JSON object
starts on the line after them. Branch on the stable `error` value rather than the human-readable `detail`.

Handled output never includes command arguments, local Plan bytes, raw artifact bytes, raw filesystem or network
errors, or unvalidated response bodies. `local_state_not_saved` is the sole exception to private-state redaction:
its `recovery_state` is required to repair the accepted ETag locally. Root-level and command-group usage failures
remain human-readable text on standard error with exit 2. Unexpected programming defects remain loud.

## Environment and credential errors

`invalid_configuration` stops before a request when `--staging` conflicts with `FIRSTDRAFT_API_URL` or a Project's
saved origin. Push and Compile also reject any URL override that differs from that pin. Unset the conflicting
override or use a separate initialized project directory for the other environment; do not redirect existing
private Project state. Status and retained download commands continue using their pin.

`authentication_required` means the selected environment's token is missing or rejected. Staging uses
`FIRSTDRAFT_STAGING_API_TOKEN`, including old staging Projects with no flag. Production and custom origins use
`FIRSTDRAFT_API_TOKEN`. When that variable is unset, the token saved by `firstdraft login` for the exact origin is
used. The CLI never substitutes one environment's credential for another's. Run `firstdraft login` for the same
environment (with `--staging` or the same `FIRSTDRAFT_API_URL`), or refresh the environment token, then follow the
command's recovery instructions below. If a saved login is rejected, run `firstdraft login` again.

## Login and logout errors

`login` and `logout` never print a token. A local credential failure can occur after the server has issued or revoked a token.

- `authorization_denied`: the approval was denied in the browser. Run `firstdraft login` again to retry.
- `authorization_expired`: no loopback callback arrived within five minutes, or the device code expired before
  approval. Run `firstdraft login` again. Use `--interactive` if no browser on this machine can reach the printed URL.
- `login_failed`: the login could not be completed. `reason`, when present, is the server's OAuth error code (for
  example `invalid_grant` for a used, expired, or mismatched code), `loopback_unavailable` when the local listener
  could not start, `credentials_invalid` / `credentials_unavailable` when the credentials file could not be read or
  written, or `credentials_locked` when another command held its lock for 10 seconds. `status` is the HTTP status
  when one was received. Credentials failures include `credentials_path` and `phase`. With `phase: "read"`, no
  request was made; repair or remove the file and retry. With `phase: "write"`, First Draft issued a token but the
  CLI could not save it. Revoke that new token on the selected origin's `/api-tokens` page, then repair the
  credentials file and retry login. Any previously saved token remains unchanged when the replacement fails.
- `logout_failed`: the credentials file could not be read or updated. It carries `reason`, `credentials_path`,
  and `phase`. With `phase: "read"`, no token was revoked or removed; repair or remove the file and retry. With
  `phase: "write"`, local removal failed after the revocation attempt. `revoked: true` means First Draft confirmed
  revocation; repair the file and retry logout to remove the stale entry. `revoked: false` means revocation was not
  confirmed, so the token may still be active; revoke it on the selected origin's `/api-tokens` page, then repair
  the file and retry logout. Preserve entries for other origins when repairing the file.
- With reason `credentials_locked`, from either command: wait for any other `firstdraft` command to finish and
  retry. If none is running, the lock was left by a command that exited mid-update; delete `credentials.json.lock`
  next to `credentials_path` instead of repairing the file, and retry. The CLI never removes the lock itself,
  because it cannot tell an abandoned lock from one another command has just taken.

`invalid_configuration` from `login` or `logout` means `--staging` conflicts with `FIRSTDRAFT_API_URL`, or the URL is
invalid. A logout whose server revocation is not confirmed still succeeds after removing the local entry. It
writes a note on standard error; revoke the token on `/api-tokens` if it may still be active.

## Ambiguous mutations

`plan compile` supplies `phase: "push" | "compilation" | "publication"` when `request_outcome_unknown` requires
phase-specific recovery:

- `phase: "push"` means the Plan mutation may have been accepted. Stop and reconcile local Head state. Until First
  Draft has a Foundation Plan Head reconciliation endpoint, an accepted request whose response cannot be verified
  may require manual recovery. Do not construct an ETag from the Plan digest or trust an unverified response.
- `phase: "compilation"` means a local Compilation (the default mode, with optional `--output`) may have started, but its retained identity is unknown.
  The CLI never repeats that `POST`. Do not start another Compilation until the Project is reconciled through First
  Draft or an operator can identify the retained work.
- `phase: "publication"` means the singleton Publication mutation was not resolved. Do not run concurrent Compile
  commands. After the prior invocation exits, wait and rerun `plan compile --github` with unchanged Plan bytes to safely
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

Only the lower-level `compilation status <compilation-id>` command is read-only. Its
`compilation_status_unavailable` result is safe to retry a bounded number of times;
`invalid_compilation_status` requires contract reconciliation. A wait stops rather than following a changed
analysis or Compilation identity. This read-only retry guidance does not apply to `plan compile`, which
starts a new Compilation after analysis.

## Direct Compilation recovery

Do not blindly rerun `plan compile` after its Compilation start was accepted or may have been accepted.
That command creates new work; it is not a retained-Compilation reconciliation command.

If `request_outcome_unknown` reports `phase: "compilation"`, the start request did not yield a validated retained
ID. The CLI sent exactly one `POST` and did not retry it. Stop until First Draft or an operator can reconcile the
Project and identify whether work was retained.

Once the start response has yielded a validated retained Compilation, later status, artifact, authentication, and
materialization failure envelopes include that last validated projection as `current`. Preserve
`current.compilation.id` and recover without creating duplicate work:

- after `compilation_status_unavailable`, use
  `firstdraft compilation status <current.compilation.id>`; this lower-level read is safe to retry boundedly;
- after `invalid_compilation_status` or `invalid_artifact`, preserve the retained ID and reconcile the CLI/Service
  contract instead of retrying the unchanged invalid read;
- after `artifact_unavailable`, wait if appropriate and use
  `firstdraft compilation download <current.compilation.id> --output <new-absent-path>`; and
- after `materialization_failed`, repair the destination condition, then use the same lower-level download command
  with a new absent path. A root-output attempt whose transaction fully rolled back may instead retry that retained
  download with `--output .`; `reason: "root_rollback_incomplete"` requires reconciliation of the retained
  `.firstdraft-root-output` journal before another root attempt. Only that reason requires manual reconciliation.

For an incomplete root rollback, preserve the journal and avoid Git restoration commands. Reconcile its recorded
identities with the current tree: some moves may already have been reversed. Restore the exact original index
through Git's index lock when applicable. Reverse the remaining `artifact_moves` in reverse recorded order, moving
each destination back to its source; only then reverse the remaining `design_moves` in reverse recorded order.
The recorded design destinations are inside transaction staging. While the generated `.firstdraft` remains at the
root, its archive is at `.firstdraft/design`; reversing that artifact move returns the archive to staging before the
original planning `.firstdraft` can return to the root. Do not merge or overwrite either directory. Verify the
original snapshot before removing the transaction directory. A journal whose phase records no irreversible
operation is safe to remove. After successful adoption, run retained status and later Plan commands from
`.firstdraft/design`, and ordinary Rails commands from the generated application root.

After `compilation_wait_timed_out`, retained work may still continue. Use
`firstdraft compilation status <current.compilation.id>` for one read-only status check; do not rerun
`plan compile`. `compilation_failed`, `compilation_cancelled`, and `compilation_changed` already carry the
validated `current` projection appropriate to their stopping boundary. Authentication recovery may refresh the
credential, but it must continue from the retained ID rather than starting another Compilation.

## Publication recovery

The Publication is a Project singleton. If its initial conditional `PUT` is ambiguous, the CLI attempts one
read-only singleton `GET` and never automatically repeats the mutation in that invocation.

After `publication_status_unavailable` or `publication_wait_timed_out`, retained work may still continue. Do not run
concurrent Compile commands. Wait, then rerun `plan compile --github` with unchanged Plan bytes; the conditional request
safely reconciles or resumes the same retained singleton without creating another Compilation, repository, or push.
The same recovery applies when an invocation exits after an unresolved Publication start.

A GitHub preflight retry with no `retry_at` is paused and requires operator recovery. `publication_failed` and
`publication_cancelled` are terminal; inspect the validated phase and failure information rather than blindly
retrying. `publication_changed` means the pinned Publication identity or provenance changed, so the CLI deliberately
stopped without following the replacement.

## Error index

| Commands                                     | `error`                                                                                            | Exit | Meaning                                                                                                |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---: | ------------------------------------------------------------------------------------------------------ |
| Any leaf command                             | `invalid_arguments`                                                                                |    2 | Syntax was invalid; no request was made.                                                               |
| `plan init`                                  | `local_initialization_failed`                                                                      |    1 | Initialization failed without overwriting an existing path.                                            |
| Network commands                             | `invalid_configuration`                                                                            |    2 | API origin or saved Head state is incompatible.                                                        |
| `login`                                      | `authorization_denied`, `authorization_expired`                                                    |    1 | The approval was denied, or not granted before the callback wait or device code expired.               |
| `login`                                      | `login_failed`                                                                                     |    1 | Nothing was saved; `phase: "write"` means a token was issued ([recovery](#login-and-logout-errors)).   |
| `logout`                                     | `logout_failed`                                                                                    |    1 | Check `phase` and `revoked`; revocation may have happened ([recovery](#login-and-logout-errors)).      |
| Network commands                             | `authentication_required`                                                                          |    1 | No environment or saved token exists for the origin, or First Draft rejected it.                       |
| Plan commands, `compilation *`               | `local_input_unreadable`                                                                           |    1 | Required local Plan or private state could not be read.                                                |
| Status, Compile, Compilation commands        | `project_not_pushed`                                                                               |    1 | No API origin is pinned for the local Project.                                                         |
| `plan push`, `plan compile`                  | `request_outcome_unknown`                                                                          |    1 | A mutation or its response could not be verified; `plan compile` identifies its mutation phase.        |
| `plan push`, `plan compile`                  | `local_state_not_saved`                                                                            |    1 | The Plan was accepted but the private ETag state could not be replaced; includes `recovery_state`.     |
| `plan push`, `plan compile`                  | `server_rejected`                                                                                  |    1 | First Draft returned validated Plan diagnostics or rejected the request with a validated problem.      |
| `plan status`                                | `server_rejected`                                                                                  |    1 | First Draft rejected the analysis status request with a validated non-authentication problem.          |
| `plan status`                                | `status_unavailable`, `invalid_server_response`                                                    |    1 | The analysis read failed or violated its protocol.                                                     |
| `plan compile`                               | `analysis_status_unavailable`, `invalid_analysis_status`, `analysis_status_rejected`               |    1 | The bounded analysis read failed, was invalid, or was rejected.                                        |
| Analysis waits                               | `analysis_changed`, `wait_timed_out`, `analysis_wait_timed_out`                                    |    1 | The pinned analysis changed or remained processing at the deadline.                                    |
| `plan compile`                               | `plan_not_valid`                                                                                   |    1 | Analysis completed without `valid`; `current` contains diagnostics and status.                         |
| `plan compile`                               | `local_plan_changed`                                                                               |    1 | Local bytes or saved state changed after acceptance, before the selected mutation.                     |
| `plan compile`                               | `compilation_start_rejected`, `compilation_status_unavailable`, `invalid_compilation_status`       |    1 | Direct start was rejected or retained status failed; post-start errors include `current`.              |
| `plan compile`                               | `compilation_changed`, `compilation_wait_timed_out`, `compilation_failed`, `compilation_cancelled` |    1 | The pinned direct Compilation changed, timed out, failed, or was cancelled.                            |
| `plan compile --github`                      | `publication_start_rejected`, `publication_status_unavailable`, `invalid_publication_status`       |    1 | Publication start or status failed its validated transport contract.                                   |
| `plan compile --github`                      | `publication_changed`, `publication_wait_timed_out`, `publication_failed`, `publication_cancelled` |    1 | The pinned Publication changed, timed out, or reached a non-success terminal state.                    |
| `compilation status`, `compilation download` | `compilation_status_unavailable`, `invalid_compilation_status`                                     |    1 | The retained status could not be read or violated its exact contract.                                  |
| `compilation status --wait`                  | `compilation_changed`, `compilation_wait_timed_out`                                                |    1 | Retained identity/provenance changed or the wait ended.                                                |
| `compilation download`                       | `compilation_not_succeeded`                                                                        |    1 | Status was not `succeeded`; no artifact request was made.                                              |
| Download commands                            | `artifact_unavailable`, `invalid_artifact`                                                         |    1 | Artifact transport or integrity validation failed; direct Compile post-start errors include `current`. |
| Download commands                            | `invalid_output_path`                                                                              |    2 | The absent destination or root-adoption preconditions failed; `reason` identifies the stable refusal.  |
| Download commands                            | `materialization_failed`                                                                           |    1 | The output changed or its transaction failed; `reason` identifies incomplete rollback when applicable. |

Root-output `invalid_output_path.reason` values are `destination_exists`, `root_not_real`, `root_not_writable`,
`root_platform_unsupported`, `root_reserved_path`, `root_entry_unsupported`, `root_enclosing_worktree`,
`root_git_unavailable`, `root_git_unsupported`, `root_git_dirty`, `root_ignore_not_preserved`, and `root_busy`. Git
refusing discovery, including a `safe.directory` refusal, is `root_git_unavailable`; a discovered but unsupported
Git shape such as a submodule is `root_git_unsupported`. Root-output `materialization_failed.reason` values are
`output_changed`, `root_artifact_collision`, `root_ignore_changed`, `root_transaction_failed`, and
`root_rollback_incomplete`.
