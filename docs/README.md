# First Draft CLI documentation

Use this page to find the narrowest authoritative document for a task. Runtime source and tests remain the final
evidence for implemented behavior; if they contradict a document, surface the contradiction instead of guessing.

| If the task concerns...                                                                | Read first                                    |
| -------------------------------------------------------------------------------------- | --------------------------------------------- |
| Public installation, trust, or the shortest current journey                            | [Root README](../README.md)                   |
| Commands, options, environment variables, API behavior, output, or materialization     | [Command reference](commands.md)              |
| Stable errors, exit codes, retry safety, ambiguous outcomes, or local recovery         | [Errors and recovery](errors.md)              |
| Version policy, release preparation, publication, verification, rollback, or promotion | [Release policy and runbook](../RELEASING.md) |
| What was observed for an earlier tag, package, or dist-tag                             | [Release history](release-history.md)         |
| Vulnerability reporting                                                                | [Security policy](../SECURITY.md)             |

## Authority boundaries

- [README.md](../README.md) owns public onboarding, the shortest supported journey, current trust claims, and routes.
- [commands.md](commands.md) owns detailed command semantics. Built-in `--help`, runtime source, and tests own exact
  executable syntax and behavior.
- [errors.md](errors.md) owns handled-error interpretation and recovery guidance.
- [RELEASING.md](../RELEASING.md) owns living release policy and the operator runbook.
- [release-history.md](release-history.md) preserves dated release observations. Recheck live tags, package versions,
  dist-tags, access, and trusted-publisher state before relying on them operationally.
- [AGENTS.md](../AGENTS.md) routes agent work; it should stay compact rather than duplicate these documents.

## Work on the repository

Development uses Node.js 24.18.0 and npm 11.16.0, pinned in `.tool-versions`. From a fresh checkout:

```sh
npm ci --ignore-scripts
npm audit
npm run check
```

`npm run check` runs type checking, linting, formatting, tests, the exact package allowlist check, and a packed-package
smoke test. To inspect the package manifest without writing a tarball:

```sh
npm pack --dry-run --json --ignore-scripts
```

To reproduce the length-delimited SHA-256 used by external evidence to identify packaged JavaScript runtime inputs
(`package.json`, `bin/firstdraft.js`, and every `.js` file under `src/`), run:

```sh
node scripts/runtime-digest.js
```
