# Agent Instructions — First Draft CLI

Start with `docs/README.md` and follow its task routes. Detailed command semantics belong in `docs/commands.md`,
handled-error recovery in `docs/errors.md`, publication mechanics in `RELEASING.md`, and changes by version in
`CHANGELOG.md`. When behavior changes, update its owning document in the same change.

- Verify with `npm run check`, which takes about 30 seconds. A fresh checkout needs `npm ci --ignore-scripts` first.
- Follow `CONTRIBUTING.md` for commit messages, pull request bodies, review setup, and landing.
- To add a command, follow `docs/commands.md#add-a-command`. To change the version, follow
  `RELEASING.md#prepare-the-version-pull-request`, which includes the `CHANGELOG.md` entry.
- Sibling repositories: `firstdraft/firstdraft` (private) owns the Service API and Plan format; `firstdraft/skills`
  owns the Skill and plugin packaging.
- Changes to the accepted API-contract range, accepted Plan formats, command names or flags, handled `error` values,
  exit statuses, `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `RELEASING.md`, `.claude/settings.json`, or
  `.codex/config.toml` get an independent review through cross-review: `codex-review` from Claude Code,
  `$claude-review` from Codex. Pass the service repository's `docs/review-focus.md` as `--focus-file`, fetched
  with `gh api` when no sibling checkout exists. Put the reviewer, session id, and verdict in the pull request
  body, and leave the findings out.
- `firstdraft plan compile` defaults to local output in the current directory. GitHub publication requires
  `--github`; Codespaces is a fallback. Keep Skill callers and recovery instructions aligned with this boundary.
- The service repository coordinates releases and owns their approval and smoke policy. One approved coordinated
  release covers its named CLI steps; do not ask again between them. A merge alone does not authorize a release.
  `RELEASING.md` covers the publication steps.
