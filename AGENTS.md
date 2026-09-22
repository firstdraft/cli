# Agent Instructions — First Draft CLI

Start with `docs/README.md` and follow its task routes. Detailed command semantics belong in `docs/commands.md`,
handled-error recovery in `docs/errors.md`, living release policy in `RELEASING.md`, and dated release observations
in `docs/release-history.md`. When behavior changes, update its owning document in the same change.

- `firstdraft plan compile` defaults to local output in the current directory. GitHub publication requires
  `--github`; Codespaces is a fallback. Keep Skill callers and recovery instructions aligned with this boundary.
- A coordinated release needs explicit approval once. Reuse an existing approval for its named scope; do not ask
  again between repository publication steps. A merge alone does not authorize a release.
- Publish approved versions directly to `latest`. Reuse successful CI for the exact source and relevant smoke
  evidence. When changed behavior needs a smoke, use local compilation; Codespaces and Revyl are not release gates.
  Preserve dated release observations as history.
