# First Draft CLI

`firstdraft` is the command-line client for [First Draft](https://github.com/firstdraft/firstdraft). It is being
built for agents that author and review Foundation Plans with their users.

The package is not released yet. This repository contains the auditable command shell, local Foundation Plan
initialization, and conditional whole-document push; release behavior will arrive in reviewed increments.

## Requirements

- Running the CLI: Node.js 22.0.0 or newer
- Working on this repository: Node.js 24.18.0 (pinned in `.tool-versions`)

## Development

```sh
npm ci
npm run check
npm run pack:check
```

## Start a Foundation Plan

From the project that the Plan describes:

```sh
firstdraft plan init --application-key oscar_party --name "Oscar Party"
```

This creates an empty `sketch/0.19` Plan and client-generated Project ID under `.firstdraft/`. A nested ignore file
keeps that local scratch area out of Git without changing the project's own `.gitignore`. Initialization makes no
network request and refuses to replace an existing `.firstdraft` path.

## Push a Foundation Plan

From the initialized project:

```sh
firstdraft plan push
```

The command sends the exact bytes in `.firstdraft/foundation-plan.json`. The first push conditionally creates the
Project; later pushes replay the complete ETag saved in `.firstdraft/state.json` so a stale writer cannot replace a
newer Plan. Successful responses and server diagnostics are printed as JSON for an agent to inspect.

The initial API origin defaults to `https://firstdraft.com`. Set `FIRSTDRAFT_API_URL` to use another HTTPS origin
or a loopback HTTP development server. The first successful push pins the normalized origin in local state, and a
later override must match it.

If a failure happens after sending the request, the CLI reports that the outcome may be ambiguous and leaves local
state unchanged. It never constructs an ETag from the Plan digest or trusts an ETag from a response it could not
fully verify. Until First Draft has a read or reconciliation endpoint, an accepted request whose response cannot be
verified may require manual recovery. If a verified response cannot replace local state, preserve the printed
recovery state; an adjacent `.tmp` file may contain the same private recovery copy.

## Trust model

- The published CLI will run the reviewed JavaScript source directly, without generated or bundled code.
- The CLI has no runtime dependencies, install scripts, telemetry, update checks, or network activity except an
  explicitly invoked API command.
- Package contents are allowlisted and checked before release.
- CI exercises the exact minimum Node.js version separately from current development tooling.
- Public releases will use npm provenance after the first useful version bootstraps trusted publishing.

Security issues should follow the
[private reporting instructions](https://github.com/firstdraft/cli/security/advisories/new).
