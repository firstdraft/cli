import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { run } from "../src/cli.js";

const PROJECT_ID = "01900000-0000-7000-8000-000000002001";
const ANALYSIS_ID = "01900000-0000-7000-8000-000000002002";
const STALE_ANALYSIS_ID = "01900000-0000-7000-8000-000000002005";
const COMPILATION_ID = "01900000-0000-7000-8000-000000002003";
const PUBLICATION_ID = "01900000-0000-7000-8000-000000002004";
const API_TOKEN = `fd_${"a".repeat(43)}`;
const PLAN_SOURCE = Buffer.from(
  '{"format":"firstdraft.foundation-plan.sketch/0.19","application":{"key":"movie_catalog","name":"Movie Catalog"}}\n',
);
const HEAD_SHA256 = sha256(PLAN_SOURCE);
const ETAG = `"sha256:${HEAD_SHA256}"`;
const CREATED_AT = "2026-08-04T12:00:00.000Z";
const STARTED_AT = "2026-08-04T12:00:01.000Z";
const COMPLETED_AT = "2026-08-04T12:00:02.000Z";
const REPOSITORY_URL = "https://github.com/octocat/movie-catalog";
const SUCCESS_PROGRESS = `First Draft: Analyzing Foundation Plan...
First Draft: Foundation Plan analysis valid.
First Draft: Compiling application...
First Draft: Application compiled.
First Draft: GitHub publication complete.
`;

test("plan compile submits exact bytes, waits for valid analysis, and publishes once", async (context) => {
  /** @type {{method: string | undefined, url: string | undefined, headers: import("node:http").IncomingHttpHeaders, body: Buffer}[]} */
  const requests = [];
  const server = createServer(async (request, response) => {
    const body = await readRequestBody(request);
    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body,
    });

    if (request.method === "PUT" && request.url === planPath()) {
      respondJson(response, 201, acceptedPlanBody(), { ETag: ETAG });
      return;
    }
    if (request.method === "GET" && request.url === analysisPath()) {
      respondJson(response, 200, analysisBody("valid"));
      return;
    }
    if (request.method === "PUT" && request.url === publicationPath()) {
      respondJson(response, 201, publicationBody());
      return;
    }
    response.writeHead(404).end();
  });
  const apiUrl = await listen(context, server);
  const cwd = localDirectory(context, PLAN_SOURCE);
  const result = await invoke(["plan", "compile"], { cwd, apiUrl });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, SUCCESS_PROGRESS);
  assert.deepEqual(result.stdoutWrites, [`${REPOSITORY_URL}\n`]);
  assert.deepEqual(
    requests.map(({ method, url }) => [method, url]),
    [
      ["PUT", planPath()],
      ["GET", analysisPath()],
      ["PUT", publicationPath()],
    ],
  );
  assert.deepEqual(requests[0]?.body, PLAN_SOURCE);
  assert.equal(requests[0]?.headers["if-none-match"], "*");
  assert.equal(requests[2]?.headers["if-match"], ETAG);
  assert(
    requests.every(
      ({ headers }) => headers.authorization === `Bearer ${API_TOKEN}`,
    ),
  );
});

test("plan compile may push unchanged bytes before analysis and Publication", async (context) => {
  const cwd = localDirectory(context, PLAN_SOURCE, {
    api_url: "https://api.example.test",
    foundation_plan_etag: ETAG,
  });
  /** @type {unknown[]} */
  const order = [];
  const expected = publicationBody();
  const result = await invoke(["plan", "compile"], {
    cwd,
    planCompilePush: async (/** @type {{cwd: string}} */ options) => {
      order.push(["push", options.cwd]);
      return {
        status: 200,
        etag: ETAG,
        outcome: "updated",
        body: acceptedPlanBody(),
      };
    },
    planCompileReadStatus: async (/** @type {{wait?: boolean}} */ options) => {
      order.push(["analysis", options.wait]);
      return { status: 200, body: analysisBody("valid") };
    },
    planCompilePublish: async (
      /** @type {{onProgress: (progress: unknown) => void}} */ options,
    ) => {
      order.push(["publication"]);
      options.onProgress({ phase: "compilation", status: "waiting" });
      options.onProgress({
        phase: "publication",
        compilationStatus: "succeeded",
        publicationPhase: "completed",
        retryAt: null,
        retryCount: 0,
        reasonCode: null,
      });
      return expected;
    },
  });

  assert.equal(result.status, 0);
  assert.deepEqual(order, [["push", cwd], ["analysis", true], ["publication"]]);
  assert.equal(result.stdout, `${REPOSITORY_URL}\n`);
  assert.equal(result.stderr, SUCCESS_PROGRESS);
});

test("plan compile waits past a terminal analysis for the prior graph version", async (context) => {
  const cwd = localDirectory(context, PLAN_SOURCE, {
    api_url: "https://api.example.test",
    foundation_plan_etag: ETAG,
  });
  /** @type {unknown[]} */
  const calls = [];
  let publications = 0;
  const result = await invoke(["plan", "compile"], {
    cwd,
    planCompilePush: async () => ({
      status: 200,
      etag: ETAG,
      outcome: "updated",
      body: acceptedPlanBody(2),
    }),
    fetchFunction: sequenceFetch(
      [
        jsonResponse(analysisBody("valid", 1, STALE_ANALYSIS_ID)),
        jsonResponse(analysisBody("valid", 2, ANALYSIS_ID)),
      ],
      calls,
    ),
    planCompileSleep: async () => {},
    planCompilePublish: async () => {
      publications += 1;
      return publicationBody();
    },
  });

  assert.equal(result.status, 0);
  assert.equal(calls.length, 2);
  assert.equal(publications, 1);
});

test("invalid JSON and schema diagnostics stop before analysis or Publication", async (context) => {
  for (const code of ["invalid_json", "schema_invalid"]) {
    const source = Buffer.from(
      code === "invalid_json" ? "{\n" : '{"format":"wrong"}\n',
    );
    const cwd = localDirectory(context, source);
    /** @type {unknown[]} */
    const calls = [];
    const result = await invoke(["plan", "compile"], {
      cwd,
      apiUrl: "https://api.example.test",
      fetchFunction: sequenceFetch(
        [
          jsonResponse(
            {
              source_sha256: sha256(source),
              diagnostics: [diagnostic(code, `Rejected ${code}.`)],
            },
            422,
          ),
        ],
        calls,
      ),
    });

    assertHandledFailure(result, "server_rejected");
    assert.equal(calls.length, 1);
    assert.equal(
      errorEnvelope(result.stderr).response.diagnostics[0].code,
      code,
    );
  }
});

test("semantic and failed analysis stop before Publication with structured status", async (context) => {
  for (const status of ["issues_found", "analysis_failed"]) {
    const cwd = localDirectory(context, PLAN_SOURCE, {
      api_url: "https://api.example.test",
      foundation_plan_etag: ETAG,
    });
    let publications = 0;
    const current = analysisBody(status);
    const result = await invoke(["plan", "compile"], {
      cwd,
      planCompilePush: successfulPush,
      planCompileReadStatus: async () => ({ status: 200, body: current }),
      planCompilePublish: async () => {
        publications += 1;
        return publicationBody();
      },
    });

    assertHandledFailure(result, "plan_not_valid");
    assert.deepEqual(errorEnvelope(result.stderr).current, current);
    assert.equal(publications, 0);
  }
});

test("recurring diagnostics remain repairable and never trigger Publication", async (context) => {
  const cwd = localDirectory(context, PLAN_SOURCE, {
    api_url: "https://api.example.test",
    foundation_plan_etag: ETAG,
  });
  let publications = 0;
  const current = analysisBody("issues_found");
  const options = {
    cwd,
    planCompilePush: successfulPush,
    planCompileReadStatus: async () => ({ status: 200, body: current }),
    planCompilePublish: async () => {
      publications += 1;
      return publicationBody();
    },
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await invoke(["plan", "compile"], options);
    assertHandledFailure(result, "plan_not_valid");
    assert.equal(
      errorEnvelope(result.stderr).current.analysis.diagnostics[0].code,
      "reference_missing",
    );
  }
  assert.equal(publications, 0);
});

test("the final local-byte check stops a stale analyzed Plan before Publication", async (context) => {
  const cwd = localDirectory(context, PLAN_SOURCE, {
    api_url: "https://api.example.test",
    foundation_plan_etag: ETAG,
  });
  let networkRequests = 0;
  const result = await invoke(["plan", "compile"], {
    cwd,
    planCompilePush: successfulPush,
    planCompileReadStatus: async () => {
      const replacement = Buffer.concat([PLAN_SOURCE, Buffer.from(" ")]);
      const replacementEtag = `"sha256:${sha256(replacement)}"`;
      writeFileSync(planFilePath(cwd), replacement);
      writeFileSync(
        stateFilePath(cwd),
        `${JSON.stringify(
          {
            format: "firstdraft.cli-state/1",
            project_id: PROJECT_ID,
            api_url: "https://api.example.test",
            foundation_plan_etag: replacementEtag,
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
      return { status: 200, body: analysisBody("valid") };
    },
    fetchFunction: async () => {
      networkRequests += 1;
      throw new Error("Publication must not start");
    },
  });

  assertHandledFailure(result, "local_plan_changed");
  assert.equal(networkRequests, 0);
});

test("push ambiguity, analysis failures, and rejected reads have distinct errors", async (context) => {
  const pushCwd = localDirectory(context, PLAN_SOURCE);
  const push = await invoke(["plan", "compile"], {
    cwd: pushCwd,
    apiUrl: "https://api.example.test",
    fetchFunction: async () => {
      throw new TypeError("canary network failure");
    },
  });
  assertHandledFailure(push, "request_outcome_unknown");
  assert.equal(errorEnvelope(push.stderr).phase, "push");
  assert.doesNotMatch(push.stderr, /canary/);

  /** @type {[Response | (() => Promise<Response>), string][]} */
  const analysisFailures = [
    [
      async () => {
        throw new TypeError("analysis network failure");
      },
      "analysis_status_unavailable",
    ],
    [
      new Response('{"canary":"invalid"}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      "invalid_analysis_status",
    ],
    [
      problemResponse(503, "analysis_unavailable", "Try later."),
      "analysis_status_rejected",
    ],
  ];
  for (const [response, error] of analysisFailures) {
    const cwd = localDirectory(context, PLAN_SOURCE);
    const result = await invoke(["plan", "compile"], {
      cwd,
      apiUrl: "https://api.example.test",
      fetchFunction: sequenceFetch([
        jsonResponse(acceptedPlanBody(), 201, { ETag: ETAG }),
        response,
      ]),
    });
    assertHandledFailure(result, error);
    assert.doesNotMatch(result.stderr, /canary|network failure/);
  }
});

test("help and removed local-output syntax have no prerequisites", async () => {
  const inaccessible = () => {
    throw new Error("dependency must remain inaccessible");
  };
  const help = await invoke(["plan", "compile", "--help"], {
    cwd: process.cwd(),
    apiToken: undefined,
    getCwd: inaccessible,
    fetchFunction: inaccessible,
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /firstdraft plan compile/);

  const removed = await invoke(["plan", "compile", "--output", "generated"], {
    cwd: process.cwd(),
    apiToken: undefined,
    getCwd: inaccessible,
    fetchFunction: inaccessible,
  });
  assertHandledFailure(removed, "invalid_arguments", 2);
});

async function successfulPush() {
  return {
    status: 200,
    etag: ETAG,
    outcome: "updated",
    body: acceptedPlanBody(),
  };
}

/** @param {number} [graphVersion] */
function acceptedPlanBody(graphVersion = 1) {
  return {
    project: { id: PROJECT_ID, graph_version: graphVersion },
    foundation_plan: {
      format: "firstdraft.foundation-plan.sketch/0.19",
      source_sha256: HEAD_SHA256,
    },
    diagnostics: [],
  };
}

/** @param {string} status @param {number} [graphVersion] @param {string} [analysisId] */
function analysisBody(status, graphVersion = 1, analysisId = ANALYSIS_ID) {
  return {
    project: { id: PROJECT_ID, graph_version: graphVersion },
    analysis: {
      id: analysisId,
      graph_version: graphVersion,
      analyzer_release: "foundation-plan-analyzer/2026-08",
      status,
      diagnostics:
        status === "issues_found"
          ? [structuredDiagnostic("reference_missing")]
          : status === "analysis_failed"
            ? [structuredDiagnostic("analysis_failed")]
            : [],
      started_at: STARTED_AT,
      completed_at: COMPLETED_AT,
    },
  };
}

function publicationBody() {
  return {
    project: {
      id: PROJECT_ID,
      graph_version: 1,
      head_source_sha256: HEAD_SHA256,
    },
    compilation: {
      id: COMPILATION_ID,
      analysis_run_id: ANALYSIS_ID,
      graph_version: 1,
      head_source_sha256: HEAD_SHA256,
      status: "succeeded",
      compiler_release: "foundation-plan-rails/compiler-2026-08",
      target: { id: "rails", profile: "rails-sketch/2026-08" },
      artifact: {
        sha256: "1".repeat(64),
        manifest_sha256: "2".repeat(64),
        file_count: 10,
      },
    },
    publication: {
      id: PUBLICATION_ID,
      status: "succeeded",
      repository: {
        id: 123,
        private: true,
        owner: { id: 456, login: "octocat", type: "User" },
        full_name: "octocat/movie-catalog",
        default_branch: "main",
        html_url: REPOSITORY_URL,
        tree_sha: "3".repeat(40),
        commit_sha: "4".repeat(40),
      },
      failure: null,
      progress: {
        phase: "completed",
        retry_at: null,
        retry_count: 0,
        reason_code: null,
      },
      created_at: CREATED_AT,
      started_at: STARTED_AT,
      completed_at: COMPLETED_AT,
    },
  };
}

/** @param {string} code @param {string} [message] */
function diagnostic(code, message = code) {
  return { code, severity: "error", message };
}

/** @param {string} code */
function structuredDiagnostic(code) {
  return {
    code,
    severity: "error",
    message: "Resolve the referenced subject.",
    location: { source_pointer: "/entities/0" },
    subject: null,
    related_locations: [],
    suggestions: [],
  };
}

function planPath() {
  return `/v1/projects/${PROJECT_ID}/foundation-plan`;
}

function analysisPath() {
  return `/v1/projects/${PROJECT_ID}/analysis`;
}

function publicationPath() {
  return `/v1/projects/${PROJECT_ID}/github-publication`;
}

/** @param {import("node:test").TestContext} context @param {Buffer} source @param {Record<string, unknown>} [extraState] */
function localDirectory(context, source, extraState = {}) {
  const cwd = mkdtempSync(path.join(tmpdir(), "firstdraft-plan-compile-"));
  context.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(path.join(cwd, ".firstdraft"));
  writeFileSync(
    path.join(cwd, ".firstdraft", "state.json"),
    `${JSON.stringify({ format: "firstdraft.cli-state/1", project_id: PROJECT_ID, ...extraState }, null, 2)}\n`,
    { mode: 0o600 },
  );
  writeFileSync(planFilePath(cwd), source);
  return cwd;
}

/** @param {string} cwd */
function planFilePath(cwd) {
  return path.join(cwd, ".firstdraft", "foundation-plan.json");
}

/** @param {string} cwd */
function stateFilePath(cwd) {
  return path.join(cwd, ".firstdraft", "state.json");
}

/** @param {readonly string[]} argv @param {Record<string, unknown>} [options] */
async function invoke(argv, options = {}) {
  /** @type {string[]} */
  const stdoutWrites = [];
  let stderr = "";
  const status = await run({
    argv,
    stdout: { write: (text) => stdoutWrites.push(text) },
    stderr: { write: (text) => (stderr += text) },
    apiToken: API_TOKEN,
    ...options,
  });
  return { status, stdout: stdoutWrites.join(""), stdoutWrites, stderr };
}

/** @param {{status: number, stdout: string, stderr: string}} result @param {string} error @param {number} [status] */
function assertHandledFailure(result, error, status = 1) {
  assert.equal(result.status, status);
  assert.equal(result.stdout, "");
  assert.equal(errorEnvelope(result.stderr).error, error);
}

/** @param {string} stderr */
function errorEnvelope(stderr) {
  const structured = stderr
    .split("\n")
    .filter((line) => !line.startsWith("First Draft: "))
    .join("\n");
  return JSON.parse(structured);
}

/** @param {(Response | (() => Promise<Response>))[]} responses @param {unknown[]} [calls] */
function sequenceFetch(responses, calls = []) {
  return async (
    /** @type {string | URL | Request} */ input,
    /** @type {RequestInit} */ init,
  ) => {
    calls.push({ input, init });
    const response = responses.shift();
    assert(response, "unexpected request");
    return typeof response === "function" ? response() : response;
  };
}

/** @param {unknown} body @param {number} [status] @param {Record<string, string>} [headers] */
function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** @param {number} status @param {string} code @param {string} detail */
function problemResponse(status, code, detail) {
  return new Response(
    JSON.stringify({
      type: "about:blank",
      title: "Service Unavailable",
      status,
      code,
      detail,
    }),
    { status, headers: { "Content-Type": "application/problem+json" } },
  );
}

/** @param {import("node:http").ServerResponse} response @param {number} status @param {unknown} body @param {Record<string, string>} [headers] */
function respondJson(response, status, body, headers = {}) {
  const source = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": source.byteLength,
    ...headers,
  });
  response.end(source);
}

/** @param {import("node:http").IncomingMessage} request */
async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** @param {import("node:test").TestContext} context @param {import("node:http").Server} server */
async function listen(context, server) {
  await new Promise((/** @type {(value?: void) => void} */ resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(
    () =>
      new Promise((/** @type {(value?: void) => void} */ resolve) => {
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  assert(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

/** @param {Buffer} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
