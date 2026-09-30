# First Draft CLI changelog

This file records changes to the `@firstdraft.com/cli` package, newest first. Each entry starts with a
`## <version>` heading and says what changed and what callers need to do, if anything.

An entry is written in the pull request that sets its version, so the newest entry can precede publication. Headings
carry no release status. The `v<version>` tag and npm show whether a version is published.

Entries start with the first version prepared after this file was added, and earlier versions have none. The frozen
[release history](docs/release-history.md) records releases through 0.4.0. The repository's
[tags](https://github.com/firstdraft/cli/tags) identify the source of each published version, including later ones.

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
