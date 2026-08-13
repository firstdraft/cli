import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const markdownFiles = [
  ...["AGENTS.md", "README.md", "RELEASING.md", "SECURITY.md"].map((file) =>
    path.join(repository, file),
  ),
  ...findMarkdownFiles(path.join(repository, "docs")),
];

const sources = new Map(
  markdownFiles.map((file) => [file, readFileSync(file, "utf8")]),
);

test("documentation routes commands, recovery, and release knowledge", () => {
  const readme = sources.get(path.join(repository, "README.md"));
  const index = sources.get(path.join(repository, "docs/README.md"));
  const instructions = sources.get(path.join(repository, "AGENTS.md"));
  const releasing = sources.get(path.join(repository, "RELEASING.md"));
  const history = sources.get(path.join(repository, "docs/release-history.md"));

  assert(readme);
  assert(index);
  assert(instructions);
  assert(releasing);
  assert(history);

  assert.match(
    readme,
    /`firstdraft` is the command-line client for First Draft\./,
  );
  assert.doesNotMatch(
    readme,
    /\[First Draft\]\(https:\/\/firstdraft\.com\)/,
    "public onboarding must not route readers to the unrelated site at the API origin",
  );
  assert.match(readme, /\[Command reference\]\(docs\/commands\.md\)/);
  assert.match(readme, /\[Errors and recovery\]\(docs\/errors\.md\)/);
  assert.match(readme, /\[Release history\]\(docs\/release-history\.md\)/);
  assert.match(index, /\[Command reference\]\(commands\.md\)/);
  assert.match(index, /\[Errors and recovery\]\(errors\.md\)/);
  assert.match(index, /\[Release policy and runbook\]\(\.\.\/RELEASING\.md\)/);
  assert.match(instructions, /Start with `docs\/README\.md`/);
  assert.match(releasing, /\[release history\]\(docs\/release-history\.md\)/);
  assert.match(history, /historical evidence, not a statement of current/);

  const publicDocumentation = [...sources.values()].join("\n");
  assert.doesNotMatch(
    publicDocumentation,
    /https:\/\/github\.com\/firstdraft\/firstdraft(?:[\s/)#]|$)/,
  );
  assert.doesNotMatch(
    `${readme}\n${releasing}`,
    /\b(?:July|August) \d{1,2}, 2026\b/,
  );
});

test("local documentation links and fragments resolve", () => {
  for (const [sourceFile, source] of sources) {
    for (const target of markdownLinkTargets(source)) {
      if (isExternalTarget(target)) continue;

      const [rawPath, rawFragment] = target.split("#", 2);
      const targetFile = rawPath
        ? path.resolve(path.dirname(sourceFile), decodeURIComponent(rawPath))
        : sourceFile;

      assert.equal(
        existsSync(targetFile) && statSync(targetFile).isFile(),
        true,
        `${path.relative(repository, sourceFile)} links to missing ${target}`,
      );

      if (rawFragment === undefined || rawFragment === "") continue;

      const fragment = decodeURIComponent(rawFragment).toLowerCase();
      const targetSource =
        sources.get(targetFile) ?? readFileSync(targetFile, "utf8");
      assert.equal(
        markdownHeadingFragments(targetSource).has(fragment),
        true,
        `${path.relative(repository, sourceFile)} links to missing fragment ${target}`,
      );
    }
  }
});

/** @param {string} directory @returns {string[]} */
function findMarkdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) return findMarkdownFiles(entryPath);
      return entry.isFile() && entry.name.endsWith(".md") ? [entryPath] : [];
    })
    .sort();
}

/** @param {string} source @returns {string[]} */
function markdownLinkTargets(source) {
  const targets = [];
  const linkPattern = /(?<!!)\[[^\]]+\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g;

  for (const match of withoutFencedCode(source).matchAll(linkPattern)) {
    const target = match[1];
    assert(target);
    targets.push(target.replace(/^<|>$/g, ""));
  }

  return targets;
}

/** @param {string} target */
function isExternalTarget(target) {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//");
}

/** @param {string} source @returns {Set<string>} */
function markdownHeadingFragments(source) {
  const fragments = new Set();
  const counts = new Map();

  for (const line of withoutFencedCode(source).split("\n")) {
    const match = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;

    const heading = match[1];
    assert(heading);
    const base = heading
      .toLowerCase()
      .replace(/<[^>]*>/g, "")
      .replace(/[`*_~]/g, "")
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-");
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    fragments.add(count === 0 ? base : `${base}-${count}`);
  }

  return fragments;
}

/** @param {string} source */
function withoutFencedCode(source) {
  /** @type {string | undefined} */
  let fence;

  return source
    .split("\n")
    .filter((line) => {
      const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (match) {
        const marker = match[1];
        assert(marker);

        if (fence === undefined) {
          fence = marker[0];
        } else if (marker[0] === fence) {
          fence = undefined;
        }

        return false;
      }

      return fence === undefined;
    })
    .join("\n");
}
