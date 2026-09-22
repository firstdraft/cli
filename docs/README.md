# First Draft CLI documentation

Use this page to find the narrowest authoritative document for a task. Runtime source and tests remain the final
evidence for implemented behavior; if they contradict a document, surface the contradiction instead of guessing.

| Task                             | Read first                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------ |
| Local app development            | [Local guide](https://gist.github.com/raghubetina/3d424a97a1eaa6de8c406e67f32a237e)              |
| Codespaces fallback              | [Drawing Board guide](https://github.com/firstdraft/drawing-board#build-an-app-with-first-draft) |
| Installation or package contract | [Root README](../README.md)                                                                      |
| Commands, API, or output         | [Command reference](commands.md)                                                                 |
| Errors and recovery              | [Errors and recovery](errors.md)                                                                 |
| Versioning and publication       | [Release policy and runbook](../RELEASING.md)                                                    |
| Dated release observations       | [Release history](release-history.md)                                                            |
| Vulnerability reporting          | [Security policy](../SECURITY.md)                                                                |

## Authority boundaries

- [README.md](../README.md) owns repository orientation, direct installation, package boundaries, and routes.
- [commands.md](commands.md) owns detailed command semantics. Built-in `--help`, runtime source, and tests own exact
  executable syntax and behavior.
- [errors.md](errors.md) owns handled-error interpretation and recovery guidance.
- [RELEASING.md](../RELEASING.md) owns living release policy and the operator runbook.
- [release-history.md](release-history.md) preserves dated release observations. Recheck live tags, package versions,
  and dist-tags before relying on them operationally; publisher configuration is checked when it changes or fails.
- The source repository's `AGENTS.md` routes agent work; it should stay compact rather than duplicate these documents.

## Retrieval quality

Start here, then load the one owning document for the task. Follow a cross-link only when the task crosses an
authority boundary. Create another page only for a distinct audience, task, or authority.

The documentation tests keep `AGENTS.md` at or below 2 KiB, the root README at or below 6 KiB, and this map at or
below 4 KiB. They also require every public topic to remain reachable from this map or the root README and verify
repository-local links and fragments. The package check separately verifies that every relative link in the
packaged Markdown resolves inside that exact package.

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
