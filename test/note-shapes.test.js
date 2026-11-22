import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  NOTE_FIELDS,
  NOTE_KINDS,
  noteArgumentsValid,
  noteBody,
} from "../src/commands/note.js";

// Examples written from the notes contract's rules. The First Draft service
// keeps its own copy of the same cases; when the two are reconciled into one
// file, copy it here unchanged so both sides test the same strings.
const shapes = JSON.parse(
  readFileSync(new URL("fixtures/note-shapes.json", import.meta.url), "utf8"),
);
const COMPILATION_ID = "01900000-0000-7000-8000-000000000001";

/**
 * A field of a note the CLI would otherwise send, or undefined when the CLI
 * refuses or leaves it out.
 *
 * @param {import("../src/commands/note.js").NoteKind} kind
 * @param {Record<string, string>} fields
 * @param {string} field
 */
function shaped(kind, fields, field) {
  if (!noteArgumentsValid(kind, fields)) return undefined;
  return noteBody(kind, fields).body.note[field];
}

/** @type {Record<string, (value: string) => string | undefined>} */
const SHAPERS = {
  kind: (value) =>
    /** @type {readonly string[]} */ (NOTE_KINDS).includes(value)
      ? value
      : undefined,
  request: (value) => shaped("unstated_request", { request: value }, "request"),
  workaround: (value) =>
    shaped(
      "unstated_request",
      { request: "A weekly digest email", workaround: value },
      "workaround",
    ),
  unclear: (value) =>
    shaped("unclear_guidance", { page: "SKILL.md", unclear: value }, "unclear"),
  expected: (value) =>
    shaped(
      "wrong_output",
      { source: "analysis", expected: value, actual: "Refused" },
      "expected",
    ),
  actual: (value) =>
    shaped(
      "wrong_output",
      { source: "analysis", expected: "Valid", actual: value },
      "actual",
    ),
  page: (value) =>
    shaped(
      "unclear_guidance",
      { page: value, code: "invalid_output_path", unclear: "Unclear" },
      "page",
    ),
  code: (value) =>
    shaped(
      "unclear_guidance",
      { page: "SKILL.md", code: value, unclear: "Unclear" },
      "code",
    ),
  source: (value) =>
    shaped(
      "wrong_output",
      { source: value, expected: "Valid", actual: "Refused" },
      "source",
    ),
  compilation_id: (value) =>
    shaped(
      "wrong_output",
      {
        source: "generated_code",
        compilation_id: value,
        expected: "Valid",
        actual: "Refused",
      },
      "compilation_id",
    ),
  file: (value) =>
    shaped(
      "wrong_output",
      {
        source: "generated_code",
        compilation_id: COMPILATION_ID,
        file: value,
        expected: "Valid",
        actual: "Refused",
      },
      "file",
    ),
};

test("the examples name exactly the fields a note may carry", () => {
  const fields = new Set(["kind", ...Object.values(NOTE_FIELDS).flat()]);
  assert.deepEqual(Object.keys(shapes.fields).sort(), [...fields].sort());
  assert.deepEqual(Object.keys(SHAPERS).sort(), [...fields].sort());
});

test("every accepted example passes through the CLI's shaping unchanged", () => {
  for (const [field, { accepted }] of Object.entries(shapes.fields)) {
    const shape = /** @type {(value: string) => string | undefined} */ (
      SHAPERS[field]
    );
    for (const example of /** @type {string[]} */ (accepted)) {
      assert.equal(shape(example), example, `${field}: ${example}`);
    }
  }
});

test("the CLI turns every refused example into an accepted value or leaves it out", () => {
  for (const [field, { refused }] of Object.entries(shapes.fields)) {
    const shape = /** @type {(value: string) => string | undefined} */ (
      SHAPERS[field]
    );
    for (const example of /** @type {string[]} */ (refused)) {
      const result = shape(example);
      if (result === undefined || result === "") continue;

      assert.ok(
        !refused.includes(result),
        `${field}: ${JSON.stringify(example)} became a refused value`,
      );
      // What the CLI sends is already in its final shape.
      assert.equal(
        shape(result),
        result,
        `${field}: ${JSON.stringify(example)} became ${JSON.stringify(result)}`,
      );
    }
  }
});

test("each field's limit is the longest value the CLI sends", () => {
  for (const [
    field,
    filler,
    suffix,
  ] of /** @type {[string, string, string][]} */ ([
    ["page", "references/", ".md"],
    ["code", "foundation_plan.", ""],
    ["file", "app/models/", ".rb"],
  ])) {
    const { limit } = shapes.fields[field];
    const shape = /** @type {(value: string) => string | undefined} */ (
      SHAPERS[field]
    );
    const longest = `${filler}${"a".repeat(limit - filler.length - suffix.length)}${suffix}`;
    assert.equal(shape(longest), longest, field);
    const tooLong = `${filler}${"a".repeat(limit + 1 - filler.length - suffix.length)}${suffix}`;
    assert.equal(shape(tooLong), undefined, field);
  }

  for (const field of [
    "request",
    "workaround",
    "unclear",
    "expected",
    "actual",
  ]) {
    const { limit } = shapes.fields[field];
    const shape = /** @type {(value: string) => string | undefined} */ (
      SHAPERS[field]
    );
    const text = `words ${Array(59).fill("word").join(" ")}`;
    assert.equal(text.length, limit);
    assert.equal(shape(text), text, field);
    const cut = shape(`${text}s`);
    assert.ok(cut !== undefined && Array.from(cut).length <= limit, field);
  }
});

test("accepted notes pass through unchanged, and refused ones do not leave as they are", () => {
  for (const note of shapes.notes.accepted) {
    const { kind, ...fields } = note;
    assert.ok(noteArgumentsValid(kind, fields), JSON.stringify(note));
    assert.deepEqual(noteBody(kind, fields), {
      body: { note },
      omitted: [],
      missing: [],
    });
  }

  for (const note of shapes.notes.refused) {
    const { kind, ...fields } = note;
    // There is no command for a missing or unknown kind, and an option the
    // kind does not have, or a combination it does not take, is refused
    // before anything is read or sent.
    if (!NOTE_KINDS.includes(kind) || !noteArgumentsValid(kind, fields)) {
      continue;
    }
    // A note about generated code that names no Compilation takes the one
    // the CLI recorded; with none recorded, it sends nothing.
    if (fields.source === "generated_code" && !fields.compilation_id) continue;

    const result = noteBody(kind, fields);
    if (result.missing.length > 0) continue;

    assert.notDeepEqual(result.body.note, note, JSON.stringify(note));
    // What the CLI would send is already in its final shape.
    const sent = Object.fromEntries(
      Object.entries(result.body.note).filter(([key]) => key !== "kind"),
    );
    assert.deepEqual(noteBody(kind, sent), {
      body: result.body,
      omitted: [],
      missing: [],
    });
  }
});
