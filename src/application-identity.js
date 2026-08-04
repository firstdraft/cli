import { createHash } from "node:crypto";

export const MAX_DERIVED_APPLICATION_KEY_BYTES = 63;

const DIGEST_HEX_LENGTH = 12;
const APPLICATION_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
const MARK_PATTERN = /\p{Mark}/u;
// NFKD does not decompose these Latin letters, so map them before ASCII filtering.
const LATIN_TRANSLITERATIONS = new Map([
  ["Æ", "ae"],
  ["æ", "ae"],
  ["Œ", "oe"],
  ["œ", "oe"],
  ["Ø", "o"],
  ["ø", "o"],
  ["Ł", "l"],
  ["ł", "l"],
  ["Đ", "d"],
  ["đ", "d"],
  ["Ð", "d"],
  ["ð", "d"],
  ["Þ", "th"],
  ["þ", "th"],
  ["ẞ", "ss"],
  ["ß", "ss"],
  ["ı", "i"],
]);

/** @param {string} name */
export function deriveApplicationKey(name) {
  if (!isValidApplicationName(name)) {
    throw new TypeError(
      "Application name must be valid nonblank Unicode text.",
    );
  }

  const normalizedName = name.normalize("NFKD");
  const readable = asciiWords(normalizedName);
  const candidate =
    readable.length === 0
      ? `app_${stableDigest(normalizedName)}`
      : /^[0-9]/.test(readable)
        ? `app_${readable}`
        : readable;

  if (Buffer.byteLength(candidate) <= MAX_DERIVED_APPLICATION_KEY_BYTES) {
    return candidate;
  }

  const suffix = `_${stableDigest(normalizedName)}`;
  const prefix = candidate
    .slice(0, MAX_DERIVED_APPLICATION_KEY_BYTES - suffix.length)
    .replace(/_+$/, "");

  return `${prefix}${suffix}`;
}

/** @param {string} applicationKey */
export function deriveApplicationName(applicationKey) {
  if (!isValidApplicationKey(applicationKey)) {
    throw new TypeError(
      "Application key must be a valid lower-snake identifier.",
    );
  }

  return applicationKey
    .split(/_+/)
    .filter((word) => word.length > 0)
    .map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`)
    .join(" ");
}

/** @param {unknown} value @returns {value is string} */
export function isValidApplicationKey(value) {
  return typeof value === "string" && APPLICATION_KEY_PATTERN.test(value);
}

/** @param {unknown} value @returns {value is string} */
export function isValidApplicationName(value) {
  if (typeof value !== "string") return false;

  let hasNonWhitespace = false;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint === 0 ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      (codePoint >= 0xfdd0 && codePoint <= 0xfdef) ||
      (codePoint & 0xfffe) === 0xfffe
    ) {
      return false;
    }

    if (!isUnicodeWhitespace(codePoint)) hasNonWhitespace = true;
  }

  return hasNonWhitespace;
}

/** @param {string} name */
function asciiWords(name) {
  let value = "";

  for (const character of name) {
    if (MARK_PATTERN.test(character)) continue;

    const expanded = LATIN_TRANSLITERATIONS.get(character) ?? character;
    for (const asciiCharacter of expanded) {
      const codePoint = asciiCharacter.codePointAt(0) ?? 0;
      if (codePoint >= 0x41 && codePoint <= 0x5a) {
        value += asciiCharacter.toLowerCase();
      } else if (
        (codePoint >= 0x61 && codePoint <= 0x7a) ||
        (codePoint >= 0x30 && codePoint <= 0x39)
      ) {
        value += asciiCharacter;
      } else {
        value += "_";
      }
    }
  }

  return value.replace(/_+/g, "_").replace(/^_+|_+$/g, "");
}

/** @param {string} value */
function stableDigest(value) {
  return createHash("sha256")
    .update(Buffer.from(value, "utf8"))
    .digest("hex")
    .slice(0, DIGEST_HEX_LENGTH);
}

/** @param {number} codePoint */
function isUnicodeWhitespace(codePoint) {
  return (
    (codePoint >= 0x0009 && codePoint <= 0x000d) ||
    codePoint === 0x0020 ||
    codePoint === 0x0085 ||
    codePoint === 0x00a0 ||
    codePoint === 0x1680 ||
    (codePoint >= 0x2000 && codePoint <= 0x200a) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    codePoint === 0x202f ||
    codePoint === 0x205f ||
    codePoint === 0x3000
  );
}
