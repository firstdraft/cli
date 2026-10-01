# Contributing

This page covers checks, commit messages, pull requests, independent review, landing, and maintenance for the
First Draft CLI. [AGENTS.md](AGENTS.md) routes agent work and lists the changes that need independent review; the
[documentation map](docs/README.md) routes everything else. The commit, pull request, review, landing, and
maintenance rules below also apply in `firstdraft/skills` and the private service repository,
`firstdraft/firstdraft`. When you change one of them, change it in all three `CONTRIBUTING.md` pages.

## Checks

Use the Node.js and npm versions pinned in `.tool-versions`. Before committing, run the sequence in
[Work on the repository](docs/README.md#work-on-the-repository): `npm ci --ignore-scripts` in a fresh checkout or
worktree, then `npm audit` and `npm run check`. Hosted CI repeats the tests and package checks on Node.js 22.0 on
Linux, Windows, and macOS.

This repository keeps Codex's default `workspace-write` sandbox, which has no network access. Inside it, `npm audit`
cannot reach the npm registry, `npm ci` fails unless every package is already in your npm cache, and `npm run check`
fails because several tests start a local HTTP server on `127.0.0.1`. When Codex asks to rerun one of these commands
outside the sandbox, check the command and approve it. The sandbox also keeps `.git` read-only, so Codex asks before
it commits.

## Commit messages

- Write the subject in the imperative mood, in 50 characters or fewer.
- Wrap the body at 72 columns or fewer, and explain why the change was needed; the diff shows what changed.
- Squash the branch to one reviewable commit before merging, as [Landing](#landing) describes.
- Do not mention an agent. Add no `Co-authored-by` or other agent trailer to a commit, and no "Generated with" line
  to a pull request body. The tracked `.claude/settings.json` turns off Claude Code's attribution. Codex adds them
  when attribution is on in your Codex account settings, which override repository instructions; turn it off
  there. If Codex adds a `Co-authored-by: Codex <noreply@openai.com>` trailer to a commit, remove it before
  pushing. If it adds the line `Generated with [Codex](https://openai.com/codex/).` to a pull request body, remove
  it before opening the pull request, or edit the body if Codex opened it.

## Pull requests

The pull request body carries one line: `Docs: updated X` or `Docs: none, because ...`. The
[`Docs line`](.github/workflows/pr-docs-line.yml) check fails until the body has one, and it skips pull requests
that a bot such as Dependabot opens.

The body also carries:

- a summary of what changed and why; and
- when [AGENTS.md](AGENTS.md) requires independent review, one line, `Review: <reviewer>, session <id>, <verdict>`,
  with the findings left out.

Use GitHub closing keywords only for completed Issues: even `does not close #123` closes #123. Say the remainder is
tracked in open Issue #123 instead. The [pull request template](.github/pull_request_template.md) holds these fields.

## Independent review

The reviewer is the other vendor's agent, through [cross-review](https://github.com/raghubetina/cross-review): Codex
reviews from Claude Code, and Claude Code reviews from Codex. Install both and sign in to each (`claude auth login`
and `codex login`). In Claude Code, ask for a Codex review or run `/codex-review:codex-review`; in Codex, use
`$claude-review`. Neither is a shell command.

- **Claude Code:** the tracked `.claude/settings.json` registers the cross-review marketplace and enables
  `codex-review`. It loads once you accept the workspace-trust prompt for the main checkout; linked worktrees use
  that trust. A headless `claude -p` run loads it only where you have already trusted the checkout.
- **Codex:** the tracked `.codex/config.toml` declares the marketplace and enables `$claude-review` in a trusted
  project. The first trusted session fetches the plugin and the next one loads it;
  `codex plugin marketplace upgrade cross-review` fetches it at once. In the Codex desktop app, quit and reopen it
  after the first fetch.

If the tracked configuration does not load a plugin, install it yourself:

```sh
claude plugin marketplace add raghubetina/cross-review
claude plugin install codex-review@cross-review
codex plugin marketplace add raghubetina/cross-review
codex plugin add claude-review@cross-review
```

To run a review:

1. Start a `new` session over the branch (`new branch main`) or an explicit range (`new range <base>..<head>`).
   When an instruction-policy change is the only reason for review, run that one session with `--effort high`
   instead of the default `max`.
2. Pass the service repository's `docs/review-focus.md` with `--focus-file`, from a sibling `firstdraft/firstdraft`
   checkout or fetched into the ignored `tmp/`:

   ```sh
   mkdir -p tmp
   gh api repos/firstdraft/firstdraft/contents/docs/review-focus.md \
     -H 'Accept: application/vnd.github.raw' > tmp/review-focus.md
   ```

   After `--`, name the claims the change affects: the specific statements and pages, such as the owners in the
   `Docs:` line and the facts the change alters. The reviewer checks whether each still holds. Give the reviewer the
   diff and affected behavior, not an author verdict to repeat.

3. The host runs `cite` and classifies each finding before relaying it.
4. Record decisions as `reject F-...: reason`, `accept F-...`, or `defer F-...`. A later re-review in the same
   session covers only the amendment (`range <reviewed-head>..HEAD`).

Fix feedback in coherent amendments. Re-review an amendment only when it does more than apply accepted findings;
that follow-up covers the extra change and its affected consumers.

Do not merge while a required review is still running. Review third-party changes, such as Dependabot or outside
pull requests, with `--capability read-only`.

## Landing

Merge after hosted CI passes and any required review has finished. Squash to one reviewable commit, or more only for
logically discrete units of work, and land it with a rebase merge: `gh pr merge <number> --rebase`. Use a merge
commit only when the integration is itself meaningful work, such as resolving substantial conflicts. After merging,
report the repository and the exact merged SHA.

A merge does not release anything. [RELEASING.md](RELEASING.md) covers publication, which the service repository
coordinates.

## Maintenance

At each new model release, or quarterly if none comes first, the owner prunes instructions and documentation checks
in all three repositories: `firstdraft/firstdraft`, `firstdraft/skills`, and `firstdraft/cli`.

- Test each line of every `AGENTS.md`: would an agent get a task wrong if the line were gone? If not, delete it. In
  Claude Code, `/doctor prompt-audit` also suggests lines to cut.
- Shrink each exceptions list, such as `docs/owner-shape-exceptions.json` in `firstdraft/firstdraft`.
- Delete any documentation check that caught nothing that tests or review would not have caught.
