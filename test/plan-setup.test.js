import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { run } from "../src/cli.js";

const projectId = "01900000-0000-7000-8000-000000009501";
const revision = "01900000-0000-7000-8000-000000009502";
const digest = "7".repeat(64);
const origin = "https://firstdraft.example";
const integration = {
  source: "interview",
  provider: "Anthropic",
  title: "Set up the model provider",
  purpose: "Read the shelf labels",
  needed: "before_feature_test",
  timing: "Before testing this feature",
  destination: "Application environment",
  action: "Set the environment variable for the app.",
  environment_variable: "ANTHROPIC_API_KEY",
};

/** @param {import("node:test").TestContext} t */
function application(t) {
  const cwd = mkdtempSync(path.join(tmpdir(), "firstdraft-plan-setup-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(path.join(cwd, ".firstdraft"));
  writeFileSync(
    path.join(cwd, ".firstdraft/gaps.json"),
    JSON.stringify({
      format: "firstdraft.foundation-gaps/2",
      project: { id: projectId },
    }),
  );
  return cwd;
}

/** @param {string} cwd @param {string[]} flags @param {typeof globalThis.fetch} fetchFunction */
async function invoke(cwd, flags, fetchFunction) {
  let stdout = "";
  let stderr = "";
  const status = await run({
    cwd,
    argv: ["plan", "setup", ...flags],
    apiUrl: origin,
    apiToken: "test-token",
    env: {},
    fetchFunction,
    stdout: { write: (data) => (stdout += data) },
    stderr: { write: (data) => (stderr += data) },
  });
  return { stdout, stderr, status };
}

test("a fresh clone reads the exact workshop review and returns its browser link", async (t) => {
  const cwd = application(t);
  const result = await invoke(
    cwd,
    ["--revision", revision, "--workshop"],
    async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, origin);
      assert.equal(url.pathname, "/v1/projects/" + projectId + "/setup");
      assert.equal(url.searchParams.get("review"), revision);
      assert.equal(url.searchParams.get("context"), "workshop");
      assert.equal(init?.method, "GET");
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer test-token",
      );
      return Response.json({
        review: { id: revision, plan_sha256: digest },
        context: "workshop",
        analysis: "valid",
        steps: [integration],
      });
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.deepEqual(body.steps, [integration]);
  assert.deepEqual(body.review, { id: revision, plan_sha256: digest });
  assert.equal(body.analysis, "valid");
  assert.equal(
    body.project.url,
    origin +
      "/projects/" +
      projectId +
      "?document=setup&review=" +
      revision +
      "&context=workshop",
  );
});

test("a Plan-only Project links to its current head without a workshop or revision parameter", async (t) => {
  const result = await invoke(application(t), [], async (input) => {
    assert.equal(new URL(String(input)).search, "");
    return Response.json({
      review: { id: null, plan_sha256: digest },
      context: "general",
      analysis: "preliminary",
      steps: [],
    });
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).analysis, "preliminary");
  assert.equal(
    JSON.parse(result.stdout).project.url,
    origin + "/projects/" + projectId + "?document=setup",
  );
});

test("a mismatched review, unknown analysis state or unexpected field cannot reach the walkthrough", async (t) => {
  const cwd = application(t);
  for (const [id, analysis, steps] of [
    [projectId, "valid", [integration]],
    [revision, undefined, [integration]],
    [revision, "unknown", [integration]],
    [revision, "valid", [{ ...integration, value: "test-secret-unexpected" }]],
  ]) {
    const result = await invoke(cwd, ["--revision", revision], async () =>
      Response.json({
        review: { id, plan_sha256: digest },
        context: "general",
        analysis,
        steps,
      }),
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error, "invalid_server_response");
    assert.doesNotMatch(result.stderr, /test-secret-unexpected/);
  }
});

test("a missing review reports the service problem so the owner can recover that review", async (t) => {
  const problem = {
    title: "Not Found",
    status: 404,
    code: "setup_not_found",
    detail: "This Project has no Plan at the requested review.",
  };
  const result = await invoke(
    application(t),
    ["--revision", revision],
    async () =>
      Response.json(problem, {
        status: 404,
        headers: { "Content-Type": "application/problem+json" },
      }),
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.error, "plan_setup_unavailable");
  assert.equal(failure.response.code, "setup_not_found");
});

test("help and invalid flags work before opening a Project or sending a request", async (t) => {
  const cwd = application(t);
  const noRequest = () =>
    assert.fail("help and invalid invocations do not call the service");
  const help = await invoke(cwd, ["--help"], noRequest);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--workshop/);
  const invalid = await invoke(cwd, ["--revision", "not-a-review"], noRequest);
  assert.equal(invalid.status, 2);
  assert.equal(JSON.parse(invalid.stderr).error, "invalid_arguments");
});
