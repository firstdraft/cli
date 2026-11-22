import { isUuidV7 } from "../plan-state.js";
import { PARENT_SEGMENT, plainWords } from "./report.js";

// A note carries only fields of a known shape, as a failure report does: the
// plain words of free text, and identifiers that fit their patterns. The
// Service refuses the same shapes.

export const NOTE_KINDS = Object.freeze([
  "unstated_request",
  "unclear_guidance",
  "wrong_output",
]);
/**
 * Each kind's fields, in the order a note carries them. A field the kind does
 * not list is no option of its command.
 */
export const NOTE_FIELDS = Object.freeze({
  unstated_request: Object.freeze(["request", "workaround"]),
  unclear_guidance: Object.freeze(["page", "code", "unclear", "workaround"]),
  wrong_output: Object.freeze([
    "source",
    "code",
    "compilation_id",
    "file",
    "expected",
    "actual",
    "workaround",
  ]),
});

const PLAIN_WORD_FIELDS = new Set([
  "request",
  "unclear",
  "expected",
  "actual",
  "workaround",
]);
const REQUIRED_PLAIN_WORDS = Object.freeze({
  unstated_request: ["request"],
  unclear_guidance: ["unclear"],
  wrong_output: ["expected", "actual"],
});
const MAX_PLAIN_WORDS = 300;
const MAX_PAGE = 200;
const MAX_CODE = 120;
const MAX_FILE = 300;
// SKILL.md, references/plan/policies.md, references/interview.md#scope
const SKILL_PAGE =
  /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.md(?:#[A-Za-z0-9_-]+)?$/;
// foundation_plan.identity.reserved_constant_collision, invalid_output_path
const CODE = /^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/;
// app/models/movie.rb, app/models/movie.rb:12
const APPLICATION_FILE = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*(?::\d{1,7})?$/;

export class NoteIncompleteError extends Error {
  /** @param {readonly string[]} missing what noteBody said the note needs */
  constructor(missing) {
    super("A field the note needs did not fit its shape.");
    this.missing = missing;
  }
}

/** @typedef {"unstated_request" | "unclear_guidance" | "wrong_output"} NoteKind */
/** @typedef {Partial<Record<string, string>>} NoteFields */

/**
 * Whether these fields, as given, can make a note of `kind`: each required
 * field is given, `wrong_output` names a source and only the fields that
 * source takes, and a Compilation is a lowercase UUIDv7. A note about
 * generated code may still lack its Compilation, which the command reads
 * from its record.
 *
 * @param {NoteKind} kind
 * @param {NoteFields} fields
 */
export function noteArgumentsValid(kind, fields) {
  const allowed = /** @type {readonly string[]} */ (NOTE_FIELDS[kind]);
  if (Object.keys(fields).some((field) => !allowed.includes(field))) {
    return false;
  }
  if (REQUIRED_PLAIN_WORDS[kind].some((field) => fields[field] === undefined)) {
    return false;
  }
  if (kind === "unclear_guidance") {
    return fields.page !== undefined || fields.code !== undefined;
  }
  if (kind === "wrong_output") {
    if (fields.source === "analysis") {
      return fields.compilation_id === undefined && fields.file === undefined;
    }
    return (
      fields.source === "generated_code" &&
      fields.code === undefined &&
      (fields.compilation_id === undefined || isUuidV7(fields.compilation_id))
    );
  }
  return true;
}

/**
 * Shapes the note that is printed and sent. Each field keeps only what fits
 * its shape; `omitted` says, for the preview, what was left out, and
 * `missing` says which left-out fields the note needs, so it cannot be sent.
 *
 * @param {NoteKind} kind
 * @param {NoteFields} fields valid for noteArgumentsValid
 */
export function noteBody(kind, fields) {
  /** @type {Record<string, string>} */
  const note = { kind };
  /** @type {[string, string][]} */
  const leftOut = [];
  for (const field of NOTE_FIELDS[kind]) {
    const value = fields[field];
    if (value === undefined) continue;

    const shaped = shapeField(field, value);
    if (shaped) {
      note[field] = shaped;
    } else {
      leftOut.push([field, `${field}, which ${SHAPE_REASONS[field]}`]);
    }
  }

  /** @type {Set<string>} */
  const needed = new Set(REQUIRED_PLAIN_WORDS[kind]);
  // Guidance that was unclear needs a page or a code to say which.
  if (
    kind === "unclear_guidance" &&
    note.page === undefined &&
    note.code === undefined
  ) {
    needed.add("page").add("code");
  }
  return {
    body: { note },
    omitted: leftOut
      .filter(([field]) => !needed.has(field))
      .map(([, reason]) => reason),
    missing: leftOut
      .filter(([field]) => needed.has(field))
      .map(([, reason]) => reason),
  };
}

const NO_PLAIN_WORDS = "has no plain words on its first line";
/** @type {Readonly<Record<string, string>>} */
const SHAPE_REASONS = {
  request: NO_PLAIN_WORDS,
  unclear: NO_PLAIN_WORDS,
  expected: NO_PLAIN_WORDS,
  actual: NO_PLAIN_WORDS,
  workaround: NO_PLAIN_WORDS,
  page: "is not SKILL.md or another path ending in .md",
  code: "is not a diagnostic code or CLI error value",
  file: "is not a relative path in the application",
};

/**
 * One field in its shape, or an empty string when nothing of it fits.
 *
 * @param {string} field
 * @param {string} value
 */
function shapeField(field, value) {
  if (PLAIN_WORD_FIELDS.has(field)) return plainWords(value, MAX_PLAIN_WORDS);
  if (field === "page") return skillPage(value) ?? "";
  if (field === "code") return diagnosticCode(value) ?? "";
  if (field === "file") return applicationFile(value) ?? "";
  // source and compilation_id were checked as arguments.
  return value;
}

/**
 * @param {string} value
 * @returns {string | undefined}
 */
export function skillPage(value) {
  return value.length <= MAX_PAGE &&
    SKILL_PAGE.test(value) &&
    !PARENT_SEGMENT.test(value.replace(/#.*$/, ""))
    ? value
    : undefined;
}

/**
 * @param {string} value
 * @returns {string | undefined}
 */
export function diagnosticCode(value) {
  return value.length <= MAX_CODE && CODE.test(value) ? value : undefined;
}

/**
 * @param {string} value
 * @returns {string | undefined}
 */
export function applicationFile(value) {
  return value.length <= MAX_FILE &&
    APPLICATION_FILE.test(value) &&
    !PARENT_SEGMENT.test(value)
    ? value
    : undefined;
}
