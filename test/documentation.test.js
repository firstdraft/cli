import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  isExternalTarget,
  markdownLinkTargets,
  withoutFencedCode,
} from "../scripts/markdown-documentation.js";
import { RAILS_TARGET_PROFILE } from "../src/compilation-artifact.js";
import { VERSION } from "../src/version.js";

const repository = fileURLToPath(new URL("..", import.meta.url));
const markdownFiles = [
  ...[
    "AGENTS.md",
    "CHANGELOG.md",
    "README.md",
    "RELEASING.md",
    "SECURITY.md",
  ].map((file) => path.join(repository, file)),
  ...findMarkdownFiles(path.join(repository, "docs")),
];

const sources = new Map(
  markdownFiles.map((file) => [file, readFileSync(file, "utf8")]),
);

test("public documentation avoids unavailable destinations", () => {
  const readme = sources.get(path.join(repository, "README.md"));
  assert(readme);
  assert.equal(
    markdownLinkTargets(readme).includes("https://firstdraft.com"),
    false,
    "public onboarding must route readers to a guide rather than the API landing page",
  );
  for (const source of sources.values()) {
    for (const target of markdownLinkTargets(source)) {
      assert.doesNotMatch(
        target,
        /^https:\/\/github\.com\/firstdraft\/firstdraft(?:[/#]|$)/,
      );
    }
  }
});

test("Claude Code imports the shared agent instructions", () => {
  assert.equal(
    readFileSync(path.join(repository, "CLAUDE.md"), "utf8"),
    "@AGENTS.md\n",
    "CLAUDE.md must only import AGENTS.md so both harnesses read one source",
  );
});

test("documentation entrypoints stay lean and route every public topic", () => {
  const entrypointBudgets = new Map([
    [path.join(repository, "AGENTS.md"), 2_048],
    [path.join(repository, "README.md"), 6_144],
    [path.join(repository, "docs/README.md"), 4_096],
  ]);

  for (const [file, budget] of entrypointBudgets) {
    const source = sources.get(file);
    assert(source);
    assert.ok(
      Buffer.byteLength(source) <= budget,
      `${path.relative(repository, file)} exceeds its ${budget}-byte retrieval budget`,
    );
  }

  const publicTopics = new Set(
    markdownFiles.filter((file) => file !== path.join(repository, "AGENTS.md")),
  );
  const pending = [
    path.join(repository, "README.md"),
    path.join(repository, "docs/README.md"),
  ];
  const reachable = new Set();

  while (pending.length > 0) {
    const sourceFile = pending.pop();
    assert(sourceFile);
    if (reachable.has(sourceFile)) continue;
    reachable.add(sourceFile);

    const source = sources.get(sourceFile);
    assert(source);
    for (const target of markdownLinkTargets(source)) {
      const targetFile = repositoryLink(sourceFile, target)?.file;
      if (targetFile && publicTopics.has(targetFile)) pending.push(targetFile);
    }
  }

  for (const file of publicTopics) {
    assert.equal(
      reachable.has(file),
      true,
      `${path.relative(repository, file)} is not reachable from a documentation entrypoint`,
    );
  }
});

test("links to repository files and fragments resolve", () => {
  for (const [sourceFile, source] of sources) {
    for (const target of markdownLinkTargets(source)) {
      const link = repositoryLink(sourceFile, target);
      if (link === undefined) continue;
      const { file: targetFile, fragment: rawFragment } = link;

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

test("living documentation names only current version identities", () => {
  const identities = versionIdentities(
    VERSION,
    JSON.parse(
      readFileSync(path.join(repository, "release/compatibility.json"), "utf8"),
    ).requires,
  );
  const findings = [];

  for (const [file, source] of sources) {
    const name = path.relative(repository, file);
    if (
      name === "CHANGELOG.md" ||
      name === path.join("docs", "release-history.md")
    ) {
      continue;
    }

    findings.push(...staleVersionFindings(name, source, identities));

    for (const match of source.matchAll(/rails-sketch\/[\w-]*\w/g)) {
      if (match[0] === RAILS_TARGET_PROFILE) continue;

      findings.push(
        `${name}:${lineAt(source, match.index)} names ${match[0]}, but src/compilation-artifact.js accepts ` +
          `${RAILS_TARGET_PROFILE}. Name that profile or describe the behavior without one.`,
      );
    }
  }

  assert.ok(
    findings.length === 0,
    `Update stale version identities:\n${findings.join("\n")}`,
  );
});

test("the version lint catches unlabeled, prerelease, and unreleased CLI versions", () => {
  // Fixed identities from the 0.8.0 release, when the API minor trailed the CLI minor by one.
  const identities = versionIdentities("0.8.0", {
    api_contract: [">= 0.7.0", "< 0.8.0"],
    foundation_plan_formats: ["firstdraft.foundation-plan.sketch/0.23"],
  });
  const stale = [
    "The CLI/Skill `0.7.0` pair sent Plans.",
    "| CLI | 0.7.0 |",
    "npm `latest` selects `0.7.0`.",
    "Scripts written for the 0.7 line keep `--github`.",
    "CLI 0.8.0 has not been published.",
    "CLI 0.8.0 has not been\npublished.",
    "Before\npublishing CLI 0.8.0, align the companions.",
    "CLI 0.8.0 isn't published yet.",
    "The upcoming CLI 0.8.0 adds this flag.",
    "Install `0.8.0-rc.1` to try it.",
  ];
  const current = [
    "The current `0.8.x` source line contains the commands.",
    "CLI `0.8.x` requires the service's `0.7.x` API contract.",
    "Plan `0.23` has no `application.pwa` option.",
    "Development uses Node.js 24.18.0.",
  ];

  for (const line of stale) {
    assert.equal(
      staleVersionFindings("probe.md", line, identities).length,
      1,
      line,
    );
  }
  for (const line of current) {
    assert.deepEqual(
      staleVersionFindings("probe.md", line, identities),
      [],
      line,
    );
  }
});

test("changelog headings carry no release status", () => {
  const changelog = sources.get(path.join(repository, "CHANGELOG.md"));
  assert(changelog);
  assert.deepEqual(changelogStatusFindings(changelog), []);

  for (const heading of [
    "## 0.9.0 (unreleased)",
    "## 0.9.0: Released 2026-10-01",
    "## 0.9.0 release candidate",
    "## 0.9.0 (not yet published)",
  ]) {
    assert.equal(
      changelogStatusFindings(`${heading}\n\nAdds a flag.\n`).length,
      1,
      heading,
    );
  }
  for (const source of [
    "## 0.9.0\n\nAdds a flag.\n",
    "## 0.9.0: Local output\n\nAdds a flag.\n",
    "Whether a version is published shows in npm.\n",
    "```md\n## 0.9.0 (unreleased)\n```\n",
  ]) {
    assert.deepEqual(changelogStatusFindings(source), [], source);
  }
});

const identityLabels = {
  cli: "CLI ",
  api: "API ",
  plan: "Plan ",
  unlabeled: "",
};

const versionToken = /(?<![\w.])(v?)(\d+\.\d+(?:\.(?:\d+|x))?)\b(?!\.\d)/g;

const releaseStatus =
  /(?:\bnot|n't) (?:yet |been |yet been )?(?:published|released)\b|\b(?:candidates?|unreleased|unpublished|upcoming|pre-?releases?|pending|(?:published|released) yet|before publishing)\b/i;

const releasedOnly = "describe version changes in CHANGELOG.md.";

// A heading labeled "released" needs the same hand edit as one labeled "unreleased", so headings reject both.
const headingReleaseStatus = new RegExp(
  `${releaseStatus.source}|\\b(?:released|published)\\b`,
  "i",
);

// Labels such as "CLI/Skill `", "**CLI** ", "CLI versions ", "| CLI | ", "firstdraft ", "cli@", or "latest=".
const cliLabelBefore =
  /(?:\bCLI(?:\/Skill|'s)?(?:`|\*\*)?(?:\s+(?:versions?|releases?|line))?|\bfirstdraft|@firstdraft\.com\/cli`?|\b(?:latest|next)`?)\s*[:(=@|]?\s*(?:`|\*\*)?$/;

const comparatorSigns = new Map([
  ["=", [0]],
  ["<", [-1]],
  ["<=", [-1, 0]],
  [">", [1]],
  [">=", [0, 1]],
]);

/** @typedef {"cli" | "api" | "plan" | "unlabeled"} IdentityKind */
/** @typedef {{major: number, minor: number, patch: number | undefined}} Version */

/**
 * @param {string} packageVersion
 * @param {{api_contract: string[], foundation_plan_formats: string[]}} requires
 */
function versionIdentities(packageVersion, requires) {
  const cliVersion = parseVersion(packageVersion);
  const apiComparators = requires.api_contract.map(parseComparator);
  const planVersions = requires.foundation_plan_formats.map((format) =>
    parseVersion(format.replace(/^.*\//, "")),
  );
  const apiRange = requires.api_contract.join(" ");
  const planFormats = requires.foundation_plan_formats.join(", ");
  const withoutOldVersion = `state the current behavior without the old version, and ${releasedOnly}`;
  /** @param {Version} version */
  const acceptsCli = (version) =>
    sameLine(version, cliVersion) &&
    (version.patch === undefined || version.patch === cliVersion.patch);

  /** @type {Record<IdentityKind, (version: Version) => boolean>} */
  const accepts = {
    cli: acceptsCli,
    api: (version) =>
      apiComparators.every((comparator) => comparator.accepts(version)),
    plan: (version) =>
      version.patch === undefined &&
      planVersions.some((plan) => sameLine(version, plan)),
    // An unlabeled token is read as a CLI version. Otherwise a retired CLI line that the API range
    // still accepts, such as CLI 0.7.x beside API 0.7.x, would pass.
    unlabeled: acceptsCli,
  };
  /** @type {Record<IdentityKind, string>} */
  const staleAdvice = {
    cli: `but package.json is ${packageVersion}. Name that version or ${withoutOldVersion}`,
    api: `but release/compatibility.json accepts API ${apiRange}. Name an accepted version or state the behavior without one.`,
    plan: `but release/compatibility.json accepts ${planFormats}. Name an accepted format or state the behavior without one.`,
    unlabeled:
      `which has no API or Plan label, so it is checked as a CLI version against package.json's ` +
      `${packageVersion}. Add its API or Plan label if it names one; otherwise ${withoutOldVersion}`,
  };

  return {
    // Other majors, such as Node.js 24.18.0 or npm 11.16.0, are not First Draft identities.
    productMajors: new Set(
      [
        cliVersion,
        ...apiComparators.map(({ bound }) => bound),
        ...planVersions,
      ].map(({ major }) => major),
    ),
    accepts,
    staleAdvice,
  };
}

/**
 * @param {string} name
 * @param {string} source
 * @param {ReturnType<typeof versionIdentities>} identities
 * @returns {string[]}
 */
function staleVersionFindings(
  name,
  source,
  { productMajors, accepts, staleAdvice },
) {
  const findings = [];

  for (const match of source.matchAll(versionToken)) {
    const [token, tagPrefix, versionText] = match;
    assert(versionText !== undefined);
    const version = parseVersion(versionText);
    if (!productMajors.has(version.major)) continue;

    const end = match.index + token.length;
    const kind = identityKind(
      tagPrefix,
      source.slice(Math.max(0, match.index - 40), match.index),
      source.slice(end, end + 20),
    );
    const location = `${name}:${lineAt(source, match.index)}`;
    const prerelease =
      version.patch === undefined
        ? undefined
        : /^-[0-9A-Za-z][0-9A-Za-z.-]*\b/.exec(source.slice(end))?.[0];

    if (!accepts[kind](version)) {
      findings.push(
        `${location} names ${identityLabels[kind]}${token}, ${staleAdvice[kind]}`,
      );
    } else if (prerelease) {
      findings.push(
        `${location} names prerelease ${token}${prerelease}. Living pages name only released versions: ` +
          `remove the prerelease suffix and ${releasedOnly}`,
      );
    } else if (kind === "cli" || kind === "unlabeled") {
      const status = releaseStatus.exec(
        sentenceAround(source, match.index).replace(/\s+/g, " "),
      );
      if (status) {
        findings.push(
          `${location} calls the current package version ${token} "${status[0]}". Living pages treat ` +
            `package.json's version as released: remove the release-status wording and ${releasedOnly}`,
        );
      }
    }
  }

  return findings;
}

/**
 * @param {string | undefined} tagPrefix
 * @param {string} before
 * @param {string} after
 * @returns {IdentityKind}
 */
function identityKind(tagPrefix, before, after) {
  if (tagPrefix === "v" || cliLabelBefore.test(before)) return "cli";
  if (/\bAPI\s+(?:contract\s+|version\s+)?`?$/.test(before)) return "api";
  if (/(?:sketch\/|\bPlan\s+(?:format\s+|version\s+)?`?)$/.test(before)) {
    return "plan";
  }

  const labelAfter = /^(?:`|\*\*)?\s+(API|Plan|CLI)\b/.exec(after)?.[1];
  if (labelAfter === "API") return "api";
  if (labelAfter === "Plan") return "plan";
  return labelAfter === "CLI" ? "cli" : "unlabeled";
}

/** @param {string} value @returns {Version} */
function parseVersion(value) {
  const match = /^(\d+)\.(\d+)(?:\.(\d+|x))?$/.exec(value);
  assert(match, `expected a version, found ${value}`);

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch:
      match[3] === undefined || match[3] === "x" ? undefined : Number(match[3]),
  };
}

/** @param {string} requirement */
function parseComparator(requirement) {
  const match = /^(=|<|<=|>|>=)\s+(\S+)$/.exec(requirement);
  const signs = comparatorSigns.get(match?.[1] ?? "");
  assert(match?.[2] && signs, `invalid comparator: ${requirement}`);
  const bound = parseVersion(match[2]);

  return {
    bound,
    /** A line such as 0.7.x is compared as its first release. @param {Version} version */
    accepts(version) {
      const order =
        version.major - bound.major ||
        version.minor - bound.minor ||
        (version.patch ?? 0) - (bound.patch ?? 0);

      return signs.includes(Math.sign(order));
    },
  };
}

/** @param {string} source @returns {string[]} */
function changelogStatusFindings(source) {
  return withoutFencedCode(source)
    .split("\n")
    .filter((line) => /^ {0,3}##[ \t]/.test(line))
    .flatMap((line) => {
      const heading = line.trim();
      const status = headingReleaseStatus.exec(heading)?.[0];
      return status === undefined
        ? []
        : [
            `CHANGELOG.md heading "${heading}" says "${status}". The v<version> tag and npm show whether a ` +
              "version is published, so remove the label.",
          ];
    });
}

/** @param {Version} left @param {Version} right */
function sameLine(left, right) {
  return left.major === right.major && left.minor === right.minor;
}

/** @param {string} source @param {number} index */
function lineAt(source, index) {
  return source.slice(0, index).split("\n").length;
}

/** @param {string} source @param {number} index */
function sentenceAround(source, index) {
  let start = 0;
  let end = source.length;

  for (const boundary of source.matchAll(
    /[.!?](?=\s)|\n[ \t]*(?:\n|[-*+|#]|\d+\.\s)/g,
  )) {
    if (boundary.index < index) {
      start = boundary.index + boundary[0].length;
    } else {
      end = boundary.index;
      break;
    }
  }

  return source.slice(start, end);
}

const repositoryBlob = "https://github.com/firstdraft/cli/blob/main/";

/**
 * Resolves a relative link, or an absolute link to this repository's main branch, to a local file. Packaged
 * Markdown links unpackaged repository files by absolute URL, so both forms need checking.
 *
 * @param {string} sourceFile
 * @param {string} target
 * @returns {{file: string, fragment: string | undefined} | undefined}
 */
function repositoryLink(sourceFile, target) {
  const absolute = target.startsWith(repositoryBlob);
  if (!absolute && isExternalTarget(target)) return undefined;

  const [rawPath, fragment] = (
    absolute ? target.slice(repositoryBlob.length) : target
  ).split("#", 2);
  if (rawPath === undefined || rawPath === "") {
    return absolute ? undefined : { file: sourceFile, fragment };
  }

  const file = absolute
    ? path.join(repository, decodeURIComponent(rawPath))
    : path.resolve(path.dirname(sourceFile), decodeURIComponent(rawPath));
  return { file, fragment };
}

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
