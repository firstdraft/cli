import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { run } from "../src/cli.js";
import {
  ARTIFACT_MEDIA_TYPE,
  FOUNDATION_PLAN_FORMAT,
} from "../src/compilation-artifact.js";

const PROJECT_ID = "01900000-0000-7000-8000-000000003001";
const COMPILATION_ID = "01900000-0000-7000-8000-000000003002";
const ANALYSIS_ID = "01900000-0000-7000-8000-000000003004";
const API_TOKEN = `fd_${"b".repeat(43)}`;
const RETAINED_HEAD = "1".repeat(64);
const CANONICAL_PLAN = "4".repeat(64);
const LOCAL_HEAD = "9".repeat(64);
const CREATED_AT = "2026-08-04T12:00:00.000000Z";
const STARTED_AT = "2026-08-04T12:00:01.000000Z";
const COMPLETED_AT = "2026-08-04T12:00:02.000000Z";
const COMPILER_RELEASE = "foundation-plan-rails/compiler-2026-08";
const TARGET = { id: "rails", profile: "rails-sketch/2026-08" };
const STATUS_PATH = `/v1/projects/${PROJECT_ID}/compilations/${COMPILATION_ID}`;
const ARTIFACT_PATH = `${STATUS_PATH}/artifact`;

test("compilation status makes one canonical GET and returns terminal failures successfully", async (context) => {
  for (const status of ["failed", "cancelled"]) {
    const cwd = remoteDirectory(context);
    /** @type {FetchCall[]} */
    const calls = [];
    const body = compilationBody(status);
    const result = await invoke(["compilation", "status", COMPILATION_ID], {
      cwd,
      fetchFunction: sequenceFetch([jsonResponse(body)], calls),
    });

    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), body);
    assert.equal(result.stderr, "");
    assert.equal(calls.length, 1);
    assert.equal(
      String(calls[0]?.input),
      `https://api.example.test${STATUS_PATH}`,
    );
    assert.equal(calls[0]?.init?.method, "GET");
    assert.equal(
      new Headers(calls[0]?.init?.headers).get("authorization"),
      `Bearer ${API_TOKEN}`,
    );
  }
});

test("compilation status wait pins provenance and follows valid transitions", async (context) => {
  const cwd = remoteDirectory(context);
  /** @type {FetchCall[]} */
  const calls = [];
  const queued = compilationBody("queued");
  const running = compilationBody("running");
  const succeeded = compilationBody("succeeded", {
    artifact: artifactFixture(),
  });
  /** @type {number[]} */
  const delays = [];
  const result = await invoke(
    ["compilation", "status", COMPILATION_ID, "--wait"],
    {
      cwd,
      fetchFunction: sequenceFetch(
        [jsonResponse(queued), jsonResponse(running), jsonResponse(succeeded)],
        calls,
      ),
      compilationSleep: async (/** @type {number} */ delay) => {
        delays.push(delay);
      },
    },
  );

  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), succeeded);
  assert.deepEqual(delays, [1_000, 1_000]);
  assert.equal(calls.length, 3);

  const changed = await invoke(
    ["compilation", "status", COMPILATION_ID, "--wait"],
    {
      cwd,
      fetchFunction: sequenceFetch([
        jsonResponse(queued),
        jsonResponse(
          compilationBody("running", {
            compilation: { head_source_sha256: "8".repeat(64) },
          }),
        ),
      ]),
      compilationSleep: async () => {},
    },
  );
  assertHandledFailure(changed, "compilation_changed");
});

test("compilation status has a bounded wait and validates exact response shapes", async (context) => {
  const cwd = remoteDirectory(context);
  let now = 0;
  const timeout = await invoke(
    ["compilation", "status", COMPILATION_ID, "--wait"],
    {
      cwd,
      fetchFunction: sequenceFetch([jsonResponse(compilationBody("queued"))]),
      compilationNow: () => now,
      compilationSleep: async () => {
        now = 600_000;
      },
    },
  );
  assertHandledFailure(timeout, "compilation_wait_timed_out");
  assert.equal(JSON.parse(timeout.stderr).current.compilation.status, "queued");

  for (const body of [
    { ...compilationBody("queued"), additive: true },
    compilationBody("queued", {
      compilation: { status_path: `${STATUS_PATH}/status` },
    }),
    compilationBody("queued", {
      compilation: { created_at: "2026-08-04T12:00:00.000Z" },
    }),
  ]) {
    const invalid = await invoke(["compilation", "status", COMPILATION_ID], {
      cwd,
      fetchFunction: sequenceFetch([jsonResponse(body)]),
    });
    assertHandledFailure(invalid, "invalid_compilation_status");
    assert.doesNotMatch(invalid.stderr, /additive|status_path|created_at/);
  }
});

test("compilation download distinguishes Head and Plan provenance without starting work", async (context) => {
  const cwd = remoteDirectory(context);
  const fixture = artifactFixture();
  const status = compilationBody("succeeded", { artifact: fixture });
  /** @type {FetchCall[]} */
  const calls = [];
  const output = path.join(cwd, "movie-catalog");
  const result = await invoke(
    ["compilation", "download", COMPILATION_ID, "--output", output],
    {
      cwd,
      fetchFunction: sequenceFetch(
        [jsonResponse(status), artifactResponse(fixture)],
        calls,
      ),
    },
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(
    calls.map(({ input, init }) => [init?.method, String(input)]),
    [
      ["GET", `https://api.example.test${STATUS_PATH}`],
      ["GET", `https://api.example.test${ARTIFACT_PATH}`],
    ],
  );
  assert.equal(
    readFileSync(path.join(output, "README.md"), "utf8"),
    "Movie Catalog\n",
  );
  const body = JSON.parse(result.stdout);
  assert.equal(body.compilation.head_source_sha256, RETAINED_HEAD);
  assert.equal(body.output.path, output);
  assert.equal(body.output.file_count, 1);
});

test("download requires succeeded status and validates historical Head provenance", async (context) => {
  const cwd = remoteDirectory(context);
  /** @type {FetchCall[]} */
  const queuedCalls = [];
  const queuedOutput = path.join(cwd, "queued-output");
  const queued = await invoke(
    ["compilation", "download", COMPILATION_ID, "--output", queuedOutput],
    {
      cwd,
      fetchFunction: sequenceFetch(
        [jsonResponse(compilationBody("queued"))],
        queuedCalls,
      ),
    },
  );
  assertHandledFailure(queued, "compilation_not_succeeded");
  assert.equal(queuedCalls.length, 1);
  assert.equal(existsSync(queuedOutput), false);

  const mismatched = artifactFixture({ headSourceSha256: LOCAL_HEAD });
  const mismatchOutput = path.join(cwd, "mismatch-output");
  const mismatch = await invoke(
    ["compilation", "download", COMPILATION_ID, "--output", mismatchOutput],
    {
      cwd,
      fetchFunction: sequenceFetch([
        jsonResponse(compilationBody("succeeded", { artifact: mismatched })),
        artifactResponse(mismatched),
      ]),
    },
  );
  assertHandledFailure(mismatch, "invalid_artifact");
  assert.equal(existsSync(mismatchOutput), false);

  const transport = artifactFixture();
  const transportOutput = path.join(cwd, "transport-output");
  const invalidTransport = await invoke(
    ["compilation", "download", COMPILATION_ID, "--output", transportOutput],
    {
      cwd,
      fetchFunction: sequenceFetch([
        jsonResponse(compilationBody("succeeded", { artifact: transport })),
        new Response(transport.source, {
          status: 200,
          headers: {
            "Content-Type": ARTIFACT_MEDIA_TYPE,
            "Content-Length": String(transport.source.byteLength),
            ETag: `"sha256:${transport.sha256}"`,
          },
        }),
      ]),
    },
  );
  assertHandledFailure(invalidTransport, "invalid_artifact");
  assert.equal(existsSync(transportOutput), false);
});

test("compilation syntax and output preflight fail before network access", async (context) => {
  const inaccessible = async () => {
    throw new Error("network must remain inaccessible");
  };
  for (const argv of [
    ["compilation", "status", "not-a-uuid"],
    ["compilation", "status", COMPILATION_ID, COMPILATION_ID],
    ["compilation", "download", COMPILATION_ID],
    [
      "compilation",
      "download",
      COMPILATION_ID,
      "--output",
      "one",
      "--output",
      "two",
    ],
  ]) {
    const result = await invoke(argv, {
      cwd: process.cwd(),
      fetchFunction: inaccessible,
    });
    assertHandledFailure(result, "invalid_arguments", 2);
  }

  const cwd = remoteDirectory(context);
  const existing = path.join(cwd, "existing");
  mkdirSync(existing);
  const invalidOutput = await invoke(
    ["compilation", "download", COMPILATION_ID, "--output", existing],
    { cwd, fetchFunction: inaccessible },
  );
  assertHandledFailure(invalidOutput, "invalid_output_path", 2);

  const help = await invoke(["compilation", "download", "--help"], {
    cwd: process.cwd(),
    apiToken: undefined,
    fetchFunction: inaccessible,
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /compilation download/);
});

test("status and artifact authentication problems are stable", async (context) => {
  const cwd = remoteDirectory(context);
  const missing = await invoke(["compilation", "status", COMPILATION_ID], {
    cwd,
    apiToken: undefined,
    fetchFunction: async () => {
      throw new Error("network must remain inaccessible");
    },
  });
  assertHandledFailure(missing, "authentication_required");

  const statusRejected = await invoke(
    ["compilation", "status", COMPILATION_ID],
    {
      cwd,
      fetchFunction: sequenceFetch([authenticationProblem()]),
    },
  );
  assertHandledFailure(statusRejected, "authentication_required");

  let now = 0;
  let reads = 0;
  const finalPollRejected = await invoke(
    ["compilation", "status", COMPILATION_ID, "--wait"],
    {
      cwd,
      compilationNow: () => now,
      compilationSleep: async () => {
        now = 599_999;
      },
      fetchFunction: async () => {
        reads += 1;
        if (reads === 1) return jsonResponse(compilationBody("queued"));
        now = 600_000;
        return authenticationProblem();
      },
    },
  );
  assertHandledFailure(finalPollRejected, "authentication_required");
  assert.equal(reads, 2);

  const fixture = artifactFixture();
  const artifactRejected = await invoke(
    [
      "compilation",
      "download",
      COMPILATION_ID,
      "--output",
      path.join(cwd, "auth-output"),
    ],
    {
      cwd,
      fetchFunction: sequenceFetch([
        jsonResponse(compilationBody("succeeded", { artifact: fixture })),
        authenticationProblem(),
      ]),
    },
  );
  assertHandledFailure(artifactRejected, "authentication_required");
});

/** @param {string} status @param {{artifact?: ReturnType<typeof artifactFixture>, compilation?: Record<string, unknown>}} [changes] */
function compilationBody(status, changes = {}) {
  const terminal = ["succeeded", "failed", "cancelled"].includes(status);
  const fixture = changes.artifact;
  return {
    project: { id: PROJECT_ID, graph_version: 7 },
    compilation: {
      id: COMPILATION_ID,
      analysis_run_id: ANALYSIS_ID,
      graph_version: 7,
      head_source_sha256: RETAINED_HEAD,
      status,
      compiler_release: COMPILER_RELEASE,
      target: TARGET,
      status_path: STATUS_PATH,
      cancel_path: `${STATUS_PATH}/cancel`,
      artifact:
        status === "succeeded" && fixture
          ? {
              path: ARTIFACT_PATH,
              sha256: fixture.sha256,
              media_type: ARTIFACT_MEDIA_TYPE,
              byte_size: fixture.source.byteLength,
            }
          : null,
      failure:
        status === "failed"
          ? {
              phase: "render",
              code: "render_failed",
              message: "Rendering failed.",
            }
          : null,
      created_at: CREATED_AT,
      started_at: status === "queued" ? null : STARTED_AT,
      completed_at: terminal ? COMPLETED_AT : null,
      ...changes.compilation,
    },
  };
}

/** @param {{headSourceSha256?: string}} [changes] */
function artifactFixture(changes = {}) {
  const contents = Buffer.from("Movie Catalog\n");
  const file = {
    path: "README.md",
    sha256: sha256(contents),
    mode: 0o644,
    owner: "renderer:readme",
    source_subject_uuids: [],
    contents_base64: contents.toString("base64"),
  };
  const metadata = {
    files: [
      {
        path: file.path,
        sha256: file.sha256,
        mode: file.mode,
        owner: file.owner,
        source_subject_uuids: file.source_subject_uuids,
      },
    ],
  };
  const body = {
    format: "firstdraft.compilation-artifact/1",
    provenance: {
      compilation_id: COMPILATION_ID,
      project_id: PROJECT_ID,
      graph_version: 7,
      head_source_sha256: changes.headSourceSha256 ?? RETAINED_HEAD,
      foundation_plan: {
        format: FOUNDATION_PLAN_FORMAT,
        sha256: CANONICAL_PLAN,
      },
      analysis: {
        id: ANALYSIS_ID,
        release: "foundation-plan-rails/analysis-2026-08",
      },
      compiler_release: COMPILER_RELEASE,
      target: TARGET,
      core: {
        repository: "firstdraft/foundation-rails-core",
        revision: "2".repeat(40),
        sha256: "3".repeat(64),
      },
    },
    manifest_sha256: sha256(Buffer.from(JSON.stringify(metadata))),
    files: [file],
  };
  const source = Buffer.from(JSON.stringify(body));
  return { source, sha256: sha256(source) };
}

/** @param {ReturnType<typeof artifactFixture>} fixture */
function artifactResponse(fixture) {
  return new Response(fixture.source, {
    status: 200,
    headers: {
      "Content-Type": ARTIFACT_MEDIA_TYPE,
      "Content-Length": String(fixture.source.byteLength),
      "Cache-Control": "no-store, no-transform",
      ETag: `"sha256:${fixture.sha256}"`,
    },
  });
}

function authenticationProblem() {
  return new Response(
    JSON.stringify({
      type: "about:blank",
      title: "Unauthorized",
      status: 401,
      code: "authentication_required",
      detail: "Provide a token.",
    }),
    { status: 401, headers: { "Content-Type": "application/problem+json" } },
  );
}

/** @param {import("node:test").TestContext} context */
function remoteDirectory(context) {
  const cwd = mkdtempSync(path.join(tmpdir(), "firstdraft-compilation-"));
  context.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(path.join(cwd, ".firstdraft"));
  writeFileSync(
    path.join(cwd, ".firstdraft", "state.json"),
    `${JSON.stringify(
      {
        format: "firstdraft.cli-state/1",
        project_id: PROJECT_ID,
        api_url: "https://api.example.test",
        foundation_plan_etag: `"sha256:${LOCAL_HEAD}"`,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return cwd;
}

/** @param {readonly string[]} argv @param {Record<string, unknown>} [options] */
async function invoke(argv, options = {}) {
  let stdout = "";
  let stderr = "";
  const status = await run({
    argv,
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
    apiToken: API_TOKEN,
    ...options,
  });
  return { status, stdout, stderr };
}

/** @param {{status: number, stdout: string, stderr: string}} result @param {string} error @param {number} [status] */
function assertHandledFailure(result, error, status = 1) {
  assert.equal(result.status, status);
  assert.equal(result.stdout, "");
  assert.equal(JSON.parse(result.stderr).error, error);
}

/** @typedef {{input: string | URL | Request, init: RequestInit | undefined}} FetchCall */

/** @param {Response[]} responses @param {FetchCall[]} [calls] */
function sequenceFetch(responses, calls = []) {
  return async (
    /** @type {string | URL | Request} */ input,
    /** @type {RequestInit | undefined} */ init,
  ) => {
    calls.push({ input, init });
    const response = responses.shift();
    assert(response, "unexpected request");
    return response;
  };
}

/** @param {unknown} body */
function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** @param {Buffer} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
