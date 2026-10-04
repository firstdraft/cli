# First Draft CLI changelog

This file records changes to the `@firstdraft.com/cli` package, newest first. Each entry starts with a
`## <version>` heading and says what changed and what callers need to do, if anything.

An entry is written in the pull request that sets its version, so the newest entry can precede publication. Headings
carry no release status. The `v<version>` tag and npm show whether a version is published.

Entries start with the first version prepared after this file was added, and earlier versions have none. The
repository's [tags](https://github.com/firstdraft/cli/tags) identify the source of each published version.

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
