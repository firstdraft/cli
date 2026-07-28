# First Draft CLI

`firstdraft` is the command-line client for [First Draft](https://github.com/firstdraft/firstdraft). It is being
built for agents that author and review Foundation Plans with their users.

The package is not released yet. This repository currently contains only the auditable command shell; Plan and
network behavior will arrive in reviewed increments.

## Requirements

- Running the CLI: Node.js 22.0.0 or newer
- Working on this repository: Node.js 24.18.0 (pinned in `.tool-versions`)

## Development

```sh
npm ci
npm run check
npm run pack:check
```

## Trust model

- The published CLI will run the reviewed JavaScript source directly, without generated or bundled code.
- The command shell has no runtime dependencies, install scripts, telemetry, update checks, or implicit network
  activity.
- Package contents are allowlisted and checked before release.
- CI exercises the exact minimum Node.js version separately from current development tooling.
- Public releases will use npm provenance after the first useful version bootstraps trusted publishing.

Security issues should follow the
[private reporting instructions](https://github.com/firstdraft/cli/security/advisories/new).
