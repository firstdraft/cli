import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  FAILURE_KINDS,
  failureReportBody,
  plainWords,
  rspecRun,
} from "../src/commands/report.js";

// A copy of the service's failure-report examples, kept unchanged so the two
// sides test the same strings. Refresh it whenever the service's copy changes.
const shapes = JSON.parse(
  readFileSync(
    new URL("fixtures/failure-report-shapes.json", import.meta.url),
    "utf8",
  ),
);
const CWD = path.resolve("/work/movie_catalog");

/**
 * Each field as the CLI shapes it on its own, or undefined when the CLI
 * leaves it out.
 *
 * @type {Record<string, (value: string) => string | undefined>}
 */
const SHAPERS = {
  rerun: (value) => rspecRun(value),
  error_class: (value) =>
    failureReportBody({ kind: "spec_failure", errorClass: value }, CWD).body
      .failure_report.error_class,
  frame: (value) =>
    failureReportBody({ kind: "spec_failure", frames: [value] }, CWD).body
      .failure_report.frames?.[0],
  message: (value) =>
    plainWords(value, shapes.fields.message.limit) || undefined,
  fix_summary: (value) =>
    plainWords(value, shapes.fields.fix_summary.limit) || undefined,
  version: (value) =>
    failureReportBody({ kind: "spec_failure", rubyVersion: value }, CWD).body
      .failure_report.versions?.ruby,
};

test("the examples name exactly the fields the CLI shapes", () => {
  assert.deepEqual(
    Object.keys(shapes.fields).sort(),
    Object.keys(SHAPERS).sort(),
  );
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
      const shaped = shape(example);
      if (shaped === undefined) continue;

      assert.ok(
        !refused.includes(shaped),
        `${field}: ${JSON.stringify(example)} became a refused value`,
      );
      // What the CLI sends is already in its final shape.
      assert.equal(
        shape(shaped),
        shaped,
        `${field}: ${JSON.stringify(example)} became ${JSON.stringify(shaped)}`,
      );
    }
  }
});

test("free text is cut to the limit the service refuses past", () => {
  for (const field of ["message", "fix_summary"]) {
    const { limit } = shapes.fields[field];
    const shaped = plainWords("word ".repeat(limit), limit);
    assert.ok(Array.from(shaped).length <= limit, field);
  }
});

test("accepted reports pass through unchanged, and refused ones do not leave as they are", () => {
  for (const report of shapes.reports.accepted) {
    assert.deepEqual(
      failureReportBody(asOptions(report), CWD).body.failure_report,
      report,
    );
  }

  for (const report of shapes.reports.refused) {
    // The CLI refuses a missing or unknown kind before it builds a report.
    if (!FAILURE_KINDS.includes(report.kind)) continue;

    const shaped = failureReportBody(asOptions(report), CWD).body
      .failure_report;
    assert.notDeepEqual(shaped, report, JSON.stringify(report));
    for (const [key, value] of Object.entries(shaped)) {
      if (key === "kind") continue;
      assert.notDeepEqual(value, report[key], `${key} left unchanged`);
    }
  }
});

/**
 * The CLI options that would produce a report, ignoring keys it has no
 * option for.
 *
 * @param {Record<string, any>} report
 */
function asOptions(report) {
  return {
    kind: report.kind,
    rerun: report.rerun,
    errorClass: report.error_class,
    message: report.message,
    frames: report.frames,
    fixSummary: report.fix_summary,
    rubyVersion: report.versions?.ruby,
    railsVersion: report.versions?.rails,
  };
}
