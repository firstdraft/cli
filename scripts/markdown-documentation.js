import assert from "node:assert/strict";

/** @param {string} source @returns {string[]} */
export function markdownLinkTargets(source) {
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
export function isExternalTarget(target) {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//");
}

/** @param {string} source */
export function withoutFencedCode(source) {
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
