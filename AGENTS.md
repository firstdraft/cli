# Agent Instructions — First Draft CLI

Start with `docs/README.md` and follow its task routes. Detailed command semantics belong in `docs/commands.md`,
handled-error recovery in `docs/errors.md`, living release policy in `RELEASING.md`, and dated release observations
in `docs/release-history.md`. When behavior changes, update its owning document in the same change.

- After merging to `main`, report the exact merged SHA and ask whether to coordinate and promote the three-repository
  candidate. If the user defers, call the SHA unpromoted. Never publish npm, deploy First Draft, or release the
  plugin without explicit approval.
- Treat npm publication under `next` as candidate availability, not a completed stable release. A stable CLI release
  is complete only after that exact candidate passes its explicitly named release-specific qualification, is
  separately approved, and is selected by npm's `latest` dist-tag. Preserve dated alpha observations as history
  rather than describing them as current channel state.
