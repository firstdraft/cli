# First Draft CLI changelog

This file records changes to the `@firstdraft.com/cli` package, newest first. Each entry starts with a
`## <version>` heading and says what changed and what callers need to do, if anything.

An entry is written in the pull request that sets its version, so the newest entry can precede publication. Headings
carry no release status. The `v<version>` tag and npm show whether a version is published.

Entries start with the first version prepared after this file was added, and earlier versions have none. The
repository's [tags](https://github.com/firstdraft/cli/tags) identify the source of each published version.

## 0.11.0

- Run `firstdraft project start` to get a hosted Project URL before writing the Plan. The command reserves the local
  Project identity so retrying in the same directory reopens the same Project.
- With Chrome installed, `firstdraft sketches publish` captures the screens listed in `sketches/board.json` at desktop
  and phone widths and publishes them with the exact working Plan. An interrupted publish can replay its original
  submission. After a conflicting edit, inspect the hosted review and use `--after` and `--head` to identify the
  revision and Plan you reconciled.
- After the owner approves a published revision, pass its ID to `firstdraft plan compile --revision <id>`. The CLI
  verifies the working Plan and selected local sources and hands those sources to the generated application in
  `.firstdraft/design/sketches/`. Keep the planning folder for retained downloads of that revision.
- Plan-only Projects can still use `plan init`, `plan push` and `plan compile`. The accepted Plan format remains
  `firstdraft.foundation-plan.sketch/0.23` and all CLI commands that check a service response require API contract
  `>= 0.9.1` and `< 0.10.0`. Use CLI 0.10.0 with a service still on API contract 0.9.0.

## 0.10.0

Lets First Draft tell a setup that it is out of date, and adds the account, report, note, `maintain`, and `start`
commands and a device login in two steps, so a person working alone hears when to update, their agent can log them in,
it can send the progress and failure reports and the notes the person agreed to, for the application's whole life, and
it can work through what needs attention in the deployed application. Moves the Rails
target to profile `rails-sketch/2026-11` and the accepted API contract to `0.9.x`. Removes GitHub publication, which
First Draft no longer offers.

- `plan init` writes Plans that target `rails-sketch/2026-11`. `plan compile` and `compilation download` accept only
  artifacts for that profile; an artifact for `rails-sketch/2026-10` reports `invalid_artifact`. The CLI sends a
  Plan's bytes unchanged and does not check the Plan's target profile.
- The accepted API-contract range is `>= 0.9.0` and `< 0.10.0`. The CLI now reads `FirstDraft-API-Contract` on each
  response. A response other than a `429` that names a contract outside that range, including a prerelease, stops it
  as described below; a response without the header does not.
- Every request, to `/v1` and to `/oauth`, carries
  `FirstDraft-Client: cli/<version>; plugin/<version>; agent/<name>; os/<platform>`. `plugin` and `agent` come from
  `FIRSTDRAFT_PLUGIN_VERSION`, sent without build metadata, and `FIRSTDRAFT_AGENT`, lowercased, and `os` from Node.js's
  `process.platform`. A part that is unset, longer than 40 characters, or not a plain version or name is left out.
  `login` no longer sends the computer's hostname.
- The CLI compares First Draft's version headers with this setup: `FirstDraft-Latest-Plugin` and
  `FirstDraft-Minimum-Plugin` with `FIRSTDRAFT_PLUGIN_VERSION` when that is set, otherwise `FirstDraft-Latest-CLI` and
  `FirstDraft-Minimum-CLI` with the CLI's own version. A pair counts only when both of its versions are readable. A
  setup older than the latest gets one `First Draft: an update is available (...)` line on standard error, just before
  the command's result, pointing to `https://firstdraft.com/update`. When `FIRSTDRAFT_PLUGIN_VERSION` is set but is not
  a version, neither pair is compared; when First Draft names the plugin versions, the line says the CLI could not
  tell whether the setup is current. A version or contract stop takes the place of either line.
- When the setup is older than the minimum, or the contract is outside the range, the CLI finishes handling that
  response and sends no further request. If that cut the command short, the command fails with `update_required` or
  `api_contract_unsupported`, and `current`, when present, names a Compilation that had already started. Otherwise
  the command keeps its result after one `First Draft: ... This command finished; ... before the next one.` line. A
  stop never replaces the result of `logout`.
- A `429` on any command except `logout`, `login` included, fails with `rate_limited`. It carries `status` 429,
  `retry_at` from `Retry-After` when that is readable, First Draft's problem in `response` when it sent a valid one
  of at most 64 KiB, except from `start`, which passes on no text First Draft wrote, and `current` when a
  Compilation had already started. Its detail says to try again after
  `retry_at`, when `response.detail` says, or in a minute. When `current` is present, the detail says to follow that
  Compilation with `compilation status` instead of compiling again.
- `firstdraft account` prints `{"reports": "on"}` or `{"reports": "off"}` for the signed-in account, at the origin
  that `login` would select.
- `firstdraft report progress` and `firstdraft report failure` first read the account at the Project's pinned origin,
  and send no report unless it has reports on. With reports off, they print a line that says so and exit 0. With
  reports on, unless the account response stopped the CLI, they print the exact JSON report, send it once, and print
  `Sent.` only on First Draft's `201` acknowledgment; a `403 reports_off` answer to the report prints the reports-off
  line and exits 0. `--step` is `setup`, `specs_first_run`, `behavior_written`, `specs_passing`, or
  `preview_started`, with optional counts of at most 1000000. `--kind` is `spec_failure`, `setup_failure`,
  `boot_error`, `lint_failure`, or `deployed_error`, which the `maintain` entries below describe. A failure report keeps each field only in its shape: an RSpec run of the
  application's specs, a Ruby constant, up to 20 application frames sent as `path:LINE`, version numbers, and the plain
  words of the first line of the message (at most 300 characters) and fix summary (at most 200). When anything is
  left out, a `Left out:` line names each field left out, counts the frames that are not in the application's files
  with a line number, and says when frames after the first 20 were dropped; the printed JSON is exactly what is
  sent. Both commands find the Project from the generated application's root after root adoption, or from the
  Project's directory. The Compilation ID is optional: without it, a report names the Compilation recorded below.
- `firstdraft note unstated_request`, `firstdraft note unclear_guidance`, and `firstdraft note wrong_output` send a
  note about a problem with First Draft itself, with options named after the note's fields: `--request`;
  `--page` or `--code` with `--unclear`; or `--source analysis` or `--source generated_code` with `--expected` and
  `--actual`, and `--code`, `--compilation-id`, or `--file` as the source allows. Each takes `--workaround`. A note
  belongs to the Project, so it needs only the Plan's first push, and goes to `POST /v1/projects/{project_id}/notes`.
  Like a report, it reads the account first and sends nothing with reports off, keeps each field only in its shape
  (plain words of at most 300 characters, a Skill page, a diagnostic code, a file in the application, or a lowercase
  UUIDv7), prints the exact JSON and what it left out, sends it once, and never retries. A note about generated code
  names the recorded Compilation unless `--compilation-id` names one.
- `plan compile` and `compilation download` record the Compilation whose code they wrote in `compilation.json` beside
  the Project's `state.json`, in the archive at `.firstdraft/design/.firstdraft/` after root adoption, as
  `{"format": "firstdraft.cli-compilation/1", "compilation_id": "<id>"}`. `state.json` keeps its format. A record that
  cannot be written leaves the command's result and adds one `First Draft:` line on standard error.
- `firstdraft start`, which an agent runs once before other work, prints fixed sentences on standard output, one fact
  per line: the CLI version and, when `FIRSTDRAFT_PLUGIN_VERSION` holds one, the plugin's; the update line, when
  First Draft names a newer version; whether this computer has a saved login for the origin and whether a token in
  the environment takes its place; and, when reports are on, when to send progress and failure reports and notes, and
  with which command. With reports off, it says nothing about reports or notes. With a token, it makes one request, an account
  read; without one, it makes none and names the two login steps below. It exits 0 only when First Draft accepted
  the token. A setup below the minimum or on another API contract fails with `update_required` or
  `api_contract_unsupported`, even though the account read was its only request.
- `firstdraft login --no-wait` asks for a device grant, prints the link, the user code, and when they expire, saves
  the waiting login as `device-login.json` beside `credentials.json` with mode `0600`, and exits. After the person
  approves, `firstdraft login --finish` polls at the grant's interval for at most 15 seconds, saves the token, and
  removes that file; it also removes it once the grant is refused, expired, or spent. It prints `Logged in:`,
  `Still waiting:`, `Expired:`, or `Refused:` with the next step. The device code is never printed. The browser login
  and the one-process `login --interactive` are unchanged.
- `firstdraft maintain` prints a deployed Environment's open items, most severe first, 200 a page, each with its
  GitHub issue as `issue_url`. It reads the account first and, only when reports are on, says on standard error when
  to send a failure report about an error item. `maintain show <item-id>` prints one item with its latest evidence, whose
  `untrusted` list names the fields that can hold end users' text, and what done means. `maintain resolve <item-id>`
  resolves it with a `--reason`, a `--cause` that says what caused the error (`unknown` when the agent could not
  tell), and an optional `--detail`, such as the pull request. `maintain defer <item-id> --until <time>` sets an open
  item aside, out of the index and escalation, until a time with its offset in the next 90 days, and
  `maintain ask-owner <item-id> --question <text>` records a question for the owner on it. Each takes
  `--environment`, `production` by default, and changes no local state. They run from the application's folder or
  the Project's directory: without the Project's state there, as in a fresh clone of the application, they read the
  Project ID from the application's `.firstdraft/gaps.json`, use the origin `login` would select, and say so on
  standard error.
- `report failure --kind deployed_error --item <item-id>` reports an error in a deployed application that
  `maintain resolve` traced to code First Draft generated. It names the item and takes no `--message`.
- After an ambiguous push, from `plan push` or `plan compile`, or an ambiguous direct Compilation start,
  `request_outcome_unknown` now says to run the same command once more with the same options and environment, and
  what a `412` or `compilation_active` answer then means, instead of telling the caller to stop.
- `plan compile --github` is gone: `--github` fails with `invalid_arguments` (exit status 2), like any unknown option,
  and the CLI no longer calls `/v1/projects/{project_id}/github-publication`. `request_outcome_unknown` no longer has
  `phase: "publication"`, and these `error` values are gone: `publication_start_rejected`,
  `publication_status_unavailable`, `invalid_publication_status`, `publication_changed`, `publication_wait_timed_out`,
  `publication_failed`, and `publication_cancelled`.
- New `error` values, each with exit status 1: `update_required`, `api_contract_unsupported`, `rate_limited`,
  `account_unavailable`, `report_rejected`, `report_unavailable`, `note_rejected`, `note_unavailable`,
  `compilation_not_recorded`, `maintain_rejected`, `maintain_unavailable`, `invalid_maintain_response`, and, from
  `login --finish`, `authorization_pending` and `login_not_started`; and, from the
  note commands, `note_incomplete` with exit status 2. `account`, `start`, and the report and note commands also report
  `authentication_required` and `invalid_server_response` (exit status 1) and `invalid_arguments` and
  `invalid_configuration` (exit status 2). The report, note, and `maintain` commands also report `local_input_unreadable`
  and `project_not_pushed` (exit status 1). `login_failed` gains the reasons `device_login_invalid` and
  `device_login_unavailable` for the waiting device login's file.

Use CLI 0.10.0 with a Service that serves API `0.9.x`. Once a response from an origin names API `0.8.x`, the CLI sends
nothing more and says to use the CLI version that origin supports. A plugin's launcher should set
`FIRSTDRAFT_PLUGIN_VERSION` and `FIRSTDRAFT_AGENT`; without the first, the CLI compares its own version with the CLI
versions. Callers that parse standard error should drop the `First Draft: ` lines, which any network command may now
write before its result; `start` writes its update line on standard output instead. A Skill that checked
`firstdraft --help` runs `firstdraft start` in its place and may run the two login steps itself. A caller that ran
`plan compile --github` runs `plan compile --output <absent-directory>`, which works on every platform and writes only
the application, then initializes, commits, and pushes that directory with `git` and `gh`.

## 0.9.0

Moves the Rails target to profile `rails-sketch/2026-10`. First Draft adopts Rails 8.1.4 under that new profile ID and
API contract `0.8.0`, because Rails 8.1.4 changes the generated schema's column order and an inflection rule.

- `plan init` writes Plans that target `rails-sketch/2026-10`. The Plan format stays
  `firstdraft.foundation-plan.sketch/0.23`.
- `plan compile` and `compilation download` accept only artifacts for `rails-sketch/2026-10`. An artifact for
  `rails-sketch/2026-09-bookmark-assets` reports `invalid_artifact`.
- The accepted API-contract range is `>= 0.8.0` and `< 0.9.0`.

Use CLI 0.9.0 with a Service that serves API `0.8.x`; CLI 0.8.2 writes and accepts only the retired profile. Projects
and Plans on the retired profile are not migrated. First Draft refuses them, and its refusal names the fix: start a
new Project from the Plan.

## 0.8.2

Adds `firstdraft compilation cancel <compilation-id>`, so an agent can recover a Compilation that will not finish
without an operator calling the Service for it.

- A Project allows one active Compilation. While a stuck one stays queued or running, `plan push` and `plan compile`
  fail with First Draft's `409 compilation_active` problem, whose `detail` names that Compilation. Check it with
  `compilation status`, cancel it, then rerun `plan compile`.
- The command makes one `POST` to the Service's cancel route for the local Project and prints the cancelled
  Compilation in the same shape as `compilation status`. Repeating it prints the same result. First Draft refuses to
  cancel a succeeded or failed Compilation and leaves it unchanged.
- New `error` values: `compilation_cancel_rejected`, which carries the Service problem in `response`
  (`compilation_not_cancellable`, `compilation_not_found`, or `project_not_found`), and
  `compilation_cancel_unavailable`, after which cancelling again is safe. A response that violates the Compilation
  contract reports `invalid_compilation_status`.
- `firstdraft --help` describes the `compilation` group as "Inspect, download, and cancel Compilations".

Existing callers need no change. The cancel route is part of the Service's API `0.7.x` contract, so the accepted
API-contract range is unchanged.

## 0.8.1

Adds `firstdraft login` and `firstdraft logout`, so a token no longer has to be copied from `/api-tokens` into the
environment.

- `login` approves the CLI in a browser and saves a token for the selected origin. By default it uses the OAuth
  authorization code flow with PKCE and a loopback redirect. `login --interactive` (also `-i` or `--device`) uses the
  device flow for machines without a browser. `--staging` and `FIRSTDRAFT_API_URL` select the origin as they do for
  other remote commands.
- Tokens are saved per exact origin in `$XDG_CONFIG_HOME/firstdraft/credentials.json`, or
  `~/.config/firstdraft/credentials.json`, with mode `0600`. The CLI never prints a saved token.
- `logout` revokes the saved token for the selected origin and removes the local entry.
- Remote commands use the saved token for their origin when `FIRSTDRAFT_API_TOKEN` or
  `FIRSTDRAFT_STAGING_API_TOKEN` is unset. A saved login never authenticates a different origin.
- New `error` values: `authorization_denied`, `authorization_expired`, `login_failed`, and `logout_failed`. The
  `authentication_required` detail now points to `firstdraft login`.

Callers that set token environment variables need no change, because those variables still take precedence over a
saved login. The release needs a Service that serves the `/oauth` endpoints. Those endpoints sit outside the
versioned API, so the accepted API-contract range is unchanged.
