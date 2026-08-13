# First Draft CLI

`firstdraft` is the command-line client for First Draft. It helps agents author and review
Foundation Plans with their users, then submit a valid Plan for the current bounded compilation and private GitHub
publication journey.

The current `0.1.x` line includes local Plan initialization, application-key and UUID generation, conditional
whole-document push, whole-graph analysis polling, compile-and-publish orchestration, and read-only retained
Compilation download. Remote commands require a compatible First Draft service and are intended for coordinated
trials; publishing this CLI does not make the wider service generally available.

## Install

Running the CLI requires Node.js 22.0.0 or newer. Install the stable release selected by npm's `latest` dist-tag:

```sh
npm install --global @firstdraft.com/cli
firstdraft --version
```

The package installs the `firstdraft` executable. Pin an exact compatible version, such as
`@firstdraft.com/cli@0.1.0`, when a repeatable installation matters. Candidate publication under `next` is not stable
release completion; see the [release policy](RELEASING.md) and [dated release history](docs/release-history.md).

## Shortest current journey

From the project that the Foundation Plan describes:

```sh
firstdraft plan init --name "Oscar Party"
```

Edit `.firstdraft/foundation-plan.json`, preserving each authored subject's UUID across renames and moves that do not
replace the concept. Generate new subject identities locally as needed:

```sh
firstdraft generate uuid
```

Provide an API token only through the environment, then submit, analyze, compile, and publish the exact current Plan:

```sh
export FIRSTDRAFT_API_TOKEN="your-token"
firstdraft plan compile
```

Invoking `plan compile` authorizes the internal GitHub Publication lifecycle. It proceeds only after the accepted
Plan's analysis is valid, writes allowlisted progress to standard error, and on success writes only the validated
private GitHub repository URL to standard output. The current Publication is a Project singleton and cannot be
repointed to a later accepted Head. Read the [complete command contract](docs/commands.md#compile-and-publish-the-current-plan)
before using it and follow [phase-specific recovery](docs/errors.md#ambiguous-mutations) after an ambiguous mutation.

To review analysis before that terminal action, use `firstdraft plan push` followed by
`firstdraft plan status --wait`. See [Command reference](docs/commands.md) for all supported commands, flags, output
contracts, and retained-Compilation operations.

## Trust model

- The published CLI runs the reviewed JavaScript source directly, without generated or bundled code.
- It has no runtime dependencies, install scripts, telemetry, update checks, or network activity except an explicitly
  invoked API command.
- API tokens are read from `FIRSTDRAFT_API_TOKEN`, sent as Bearer credentials, and never saved in `.firstdraft` or
  printed. Revoke an exposed token in First Draft.
- Package contents are allowlisted and checked before release; repository-only documentation is not packaged.
- CI exercises the exact minimum Node.js version separately from current development tooling.
- Public packages carry npm provenance linking registry bytes to the reviewed GitHub workflow and commit.

## Find the right documentation

| Task                                                    | Read                                       |
| ------------------------------------------------------- | ------------------------------------------ |
| Install and complete the shortest current journey       | This README                                |
| Choose a command or inspect its exact behavior          | [Command reference](docs/commands.md)      |
| Interpret an error or recover safely                    | [Errors and recovery](docs/errors.md)      |
| Contribute to this repository                           | [Documentation map](docs/README.md)        |
| Prepare, publish, verify, recover, or promote a release | [Release policy and runbook](RELEASING.md) |
| Check dated package, tag, or channel observations       | [Release history](docs/release-history.md) |
| Report a vulnerability                                  | [Security policy](SECURITY.md)             |

Run `firstdraft --help` or a command group's `--help` for concise terminal syntax. The documentation map explains
which source owns each longer-lived contract.
