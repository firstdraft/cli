# First Draft CLI

firstdraft is the command-line client shared by First Draft agents and automation. It manages local Foundation Plan
files, calls the versioned Service API, exposes reviewed analysis and GapSets, materializes verified Compilations,
and coordinates private GitHub publication.

Start with the [local development guide](https://gist.github.com/raghubetina/3d424a97a1eaa6de8c406e67f32a237e):
install the CLI and Skill, then compile into your current folder with `firstdraft plan compile --output .`. No Drawing Board
clone or GitHub push is required. The [Drawing Board guide](https://github.com/firstdraft/drawing-board#build-an-app-with-first-draft)
is the Codespaces fallback.

CLI 0.4 and later make `--output .` the default. Keep the explicit flag with CLI 0.3, whose zero-flag command selects GitHub
publication.

## What this repository owns

- local Plan initialization, UUIDs, application keys, and source hashing;
- conditional whole-document push and conflict reporting;
- analysis polling and complete GapSet output;
- direct Compile-and-materialize and private publish orchestration;
- retained Compilation inspection and artifact download;
- terminal output, exit status, and recovery contracts;
- the dependency-free npm package; and
- package provenance and publication.

The Service owns Foundation Plan meaning and server-side lifecycle. Skills own the agent conversation. This
repository owns the exact command and transport behavior between them.

## Start with the right document

| Task                                 | Read first                                                                                                            |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Change the CLI                       | [Agent instructions](https://github.com/firstdraft/cli/blob/main/AGENTS.md), then [documentation map](docs/README.md) |
| Find a command or output contract    | [Command reference](docs/commands.md)                                                                                 |
| Interpret an error or recover safely | [Errors and recovery](docs/errors.md)                                                                                 |
| Prepare or publish a package         | [Release runbook](RELEASING.md)                                                                                       |
| Inspect dated package observations   | [Release history](docs/release-history.md)                                                                            |
| Report a vulnerability               | [Security policy](SECURITY.md)                                                                                        |

Run firstdraft --help or a command group's --help for concise terminal syntax.

## Repository layout

| Path     | Responsibility                                                |
| -------- | ------------------------------------------------------------- |
| bin/     | Published executable entrypoint                               |
| src/     | Commands, API client, local Plan state, and output contracts  |
| test/    | Command, protocol, recovery, and package tests                |
| scripts/ | Test runner and package allowlist/smoke checks                |
| docs/    | Command, error, release-history, and maintainer documentation |

## Development

Development uses the Node.js and npm versions pinned in `.tool-versions`. Follow
[Work on the repository](docs/README.md#work-on-the-repository) for the complete install, audit, and check sequence.

```sh
npm run check
```

The complete check runs type checking, ESLint, Prettier verification, tests, package allowlist validation, and a
smoke installation of the packed tarball. Use the narrower scripts while iterating:

```sh
npm run typecheck
npm run lint
npm test
npm run pack:check
npm run pack:smoke
```

To exercise the checkout directly:

```sh
node bin/firstdraft.js --help
```

Remote commands read FIRSTDRAFT_API_TOKEN from the environment. See
[Push a Foundation Plan](docs/commands.md#push-a-foundation-plan) for FIRSTDRAFT_API_URL and origin pinning. Keep
tokens out of arguments, shell history, fixtures, snapshots, and logs.

## Package contract

The published CLI supports Node.js 22 or newer. Direct automation callers can install the stable package with:

```sh
npm install --global @firstdraft.com/cli
```

Pin an exact compatible version when a repeatable installation matters; [RELEASING.md](RELEASING.md) owns channel
and release meaning.

The published package:

- installs the firstdraft executable;
- runs reviewed JavaScript source directly;
- has no runtime dependencies or install scripts;
- performs no telemetry, update check, or network request unless the caller invokes an API command;
- reads Bearer credentials only from the environment; and
- carries npm provenance linking registry bytes to its GitHub workflow and commit.

Inspect the packed file list whenever a source or documentation path moves. The public documentation graph,
including the release runbook and dated release history, ships with the package. `AGENTS.md` and the source-only
`release/compatibility.json` do not.

## Release boundary

Merging source is not package publication. An approved coordinated release publishes directly to `latest`, reusing
successful CI for the exact source. [RELEASING.md](RELEASING.md) owns the short release and recovery procedure.
