#!/usr/bin/env bash
set -euo pipefail

test "$(node --version)" = "v24.18.0"
test "$(npm --version)" = "11.16.0"
test "$GITHUB_REPOSITORY" = "firstdraft/cli"
test "$GITHUB_EVENT_NAME" = "push"
test "$GITHUB_REF_TYPE" = "tag"
test "$GITHUB_REF" = "refs/tags/$GITHUB_REF_NAME"
test "$GITHUB_REF_PROTECTED" = "true"
release_sha="$(git rev-parse 'HEAD^{commit}')"
event_sha="$(git rev-parse "${GITHUB_SHA}^{commit}")"
test "$release_sha" = "$event_sha"
git fetch --force --no-tags origin \
  "+refs/heads/main:refs/remotes/origin/main" \
  "+refs/tags/${GITHUB_REF_NAME}:refs/release-check/tag"
remote_tag_sha="$(git rev-parse 'refs/release-check/tag^{commit}')"
test "$release_sha" = "$remote_tag_sha"
package_version="$(node --print 'JSON.parse(require("node:fs").readFileSync("package.json", "utf8")).version')"
test "$GITHUB_REF_NAME" = "v$package_version"
git rev-list --first-parent refs/remotes/origin/main > "$RUNNER_TEMP/main-first-parent"
grep -Fqx "$release_sha" "$RUNNER_TEMP/main-first-parent"
