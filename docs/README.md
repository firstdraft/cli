# First Draft CLI documentation

Use this page to find the narrowest authoritative document for a task. Runtime source and tests remain the final
evidence for implemented behavior; if they contradict a document, surface the contradiction instead of guessing.

| Task                             | Read first                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------ |
| Local app development            | [Local guide](https://firstdraft.github.io/firstdraft/docs/guides/local-app.html)                |
| Codespaces fallback              | [Drawing Board guide](https://github.com/firstdraft/drawing-board#build-an-app-with-first-draft) |
| Installation or package contract | [Root README](../README.md)                                                                      |
| Commands, Service API, or output | [Command reference](commands.md); [add a command](commands.md#add-a-command)                     |
| Errors and recovery              | [Errors and recovery](errors.md)                                                                 |
| Versioning and publication       | [Release runbook](https://github.com/firstdraft/cli/blob/main/RELEASING.md)                      |
| Changes by version               | [Changelog](https://github.com/firstdraft/cli/blob/main/CHANGELOG.md)                            |
| Vulnerability reporting          | [Security policy](../SECURITY.md)                                                                |

## Authority boundaries

- [README.md](../README.md) owns repository orientation, direct installation, package boundaries, and routes.
- [commands.md](commands.md) owns detailed command semantics, Service endpoints, and the add-a-command checklist.
  Built-in `--help`, runtime source, and tests own exact executable syntax and behavior.
- [errors.md](errors.md) owns handled-error interpretation and recovery guidance.
- `RELEASING.md` owns publication mechanics. The service repository owns release policy.
- `CHANGELOG.md` gets each new version's entry in the pull request that sets the version.
- The source repository's `AGENTS.md` routes agent work; it should stay compact rather than duplicate these documents.
  Its `CLAUDE.md` only imports `AGENTS.md`, so Claude Code and Codex read the same instructions.

## Retrieval quality

Start here, then load the one owning document for the task. Follow a cross-link only when the task crosses an
authority boundary. Create another page only for a distinct audience, task, or authority.

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

Pass Node test options through `npm test` to focus a run while retaining discovery under `test/`:

```sh
npm test -- --test-name-pattern="publication"
```

To reproduce the length-delimited SHA-256 used by external evidence to identify packaged JavaScript runtime inputs
(`package.json`, `bin/firstdraft.js`, and every `.js` file under `src/`), run:

```sh
node scripts/runtime-digest.js
```
