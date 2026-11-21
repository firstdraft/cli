# First Draft CLI changelog

This file records changes to the `@firstdraft.com/cli` package, newest first. Each entry starts with a
`## <version>` heading and says what changed and what callers need to do, if anything.

An entry is written in the pull request that sets its version, so the newest entry can precede publication. Headings
carry no release status. The `v<version>` tag and npm show whether a version is published.

Entries start with the first version prepared after this file was added, and earlier versions have none. The
repository's [tags](https://github.com/firstdraft/cli/tags) identify the source of each published version.

## 0.10.0

Lets First Draft tell a setup that it is out of date, and adds the account and report commands, so a person working
alone hears when to update and their agent can send the progress and failure reports the person agreed to. Moves the
Rails target to profile `rails-sketch/2026-11` and the accepted API contract to `0.9.x`.

- `plan init` writes Plans that target `rails-sketch/2026-11`. `plan compile` and `compilation download` accept only
  artifacts for that profile; an artifact for `rails-sketch/2026-10` reports `invalid_artifact`. The CLI sends a
  Plan's bytes unchanged and does not check the Plan's target profile.
- The accepted API-contract range is `>= 0.9.0` and `< 0.10.0`. The CLI now reads `FirstDraft-API-Contract` on each
  response, and a contract outside that range, including a prerelease, stops it as described below.
- Every request, to `/v1` and to `/oauth`, carries
  `FirstDraft-Client: cli/<version>; plugin/<version>; agent/<name>; os/<platform>`. `plugin` and `agent` come from
  `FIRSTDRAFT_PLUGIN_VERSION` and `FIRSTDRAFT_AGENT`, and `os` from Node.js's `process.platform`; a part that is unset
  or is not a plain version or name is left out. `login` no longer sends the computer's hostname.
- The CLI compares First Draft's version headers with this setup: `FirstDraft-Latest-Plugin` and
  `FirstDraft-Minimum-Plugin` with `FIRSTDRAFT_PLUGIN_VERSION` when that is set, otherwise `FirstDraft-Latest-CLI` and
  `FirstDraft-Minimum-CLI` with the CLI's own version. A pair counts only when both of its versions are readable. A
  setup older than the latest gets one `First Draft: an update is available (...)` line on standard error, just before
  the command's result, pointing to `https://firstdraft.com/update`. When `FIRSTDRAFT_PLUGIN_VERSION` is set but is not
  a version, neither pair is compared; when First Draft names the plugin versions, the line says the CLI could not
  tell whether the setup is current.
- When the setup is older than the minimum, or the contract is outside the range, the CLI finishes handling that
  response and sends no further request. If that cut the command short, the command fails with `update_required` or
  `api_contract_unsupported`, and `current`, when present, names a Compilation that had already started. Otherwise
  the command keeps its result after one `First Draft: ... This command finished; ... before the next one.` line. A
  stop never replaces the result of `logout`.
- A `429` on any command except `logout`, `login` included, fails with `rate_limited`. It carries `status` 429,
  `retry_at` from `Retry-After` when that is readable, and First Draft's problem in `response` when it sent a valid
  one. Its detail says to try again after `retry_at`, when `response.detail` says, or in a minute.
- `firstdraft account` prints `{"reports": "on"}` or `{"reports": "off"}` for the signed-in account, at the origin
  that `login` would select.
- `firstdraft report progress` and `firstdraft report failure` first read the account at the Project's pinned origin,
  and send no report unless it has reports on. With reports off, they print a line that says so and exit 0. With
  reports on, they print the exact JSON report, send it once, and print `Sent.` only on First Draft's `201`
  acknowledgment; a `403 reports_off` answer to the report prints the reports-off line and exits 0. `--step` is
  `setup`, `specs_first_run`, `behavior_written`, `specs_passing`, or `preview_started`, with optional counts of at
  most 1000000. `--kind` is `spec_failure`, `setup_failure`, `boot_error`, or `lint_failure`. A failure report keeps
  each field only in its shape: an RSpec run of the application's specs, a Ruby constant, up to 20 application frames
  sent as `path:LINE`, version numbers, and the plain words of the first line of the message (at most 300 characters)
  and fix summary (at most 200). A `Left out:` line names what it dropped. Both commands find the Project from the
  generated application's root after root adoption, or from the Project's directory.
- After an ambiguous push or Compile, `request_outcome_unknown` now says to run the same command once more with the
  same options, and what a `412` or `compilation_active` answer then means, instead of telling the caller to stop.
- New `error` values, each with exit status 1: `update_required`, `api_contract_unsupported`, `rate_limited`,
  `account_unavailable`, `report_rejected`, and `report_unavailable`. `account` and the report commands also report
  `authentication_required` and `invalid_server_response` (exit status 1) and `invalid_arguments` and
  `invalid_configuration` (exit status 2). The report commands also report `local_input_unreadable` and
  `project_not_pushed` (exit status 1).

Use CLI 0.10.0 with a Service that serves API `0.9.x`. With an origin that serves API `0.8.x`, it sends nothing after
the first response and says to use the CLI version that origin supports. A plugin's launcher should set
`FIRSTDRAFT_PLUGIN_VERSION` and `FIRSTDRAFT_AGENT`; without the first, the CLI compares its own version with the CLI
versions. Callers that parse standard error should drop the `First Draft: ` lines, which any network command may now
write before its result.

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
