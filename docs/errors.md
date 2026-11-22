# First Draft CLI errors and recovery

This page owns handled-error interpretation, retry safety, and recovery guidance. Read the
[command reference](commands.md) for successful command behavior.

## Handled output contract

Every handled subcommand failure ends with exactly one JSON object on standard error. Any network command may first
write one [update or stop line](commands.md#update-line-and-refusals), and `plan compile` may first write progress lines;
both begin with the exact `First Draft: ` prefix, so machine consumers can remove only those lines and parse the
remaining JSON document. `login` may first write its human-readable authorization instructions; its JSON object
starts on the line after them. `report` and `note` print what they send on standard output before sending it, so
standard output may hold that preview when they fail. `start`, `login --no-wait`, and `login --finish` print their plain
sentences for the agent on standard output, which holds them when the command fails. Branch on the stable `error`
value rather than the human-readable `detail`.

Handled output never includes command arguments, local Plan bytes, raw artifact bytes, raw filesystem or network
errors, or unvalidated response bodies. `local_state_not_saved` is the sole exception to private-state redaction:
its `recovery_state` is required to repair the accepted ETag locally. Root-level and command-group usage failures
remain human-readable text on standard error with exit 2. Unexpected programming defects remain loud.

## Environment and credential errors

`invalid_configuration` stops before a request when `--staging` conflicts with `FIRSTDRAFT_API_URL` or a Project's
saved origin. Push and Compile also reject any URL override that differs from that pin. Unset the conflicting
override or use a separate initialized project directory for the other environment; do not redirect existing
private Project state. Status, retained download, and cancel commands continue using their pin.

`authentication_required` means the selected environment's token is missing or rejected with `401`. Staging uses
`FIRSTDRAFT_STAGING_API_TOKEN`, including old staging Projects with no flag. Production and custom origins use
`FIRSTDRAFT_API_TOKEN`. When that variable is unset, the token saved by `firstdraft login` for the exact origin is
used. The CLI never substitutes one environment's credential for another's. Run `firstdraft login` for the same
environment (with `--staging` or the same `FIRSTDRAFT_API_URL`), or refresh the environment token, then follow the
command's recovery instructions below. If a saved login is rejected, run `firstdraft login` again.

From `start`, `authentication_required` means it is not ready: no token exists for the origin, so it made no
request, or First Draft rejected the token it sent. Its standard output says which and names the next step: the
[agent's two login steps](commands.md#log-in-from-an-agent), or, for a rejected environment token, asking the person
to replace or unset it. No handled error from `start` carries `response`, so none repeats text First Draft wrote.

## Login and logout errors

`login` and `logout` never print a token. A local credential failure can occur after the server has issued or revoked a token.

- `authorization_denied`: the approval was denied in the browser. Run `firstdraft login` again to retry. After
  `login --finish`, the person refused: ask them before starting another login with `login --no-wait`.
- `authorization_expired`: no loopback callback arrived within five minutes, or the device code expired before the
  CLI received a token. Run `firstdraft login` again. Use `--interactive` if no browser on this machine can reach the printed URL.
  After `login --finish`, start again with `login --no-wait`, which prints a new link and code.
- `authorization_pending`, from `login --finish`: First Draft has not confirmed an approval yet, and the CLI stopped after its
  short wait. The link and the code still work until the time it prints; when the person says they approved, run
  `login --finish` again.
- `login_not_started`, from `login --finish`: no waiting login started with `login --no-wait` exists for the
  selected origin, or it already ended. Run `firstdraft start` to see whether this computer is logged in.
- `login_failed`: the login could not be completed. `reason`, when present, is the server's OAuth error code (for
  example `invalid_grant` for a used, expired, or mismatched code), `loopback_unavailable` when the local listener
  could not start, `credentials_invalid` / `credentials_unavailable` when the credentials file could not be read or
  written, or `credentials_locked` when another command held its lock for 10 seconds. `status` is the HTTP status
  when one was received. Credentials failures include `credentials_path` and `phase`. With `phase: "read"`, no
  request was made; repair or remove the file and retry. With `phase: "write"`, First Draft issued a token but the
  CLI could not save it. Revoke that new token on the selected origin's `/api-tokens` page, then repair the
  credentials file and retry login. Any previously saved token remains unchanged when the replacement fails.
  `device_login_invalid` or `device_login_unavailable` means the waiting device login, `device-login.json` at
  `credentials_path`, was malformed or could not be read, written, or removed; it carries no `phase`. Remove that
  file, then run `firstdraft start` to see whether this computer is logged in. From `login --finish`, `reason`
  `invalid_grant` means the grant is spent and its file was removed: start again with `login --no-wait`. Any other
  poll failure, such as a network failure or a server error, keeps the file, so `login --finish` can run again.
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

## Update and limit errors

These errors replace a command's result when a First Draft response told the CLI to stop before the command
finished. The CLI finishes handling that response, so a push it accepted still saves its ETag, and then sends
nothing more. When the stopping response was the command's last, the command reports its own result instead, after
one `First Draft: ` line that names the required update ([update line and refusals](commands.md#update-line-and-refusals)).
`start` always reports the error, because a setup that must update is not ready.

- `update_required`: First Draft's `FirstDraft-Minimum-Plugin` is newer than this setup's plugin, or, when no plugin
  version is set, its `FirstDraft-Minimum-CLI` is newer than this CLI. `plugin_version` and `minimum_plugin_version`,
  or `minimum_cli_version`, name the versions, beside `cli_version`. Tell the person to update with the steps at `update_url` (`https://firstdraft.com/update`), then run the
  same command again with the same options; the CLI saved the ETag of any push that First Draft accepted. When
  `current` is present, a Compilation had already started: follow `current.compilation.id` with
  `compilation status` instead of compiling again.
- `api_contract_unsupported`: First Draft serves an API contract outside `accepted_api_contract`. When `api_contract`
  is newer, update and continue as above. When it is older, the CLI is newer than that origin's Service; use the CLI
  that the origin supports.
- `rate_limited`: First Draft answered `429` because a limit was reached. The refused request did nothing.
  `response.code`, when present, names the limit: `compilation_limit_reached` or `project_limit_reached` for the Compilations or
  new Projects an account may start in a day, and `reports_rate_limited` for its reports in an hour.
  `response.detail` says when the next one can start, and `retry_at`, when present, is that UTC time from
  `Retry-After`. Wait until then and run the command again; without either, the detail says to wait a minute. `login --interactive` meets
  a limit shared by every CLI that starts a device login at once. When `current` is present, follow that Compilation
  as above instead.

A local failure while handling the stopping response, such as `local_state_not_saved` or `materialization_failed`,
is reported as itself, with its recovery data, after the stop line.

## Ambiguous mutations

`plan compile` supplies `phase: "push" | "compilation" | "publication"` when `request_outcome_unknown` requires
phase-specific recovery:

- `phase: "push"`, and `request_outcome_unknown` from `plan push`, mean the Plan may have been accepted, but the
  response could not be verified, so local state was not changed. Run the same command once more, with the same
  options and environment; a first push without a pinned origin otherwise goes to production. If First Draft accepts
  it, carry on. If it answers `server_rejected` with status `412` (`precondition_failed`), its Plan is no longer the
  one this folder last pushed: the first push may have landed, or another copy of the Project pushed. If another
  copy holds newer work, continue from that copy. Otherwise start a new Project, which forks this one: run
  `firstdraft plan init --name <name>` in a new folder, copy `.firstdraft/foundation-plan.json` from the old folder
  over the new one, and push or compile from there with the same options and the old folder's origin: the `api_url`
  in its `.firstdraft/state.json`, or, when a first push never saved one, the origin that push used. Select it with
  `--staging` for staging, or the same `FIRSTDRAFT_API_URL` for a custom origin. A new folder has no pinned origin,
  so without one the push goes to production. Never construct an ETag from the Plan
  digest or edit `.firstdraft/state.json`.
- `phase: "compilation"` means a local Compilation (the default mode, with optional `--output`) may have started,
  but its identity is unknown. The CLI never repeats that `POST` itself. Run the same `plan compile` command, with
  the same options and environment, once more. If a Compilation is still active, First Draft refuses with
  `compilation_active` and names it; follow [stuck Compilation recovery](#stuck-compilation-recovery). Otherwise the
  rerun starts a new Compilation; one that the first attempt may have started costs only service time and one of the
  day's Compilations.
- `phase: "publication"` means the singleton Publication mutation was not resolved. Do not run concurrent Compile
  commands. After the prior invocation exits, wait and rerun `plan compile --github` with unchanged Plan bytes to safely
  reconcile or resume the retained singleton.

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

Do not rerun `plan compile` after its Compilation start was accepted: that command creates new work; it is not a
retained-Compilation reconciliation command.

If `request_outcome_unknown` reports `phase: "compilation"`, the start request did not yield a validated retained
ID. The CLI sent exactly one `POST` and did not retry it. Rerun `plan compile` once, as
[ambiguous mutations](#ambiguous-mutations) describes.

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
`plan compile`. If it stays `queued` or `running`, follow [stuck Compilation recovery](#stuck-compilation-recovery).
`compilation_failed`, `compilation_cancelled`, and `compilation_changed` already carry the
validated `current` projection appropriate to their stopping boundary. Authentication recovery may refresh the
credential, but it must continue from the retained ID rather than starting another Compilation.

## Stuck Compilation recovery

A Project allows one active Compilation. While one is queued or running, `plan push` and `plan compile` report
`server_rejected` with First Draft's `409 compilation_active` problem in `response`, because the Plan cannot be
replaced. `plan compile` can also meet it at the Compilation start, as `compilation_start_rejected`. Either problem's
`response.detail` names the active Compilation's ID.

1. Read that Compilation once with `firstdraft compilation status <id>`. One that has reached `succeeded`, `failed`,
   or `cancelled` no longer blocks; rerun `plan compile`.
2. If it is still `queued` or `running` well after a Compilation normally finishes, for example after a
   `plan compile` wait timed out, cancel it with `firstdraft compilation cancel <id>`. Cancelling throws away any
   work it is still doing.
3. After the cancel succeeds, rerun `plan compile`.

Cancel never changes a succeeded or failed Compilation, and repeating it is safe:

- `compilation_cancel_rejected` means First Draft refused and nothing was cancelled; `response.code` says why.
  `409 compilation_not_cancellable` means the Compilation already succeeded or failed, so it no longer blocks; check
  it with `compilation status`. `404 compilation_not_found` or `404 project_not_found` means First Draft found no
  such Compilation for this Project and account. Check the ID, the directory, and that the environment and login
  match the ones that started it.
- `compilation_cancel_unavailable` means a network failure, timeout, or server error left the outcome unconfirmed.
  Rerun `compilation cancel`, or check the result with `compilation status`.
- `invalid_compilation_status` means the response violated the Compilation contract, so the cancellation may or may
  not have happened. Check with `compilation status` rather than repeating the unchanged request.

## Report and note errors

`report progress`, `report failure`, and the `note` commands never stop an agent's work. Each reads the account first
and sends nothing unless it has reports on. With reports off, the command exits 0 with a line that says so; that is not
an error.

- `report_rejected`, `note_rejected`: First Draft refused the report or note and kept nothing. `response.code` says
  why, for example `compilation_not_found` when the Compilation is not in this Project, `compilation_not_succeeded`
  when it produced no code, or `invalid_report` or `invalid_note` when a field breaks its shape. Continue without it.
- `report_unavailable`, `note_unavailable`: a network failure, timeout, server error, or a success without First
  Draft's `201` acknowledgment left the outcome unconfirmed, and First Draft may hold the report or note. Continue
  without it rather than sending it again.
- `compilation_not_recorded`: a report, or a note about generated code, named no Compilation, and the CLI has none
  [recorded](commands.md#record-the-compilation-whose-code-was-written) for this Project, so nothing was sent. Name the
  Compilation the code came from: put `compilation.id` from `plan compile` right after `report progress` or
  `report failure`, or pass it to a note with `--compilation-id`.
- `note_incomplete` (exit 2): a field the note needs had nothing left after shaping, so nothing was sent. `detail` names
  each such field and why. Write the field again in plain words, or give a page or code in its shape.
- `account_unavailable`: `account` could not read the account. This read-only request is safe to retry.
  `invalid_server_response` from `account` means the response broke its contract. From a report or note command,
  either error means the account read failed, so nothing was sent; continue without it.

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

| Commands                                       | `error`                                                                                            | Exit | Meaning                                                                                                         |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---: | --------------------------------------------------------------------------------------------------------------- |
| Any leaf command                               | `invalid_arguments`                                                                                |    2 | Syntax was invalid; no request was made.                                                                        |
| Network commands except `logout`               | `update_required`, `api_contract_unsupported`                                                      |    1 | First Draft needs a newer plugin or CLI, or serves another API contract ([recovery](#update-and-limit-errors)). |
| Network commands except `logout`               | `rate_limited`                                                                                     |    1 | First Draft refused a request at a limit; `retry_at` says when to try again.                                    |
| `plan init`                                    | `local_initialization_failed`                                                                      |    1 | Initialization failed without overwriting an existing path.                                                     |
| Network commands                               | `invalid_configuration`                                                                            |    2 | API origin or saved Head state is incompatible.                                                                 |
| `login`                                        | `authorization_denied`, `authorization_expired`                                                    |    1 | The approval was denied, or the callback wait or device code ended before the CLI received a token.             |
| `login --finish`                               | `authorization_pending`, `login_not_started`                                                       |    1 | First Draft has not confirmed an approval yet, or no device login is waiting for the origin.                    |
| `login`                                        | `login_failed`                                                                                     |    1 | Nothing was saved; `phase: "write"` means a token was issued ([recovery](#login-and-logout-errors)).            |
| `logout`                                       | `logout_failed`                                                                                    |    1 | Check `phase` and `revoked`; revocation may have happened ([recovery](#login-and-logout-errors)).               |
| Network commands                               | `authentication_required`                                                                          |    1 | No environment or saved token exists for the origin, or First Draft rejected it.                                |
| Plan, `compilation *`, `report`, `note`        | `local_input_unreadable`                                                                           |    1 | Required local Plan or private state, or the Compilation record, could not be read.                             |
| Status, Compile, Compilation, `report`, `note` | `project_not_pushed`                                                                               |    1 | No API origin is pinned for the local Project.                                                                  |
| `plan push`, `plan compile`                    | `request_outcome_unknown`                                                                          |    1 | A mutation or its response could not be verified; `plan compile` identifies its mutation phase.                 |
| `plan push`, `plan compile`                    | `local_state_not_saved`                                                                            |    1 | The Plan was accepted but the private ETag state could not be replaced; includes `recovery_state`.              |
| `plan push`, `plan compile`                    | `server_rejected`                                                                                  |    1 | First Draft returned validated Plan diagnostics or rejected the request with a validated problem.               |
| `plan status`                                  | `server_rejected`                                                                                  |    1 | First Draft rejected the analysis status request with a validated non-authentication problem.                   |
| `plan status`                                  | `status_unavailable`, `invalid_server_response`                                                    |    1 | The analysis read failed or violated its protocol.                                                              |
| `plan compile`                                 | `analysis_status_unavailable`, `invalid_analysis_status`, `analysis_status_rejected`               |    1 | The bounded analysis read failed, was invalid, or was rejected.                                                 |
| Analysis waits                                 | `analysis_changed`, `wait_timed_out`, `analysis_wait_timed_out`                                    |    1 | The pinned analysis changed or remained processing at the deadline.                                             |
| `plan compile`                                 | `plan_not_valid`                                                                                   |    1 | Analysis completed without `valid`; `current` contains diagnostics and status.                                  |
| `plan compile`                                 | `local_plan_changed`                                                                               |    1 | Local bytes or saved state changed after acceptance, before the selected mutation.                              |
| `plan compile`                                 | `compilation_start_rejected`, `compilation_status_unavailable`, `invalid_compilation_status`       |    1 | Direct start was rejected or retained status failed; post-start errors include `current`.                       |
| `plan compile`                                 | `compilation_changed`, `compilation_wait_timed_out`, `compilation_failed`, `compilation_cancelled` |    1 | The pinned direct Compilation changed, timed out, failed, or was cancelled.                                     |
| `plan compile --github`                        | `publication_start_rejected`, `publication_status_unavailable`, `invalid_publication_status`       |    1 | Publication start or status failed its validated transport contract.                                            |
| `plan compile --github`                        | `publication_changed`, `publication_wait_timed_out`, `publication_failed`, `publication_cancelled` |    1 | The pinned Publication changed, timed out, or reached a non-success terminal state.                             |
| `compilation status`, `compilation download`   | `compilation_status_unavailable`, `invalid_compilation_status`                                     |    1 | The retained status could not be read or violated its exact contract.                                           |
| `compilation status --wait`                    | `compilation_changed`, `compilation_wait_timed_out`                                                |    1 | Retained identity/provenance changed or the wait ended.                                                         |
| `compilation download`                         | `compilation_not_succeeded`                                                                        |    1 | Status was not `succeeded`; no artifact request was made.                                                       |
| `compilation cancel`                           | `compilation_cancel_rejected`                                                                      |    1 | Nothing was cancelled; `response.code` says why ([recovery](#stuck-compilation-recovery)).                      |
| `compilation cancel`                           | `compilation_cancel_unavailable`                                                                   |    1 | The cancellation could not be confirmed; repeating it is safe.                                                  |
| `compilation cancel`                           | `invalid_compilation_status`                                                                       |    1 | The response violated the Compilation contract; check status before repeating.                                  |
| Download commands                              | `artifact_unavailable`, `invalid_artifact`                                                         |    1 | Artifact transport or integrity validation failed; direct Compile post-start errors include `current`.          |
| Download commands                              | `invalid_output_path`                                                                              |    2 | The absent destination or root-adoption preconditions failed; `reason` identifies the stable refusal.           |
| Download commands                              | `materialization_failed`                                                                           |    1 | The output changed or its transaction failed; `reason` identifies incomplete rollback when applicable.          |
| `account`, `start`                             | `account_unavailable`, `invalid_server_response`                                                   |    1 | The account read failed or violated its contract.                                                               |
| `report progress`, `report failure`            | `report_rejected`, `report_unavailable`, `account_unavailable`, `invalid_server_response`          |    1 | The report was refused or its outcome is unconfirmed, or the account read failed; continue without it.          |
| `note <kind>`                                  | `note_rejected`, `note_unavailable`, `account_unavailable`, `invalid_server_response`              |    1 | The note was refused or its outcome is unconfirmed, or the account read failed; continue without it.            |
| `report`, `note wrong_output`                  | `compilation_not_recorded`                                                                         |    1 | No Compilation was given or recorded; nothing was sent ([recovery](#report-and-note-errors)).                   |
| `note <kind>`                                  | `note_incomplete`                                                                                  |    2 | A field the note needs had nothing left after shaping; nothing was sent.                                        |

Root-output `invalid_output_path.reason` values are `destination_exists`, `root_not_real`, `root_not_writable`,
`root_platform_unsupported`, `root_reserved_path`, `root_entry_unsupported`, `root_enclosing_worktree`,
`root_git_unavailable`, `root_git_unsupported`, `root_git_dirty`, `root_ignore_not_preserved`, and `root_busy`. Git
refusing discovery, including a `safe.directory` refusal, is `root_git_unavailable`; a discovered but unsupported
Git shape such as a submodule is `root_git_unsupported`. Root-output `materialization_failed.reason` values are
`output_changed`, `root_artifact_collision`, `root_ignore_changed`, `root_transaction_failed`, and
`root_rollback_incomplete`.
