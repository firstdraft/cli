const fencePattern = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const sectionHeadingPattern = /^ {0,3}#{1,2}(?:[ \t]|$)/;
const entryHeadingPattern = /^ {0,3}##[ \t]+(.*)$/;

/**
 * Explains why CHANGELOG.md lacks a usable entry for version, or returns
 * undefined when it has exactly one. An entry is a `## <version>` heading
 * followed by text; the version may be followed by a space or colon and a
 * title, as in `## 1.4.0: Local output`.
 *
 * @param {string} source
 * @param {string} version
 * @returns {string | undefined}
 */
export function changelogProblem(source, version) {
  const entries = changelogEntries(source, version);

  if (entries.length === 0) {
    return (
      `CHANGELOG.md has no entry for ${version}. Add a "## ${version}" heading ` +
      "and the changes under it in the pull request that sets the version."
    );
  }
  if (entries.length > 1) {
    return `CHANGELOG.md has ${entries.length} entries for ${version}. Keep one.`;
  }
  if (entries[0]?.trim() === "") {
    return `CHANGELOG.md's ${version} entry has no text. Describe the changes under its heading.`;
  }
  return undefined;
}

/**
 * @param {string} source
 * @param {string} version
 * @returns {string[]} the body of each entry for version
 */
export function changelogEntries(source, version) {
  /** @type {string[][]} */
  const entries = [];
  /** @type {string[] | undefined} */
  let body;
  /** @type {string | undefined} */
  let fence;

  for (const line of source.split(/\r?\n/)) {
    const [, marker, rest = ""] = fencePattern.exec(line) ?? [];
    if (marker !== undefined && fence === undefined) {
      fence = marker;
    } else if (marker !== undefined && closes(marker, rest, fence)) {
      fence = undefined;
    } else if (fence === undefined && sectionHeadingPattern.test(line)) {
      const title = entryHeadingPattern.exec(line)?.[1];
      body =
        title !== undefined && namesVersion(title, version) ? [] : undefined;
      if (body) entries.push(body);
      continue;
    }

    body?.push(line);
  }

  return entries.map((lines) => lines.join("\n"));
}

/**
 * A fence closes on a bare run of its own character at least as long as the run that opened it.
 *
 * @param {string} marker
 * @param {string} rest
 * @param {string | undefined} fence
 */
function closes(marker, rest, fence) {
  return (
    fence !== undefined &&
    marker[0] === fence[0] &&
    marker.length >= fence.length &&
    rest.trim() === ""
  );
}

/** @param {string} title @param {string} version */
function namesVersion(title, version) {
  return (
    title.startsWith(version) &&
    /^(?:$|[\s:])/.test(title.slice(version.length))
  );
}
