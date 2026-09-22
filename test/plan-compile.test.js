import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { run } from "../src/cli.js";
import {
  ARTIFACT_MEDIA_TYPE,
  FOUNDATION_PLAN_FORMAT,
} from "../src/compilation-artifact.js";
import { ROOT_TRANSACTION_NAME } from "../src/root-output.js";

const PROJECT_ID = "01900000-0000-7000-8000-000000002001";
const ANALYSIS_ID = "01900000-0000-7000-8000-000000002002";
const STALE_ANALYSIS_ID = "01900000-0000-7000-8000-000000002005";
const COMPILATION_ID = "01900000-0000-7000-8000-000000002003";
const PUBLICATION_ID = "01900000-0000-7000-8000-000000002004";
const API_TOKEN = `fd_${"a".repeat(43)}`;
const PLAN_SOURCE = Buffer.from(
  '{"format":"firstdraft.foundation-plan.sketch/0.20","application":{"key":"movie_catalog","name":"Movie Catalog"}}\n',
);
const HEAD_SHA256 = sha256(PLAN_SOURCE);
const ETAG = `"sha256:${HEAD_SHA256}"`;
const CREATED_AT = "2026-08-04T12:00:00.000Z";
const STARTED_AT = "2026-08-04T12:00:01.000Z";
const COMPLETED_AT = "2026-08-04T12:00:02.000Z";
const REPOSITORY_URL = "https://github.com/octocat/movie-catalog";
const ANALYZER_RELEASE =
  "foundation-plan-rails/application-2026-09-19-conventions";
const COMPILER_RELEASE =
  "foundation-plan-rails/compiler-application-2026-09-19-conventions";
const TARGET = { id: "rails", profile: "rails-sketch/2026-09" };
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
  const result = await invoke(["plan", "compile", "--github"], { cwd, apiUrl });

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

test("plan compile --output completes the HTTP journey without GitHub Publication", async (context) => {
  /** @type {{method: string | undefined, url: string | undefined, headers: import("node:http").IncomingHttpHeaders, body: Buffer}[]} */
  const requests = [];
  const artifact = directArtifactFixture();
  let compilationReads = 0;
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
    if (
      request.method === "POST" &&
      request.url === compilationCollectionPath()
    ) {
      respondJson(response, 202, directCompilationBody("queued"), {
        Location: directCompilationPath(),
      });
      return;
    }
    if (request.method === "GET" && request.url === directCompilationPath()) {
      compilationReads += 1;
      respondJson(
        response,
        200,
        compilationReads === 1
          ? directCompilationBody("running")
          : directCompilationBody("succeeded", artifact),
      );
      return;
    }
    if (request.method === "GET" && request.url === directArtifactPath()) {
      response.writeHead(200, {
        "Content-Type": ARTIFACT_MEDIA_TYPE,
        "Content-Length": artifact.source.byteLength,
        "Cache-Control": "no-store, no-transform",
        ETag: `"sha256:${artifact.sha256}"`,
      });
      response.end(artifact.source);
      return;
    }
    response.writeHead(404).end();
  });
  const apiUrl = await listen(context, server);
  const cwd = localDirectory(context, PLAN_SOURCE);
  const result = await invoke(
    ["plan", "compile", "--output", "./application"],
    {
      cwd,
      apiUrl,
      compilationSleep: async () => {},
    },
  );

  assert.equal(result.status, 0);
  assert.deepEqual(
    requests.map(({ method, url }) => [method, url]),
    [
      ["PUT", planPath()],
      ["GET", analysisPath()],
      ["POST", compilationCollectionPath()],
      ["GET", directCompilationPath()],
      ["GET", directCompilationPath()],
      ["GET", directArtifactPath()],
    ],
  );
  assert.equal(requests[2]?.body.byteLength, 0);
  assert.equal(requests[2]?.headers["if-match"], ETAG);
  assert(
    requests.every(
      ({ headers }) => headers.authorization === `Bearer ${API_TOKEN}`,
    ),
  );
  const printed = JSON.parse(result.stdout);
  assert.equal(printed.compilation.id, COMPILATION_ID);
  assert.equal(printed.compilation.status, "succeeded");
  assert.equal(printed.output.path, path.join(cwd, "application"));
  assert.equal(
    readFileSync(path.join(cwd, "application", "README.md"), "utf8"),
    "Movie Catalog\n",
  );
  assert.equal(
    result.stderr,
    `First Draft: Analyzing Foundation Plan...\nFirst Draft: Foundation Plan analysis valid.\nFirst Draft: Compiling application...\nFirst Draft: Application compiled.\n`,
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
  const result = await invoke(["plan", "compile", "--github"], {
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

test("plan compile --output starts a direct Compilation without Publication", async (context) => {
  const cwd = localDirectory(context, PLAN_SOURCE, {
    api_url: "https://api.example.test",
    foundation_plan_etag: ETAG,
  });
  const output = path.join(cwd, "application");
  /** @type {unknown[]} */
  const order = [];
  const directResult = {
    project: { id: PROJECT_ID, graph_version: 1 },
    compilation: { id: COMPILATION_ID, status: "succeeded" },
    output: {
      path: output,
      file_count: 264,
      manifest_sha256: "9".repeat(64),
    },
  };
  const result = await invoke(
    ["plan", "compile", "--output", "./application"],
    {
      cwd,
      planCompilePush: async () => {
        order.push("push");
        return successfulPush();
      },
      planCompileReadStatus: async () => {
        order.push("analysis");
        return { status: 200, body: analysisBody("valid") };
      },
      planCompilePublish: async () => {
        throw new Error("Publication must remain untouched");
      },
      planCompileDownload: async (
        /** @type {{expectedEtag: string, expected: Record<string, unknown>, output: string, onProgress: (progress: unknown) => void}} */ options,
      ) => {
        order.push("compilation");
        assert.equal(options.expectedEtag, ETAG);
        assert.deepEqual(options.expected, {
          projectId: PROJECT_ID,
          graphVersion: 1,
          headSourceSha256: HEAD_SHA256,
          analysisRunId: ANALYSIS_ID,
          compilerRelease: COMPILER_RELEASE,
          target: TARGET,
        });
        assert.equal(options.output, "./application");
        options.onProgress({ phase: "compilation", status: "waiting" });
        options.onProgress({ phase: "compilation", status: "succeeded" });
        return directResult;
      },
    },
  );

  assert.equal(result.status, 0);
  assert.deepEqual(order, ["push", "analysis", "compilation"]);
  assert.deepEqual(JSON.parse(result.stdout), directResult);
  assert.equal(
    result.stderr,
    `First Draft: Analyzing Foundation Plan...\nFirst Draft: Foundation Plan analysis valid.\nFirst Draft: Compiling application...\nFirst Draft: Application compiled.\n`,
  );
});

test("plan compile root output locks before push and releases after invalid analysis", async (context) => {
  if (process.platform === "win32") return context.skip();
  const cwd = localDirectory(context, PLAN_SOURCE);
  writeFileSync(path.join(cwd, "notes.md"), "design notes\n");
  let compilations = 0;
  const result = await invoke(["plan", "compile", "--output", "."], {
    cwd,
    planCompilePush: async () => {
      assert.equal(existsSync(path.join(cwd, ROOT_TRANSACTION_NAME)), true);
      return successfulPush();
    },
    planCompileReadStatus: async () => ({
      status: 200,
      body: analysisBody("invalid"),
    }),
    planCompileDownload: async () => {
      compilations += 1;
      throw new Error("Compilation must remain untouched");
    },
  });

  assertHandledFailure(result, "plan_not_valid");
  assert.equal(compilations, 0);
  assert.equal(existsSync(path.join(cwd, ROOT_TRANSACTION_NAME)), false);
  assert.equal(
    readFileSync(path.join(cwd, "notes.md"), "utf8"),
    "design notes\n",
  );
});

for (const outputArgs of [[], ["--output", "."]]) {
  test(`plan compile ${outputArgs.join(" ")} materializes root output without Publication`, async (context) => {
    if (process.platform === "win32") return context.skip();
    const cwd = localDirectory(context, PLAN_SOURCE, {
      api_url: "https://api.example.test",
      foundation_plan_etag: ETAG,
    });
    writeFileSync(path.join(cwd, "product-notes.md"), "Design notes\n");
    const artifact = directArtifactFixture(true);
    /** @type {{input: string | URL | Request, init: RequestInit}[]} */
    const calls = [];
    const result = await invoke(["plan", "compile", ...outputArgs], {
      cwd,
      planCompilePush: successfulPush,
      planCompileReadStatus: async () => ({
        status: 200,
        body: analysisBody("valid"),
      }),
      planCompilePublish: async () => {
        throw new Error("Publication must remain untouched");
      },
      fetchFunction: sequenceFetch(
        [
          jsonResponse(directCompilationBody("succeeded", artifact), 202, {
            Location: directCompilationPath(),
          }),
          new Response(artifact.source, {
            status: 200,
            headers: {
              "Content-Type": ARTIFACT_MEDIA_TYPE,
              "Content-Length": String(artifact.source.byteLength),
              "Cache-Control": "no-store, no-transform",
              ETag: `"sha256:${artifact.sha256}"`,
            },
          }),
        ],
        calls,
      ),
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      calls.map((call) => [call.init.method, String(call.input)]),
      [
        ["POST", `https://api.example.test${compilationCollectionPath()}`],
        ["GET", `https://api.example.test${directArtifactPath()}`],
      ],
    );
    assert.equal(
      readFileSync(path.join(cwd, "README.md"), "utf8"),
      "Movie Catalog\n",
    );
    assert.equal(
      readFileSync(
        path.join(cwd, ".firstdraft/design/product-notes.md"),
        "utf8",
      ),
      "Design notes\n",
    );
    assert.equal(
      readFileSync(
        path.join(cwd, ".firstdraft/design/.firstdraft/foundation-plan.json"),
        "utf8",
      ),
      PLAN_SOURCE.toString("utf8"),
    );
    assert.equal(existsSync(path.join(cwd, ROOT_TRANSACTION_NAME)), false);
    const output = JSON.parse(result.stdout).output;
    assert.equal(output.path, realpathSync(cwd));
    assert.equal(
      output.root_adoption.design_path,
      path.join(realpathSync(cwd), ".firstdraft/design"),
    );
    assert.equal(output.root_adoption.moved_entry_count, 2);
    assert.equal(
      readFileSync(
        path.join(cwd, ".firstdraft/submitted-foundation-plan.json"),
        "utf8",
      ),
      PLAN_SOURCE.toString("utf8"),
    );
    assert.equal(
      readFileSync(path.join(cwd, ".firstdraft/gaps.json"), "utf8"),
      '{"gaps":[]}\n',
    );
    assert.equal(existsSync(path.join(cwd, ".firstdraft/state.json")), false);
    assert.equal(existsSync(path.join(cwd, "design")), false);
  });
}

test("plan compile --output rejects an existing destination before Plan mutation", async (context) => {
  const cwd = localDirectory(context, PLAN_SOURCE);
  mkdirSync(path.join(cwd, "application"));
  let pushes = 0;
  const result = await invoke(
    ["plan", "compile", "--output", "./application"],
    {
      cwd,
      planCompilePush: async () => {
        pushes += 1;
        throw new Error("Plan push must remain untouched");
      },
    },
  );

  assertHandledFailure(result, "invalid_output_path", 2);
  assert.equal(pushes, 0);
});

test("plan compile rechecks an absent destination after analysis", async (context) => {
  /** @type {string | undefined} */
  let cwd;
  let compilationStarts = 0;
  const server = createServer(async (request, response) => {
    await readRequestBody(request);
    if (request.method === "PUT" && request.url === planPath()) {
      respondJson(response, 201, acceptedPlanBody(), { ETag: ETAG });
      return;
    }
    if (request.method === "GET" && request.url === analysisPath()) {
      assert(cwd);
      mkdirSync(path.join(cwd, "application"));
      respondJson(response, 200, analysisBody("valid"));
      return;
    }
    if (
      request.method === "POST" &&
      request.url === compilationCollectionPath()
    ) {
      compilationStarts += 1;
    }
    response.writeHead(500).end();
  });
  const apiUrl = await listen(context, server);
  cwd = localDirectory(context, PLAN_SOURCE);

  const result = await invoke(
    ["plan", "compile", "--output", "./application"],
    { cwd, apiUrl },
  );

  assertHandledFailure(result, "invalid_output_path", 2);
  assert.equal(errorEnvelope(result.stderr).reason, "destination_exists");
  assert.equal(compilationStarts, 0);
});

test("plan compile --output rechecks local Plan bytes before starting work", async (context) => {
  /** @type {string | undefined} */
  let cwd;
  let compilationStarts = 0;
  const server = createServer(async (request, response) => {
    await readRequestBody(request);
    if (request.method === "PUT" && request.url === planPath()) {
      respondJson(response, 201, acceptedPlanBody(), { ETag: ETAG });
      return;
    }
    if (request.method === "GET" && request.url === analysisPath()) {
      assert(cwd);
      writeFileSync(planFilePath(cwd), Buffer.from('{"changed":true}\n'));
      respondJson(response, 200, analysisBody("valid"));
      return;
    }
    if (
      request.method === "POST" &&
      request.url === compilationCollectionPath()
    ) {
      compilationStarts += 1;
    }
    response.writeHead(500).end();
  });
  const apiUrl = await listen(context, server);
  cwd = localDirectory(context, PLAN_SOURCE);
  const output = path.join(cwd, "application");
  const result = await invoke(
    ["plan", "compile", "--output", "./application"],
    { cwd, apiUrl },
  );

  assertHandledFailure(result, "local_plan_changed");
  assert.equal(compilationStarts, 0);
  assert.equal(existsSync(output), false);
});

test("plan compile --output never retries an ambiguous Compilation start", async (context) => {
  const cwd = localDirectory(context, PLAN_SOURCE, {
    api_url: "https://api.example.test",
    foundation_plan_etag: ETAG,
  });
  let requests = 0;
  const result = await invoke(
    ["plan", "compile", "--output", "./application"],
    {
      cwd,
      planCompilePush: successfulPush,
      planCompileReadStatus: async () => ({
        status: 200,
        body: analysisBody("valid"),
      }),
      fetchFunction: async () => {
        requests += 1;
        throw new Error("network failure");
      },
    },
  );

  assertHandledFailure(result, "request_outcome_unknown");
  assert.equal(errorEnvelope(result.stderr).phase, "compilation");
  assert.equal(requests, 1);
  assert.equal(existsSync(path.join(cwd, "application")), false);
});

test("direct Compilation start maps rejection and ambiguity without retrying", async (context) => {
  const cases = [
    {
      name: "validated 408 problem",
      response: problemResponse(408, "request_timeout", "Try later."),
      error: "request_outcome_unknown",
      status: 408,
      responseCode: "request_timeout",
    },
    {
      name: "validated 503 problem",
      response: problemResponse(503, "service_unavailable", "Try later."),
      error: "request_outcome_unknown",
      status: 503,
      responseCode: "service_unavailable",
    },
    {
      name: "unvalidated 503 body",
      response: jsonResponse({ secret: "start-response-canary" }, 503),
      error: "request_outcome_unknown",
      status: 503,
    },
    {
      name: "authentication rejection",
      response: problemResponse(
        401,
        "authentication_required",
        "Provide a token.",
      ),
      error: "authentication_required",
      status: 401,
      responseCode: "authentication_required",
    },
    {
      name: "validated client rejection",
      response: problemResponse(422, "compilation_rejected", "Fix the Plan."),
      error: "compilation_start_rejected",
      status: 422,
      responseCode: "compilation_rejected",
    },
  ];

  for (const example of cases) {
    const cwd = localDirectory(context, PLAN_SOURCE, {
      api_url: "https://api.example.test",
      foundation_plan_etag: ETAG,
    });
    /** @type {unknown[]} */
    const calls = [];
    const result = await invoke(
      ["plan", "compile", "--output", "./application"],
      {
        cwd,
        planCompilePush: successfulPush,
        planCompileReadStatus: async () => ({
          status: 200,
          body: analysisBody("valid"),
        }),
        fetchFunction: sequenceFetch([example.response], calls),
      },
    );

    const envelope = errorEnvelope(result.stderr);
    assert.equal(result.status, 1, example.name);
    assert.equal(result.stdout, "", example.name);
    assert.equal(
      envelope.error,
      example.error,
      `${example.name}: ${JSON.stringify(envelope)}`,
    );
    assert.equal(envelope.status, example.status, example.name);
    assert.equal(calls.length, 1, example.name);
    if (example.error === "request_outcome_unknown") {
      assert.equal(envelope.phase, "compilation", example.name);
    }
    if (example.responseCode === undefined) {
      assert.equal("response" in envelope, false, example.name);
    } else {
      assert.equal(envelope.response.code, example.responseCode, example.name);
    }
    assert.doesNotMatch(
      result.stderr,
      /start-response-canary|fd_[a-z]+/,
      example.name,
    );
    assert.equal(existsSync(path.join(cwd, "application")), false);
  }
});

test("post-start failures retain one recoverable Compilation identity", async (context) => {
  const artifact = directArtifactFixture();
  const queued = directCompilationBody("queued");
  const succeeded = directCompilationBody("succeeded", artifact);
  /** @type {{name: string, initial: ReturnType<typeof directCompilationBody>, response: (output: string) => Promise<Response>, error: string, command?: string, status: string}[]} */
  const cases = [
    {
      name: "status unavailable",
      initial: queued,
      response: async () =>
        problemResponse(503, "status_unavailable", "Try later."),
      error: "compilation_status_unavailable",
      command: "compilation status",
      status: "queued",
    },
    {
      name: "status invalid",
      initial: queued,
      response: async () => jsonResponse({ secret: "status-response-canary" }),
      error: "invalid_compilation_status",
      command: "current.compilation.id",
      status: "queued",
    },
    {
      name: "status authentication",
      initial: queued,
      response: async () =>
        problemResponse(401, "authentication_required", "Provide a token."),
      error: "authentication_required",
      status: "queued",
    },
    {
      name: "artifact unavailable",
      initial: succeeded,
      response: async () =>
        problemResponse(503, "artifact_unavailable", "Try later."),
      error: "artifact_unavailable",
      command: "compilation download",
      status: "succeeded",
    },
    {
      name: "artifact authentication",
      initial: succeeded,
      response: async () =>
        problemResponse(401, "authentication_required", "Provide a token."),
      error: "authentication_required",
      status: "succeeded",
    },
    {
      name: "artifact invalid",
      initial: succeeded,
      response: async () =>
        new Response(artifact.source, {
          status: 200,
          headers: {
            "Content-Type": ARTIFACT_MEDIA_TYPE,
            "Content-Length": String(artifact.source.byteLength),
            ETag: `"sha256:${artifact.sha256}"`,
          },
        }),
      error: "invalid_artifact",
      command: "current.compilation.id",
      status: "succeeded",
    },
    {
      name: "materialization failure",
      initial: succeeded,
      response: async (output) => {
        mkdirSync(output);
        return new Response(artifact.source, {
          status: 200,
          headers: {
            "Content-Type": ARTIFACT_MEDIA_TYPE,
            "Content-Length": String(artifact.source.byteLength),
            "Cache-Control": "no-store, no-transform",
            ETag: `"sha256:${artifact.sha256}"`,
          },
        });
      },
      error: "materialization_failed",
      command: "compilation download",
      status: "succeeded",
    },
  ];

  for (const example of cases) {
    const cwd = localDirectory(context, PLAN_SOURCE, {
      api_url: "https://api.example.test",
      foundation_plan_etag: ETAG,
    });
    const output = path.join(cwd, "application");
    /** @type {unknown[]} */
    const calls = [];
    const next = () => example.response(output);
    const result = await invoke(
      ["plan", "compile", "--output", "./application"],
      {
        cwd,
        planCompilePush: successfulPush,
        planCompileReadStatus: async () => ({
          status: 200,
          body: analysisBody("valid"),
        }),
        fetchFunction: sequenceFetch(
          [
            jsonResponse(example.initial, 202, {
              Location: directCompilationPath(),
            }),
            next,
          ],
          calls,
        ),
        compilationSleep: async () => {},
      },
    );

    const envelope = errorEnvelope(result.stderr);
    assert.equal(result.status, 1, example.name);
    assert.equal(result.stdout, "", example.name);
    assert.equal(
      envelope.error,
      example.error,
      `${example.name}: ${JSON.stringify(envelope)}`,
    );
    assert.equal(envelope.current.compilation.id, COMPILATION_ID, example.name);
    assert.equal(
      envelope.current.compilation.status,
      example.status,
      example.name,
    );
    assert.equal(calls.length, 2, example.name);
    if (example.command !== undefined) {
      assert.match(envelope.detail, new RegExp(example.command), example.name);
    }
    assert.doesNotMatch(
      result.stderr,
      /status-response-canary|fd_[a-z]+/,
      example.name,
    );
  }
});

test("direct Compilation timeout names read-only retained-ID recovery", async (context) => {
  const cwd = localDirectory(context, PLAN_SOURCE, {
    api_url: "https://api.example.test",
    foundation_plan_etag: ETAG,
  });
  const queued = directCompilationBody("queued");
  /** @type {unknown[]} */
  const calls = [];
  let now = 0;
  const result = await invoke(
    ["plan", "compile", "--output", "./application"],
    {
      cwd,
      planCompilePush: successfulPush,
      planCompileReadStatus: async () => ({
        status: 200,
        body: analysisBody("valid"),
      }),
      fetchFunction: sequenceFetch(
        [
          jsonResponse(queued, 202, {
            Location: directCompilationPath(),
          }),
        ],
        calls,
      ),
      compilationNow: () => now,
      compilationSleep: async () => {
        now = 600_000;
      },
    },
  );

  assertHandledFailure(result, "compilation_wait_timed_out");
  const envelope = errorEnvelope(result.stderr);
  assert.equal(envelope.current.compilation.id, COMPILATION_ID);
  assert.equal(envelope.current.compilation.status, "queued");
  assert.match(envelope.detail, /firstdraft compilation status/);
  assert.match(envelope.detail, /do not rerun 'firstdraft plan compile'/);
  assert.equal(calls.length, 1);
});

test("plan compile waits past a terminal analysis for the prior graph version", async (context) => {
  const cwd = localDirectory(context, PLAN_SOURCE, {
    api_url: "https://api.example.test",
    foundation_plan_etag: ETAG,
  });
  /** @type {unknown[]} */
  const calls = [];
  let publications = 0;
  const result = await invoke(["plan", "compile", "--github"], {
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

test("plan compile rejects an older Head at the accepted graph version", async (context) => {
  const cwd = localDirectory(context, PLAN_SOURCE, {
    api_url: "https://api.example.test",
    foundation_plan_etag: ETAG,
  });
  const olderHead = "0".repeat(64);
  let publications = 0;
  const result = await invoke(["plan", "compile", "--github"], {
    cwd,
    planCompilePush: successfulPush,
    fetchFunction: sequenceFetch([
      jsonResponse(analysisBody("valid", 1, ANALYSIS_ID, olderHead)),
    ]),
    planCompilePublish: async () => {
      publications += 1;
      return publicationBody();
    },
  });

  assertHandledFailure(result, "analysis_changed");
  assert.equal(
    errorEnvelope(result.stderr).current.analysis.head_source_sha256,
    olderHead,
  );
  assert.equal(publications, 0);
});

test("invalid JSON and schema diagnostics stop before analysis or Publication", async (context) => {
  for (const code of ["invalid_json", "schema_invalid"]) {
    const source = Buffer.from(
      code === "invalid_json" ? "{\n" : '{"format":"wrong"}\n',
    );
    const cwd = localDirectory(context, source);
    /** @type {unknown[]} */
    const calls = [];
    const result = await invoke(["plan", "compile", "--github"], {
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
    const result = await invoke(["plan", "compile", "--github"], {
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
    const result = await invoke(["plan", "compile", "--github"], options);
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
  const result = await invoke(["plan", "compile", "--github"], {
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
  const push = await invoke(["plan", "compile", "--github"], {
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
    const result = await invoke(["plan", "compile", "--github"], {
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

test("help and invalid direct-output syntax have no prerequisites", async () => {
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
  assert.match(
    help.stdout,
    /firstdraft plan compile --output <absent-directory\|\.>/,
  );

  for (const argv of [
    ["plan", "compile", "--output"],
    ["plan", "compile", "--output", "one", "--output", "two"],
    ["plan", "compile", "application"],
    ["plan", "compile", "--github", "--output", "."],
    ["plan", "compile", "--output", "app", "--github"],
  ]) {
    const invalid = await invoke(argv, {
      cwd: process.cwd(),
      apiToken: undefined,
      getCwd: inaccessible,
      fetchFunction: inaccessible,
    });
    assertHandledFailure(invalid, "invalid_arguments", 2);
  }
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
      format: "firstdraft.foundation-plan.sketch/0.20",
      source_sha256: HEAD_SHA256,
    },
    diagnostics: [],
  };
}

/** @param {string} status @param {number} [graphVersion] @param {string} [analysisId] @param {string} [headSourceSha256] */
function analysisBody(
  status,
  graphVersion = 1,
  analysisId = ANALYSIS_ID,
  headSourceSha256 = HEAD_SHA256,
) {
  const gapSet =
    status === "valid" ? emptyGapSet({ graphVersion, headSourceSha256 }) : null;
  return {
    project: { id: PROJECT_ID, graph_version: graphVersion },
    analysis: {
      id: analysisId,
      graph_version: graphVersion,
      head_source_sha256: headSourceSha256,
      analyzer_release: ANALYZER_RELEASE,
      compiler_release: COMPILER_RELEASE,
      target: TARGET,
      status,
      diagnostics:
        status === "issues_found"
          ? [structuredDiagnostic("reference_missing")]
          : status === "analysis_failed"
            ? [structuredDiagnostic("analysis_failed")]
            : [],
      gap_set: gapSet,
      gap_set_sha256:
        gapSet === null
          ? null
          : sha256(Buffer.from(`${JSON.stringify(gapSet, null, 2)}\n`)),
      started_at: STARTED_AT,
      completed_at: COMPLETED_AT,
    },
  };
}

/** @param {{graphVersion: number, headSourceSha256: string}} identity */
function emptyGapSet({ graphVersion, headSourceSha256 }) {
  return {
    format: "firstdraft.foundation-gaps/2",
    source: { sha256: headSourceSha256 },
    project: { id: PROJECT_ID, graph_version: graphVersion },
    analysis: { release: ANALYZER_RELEASE },
    compiler_release: COMPILER_RELEASE,
    target: TARGET,
    gaps: [],
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
      compiler_release: COMPILER_RELEASE,
      target: TARGET,
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

/** @param {string} status @param {ReturnType<typeof directArtifactFixture>} [artifact] */
function directCompilationBody(status, artifact) {
  const terminal = ["succeeded", "failed", "cancelled"].includes(status);
  return {
    project: { id: PROJECT_ID, graph_version: 1 },
    compilation: {
      id: COMPILATION_ID,
      analysis_run_id: ANALYSIS_ID,
      graph_version: 1,
      head_source_sha256: HEAD_SHA256,
      status,
      compiler_release: COMPILER_RELEASE,
      target: TARGET,
      status_path: directCompilationPath(),
      cancel_path: `${directCompilationPath()}/cancel`,
      artifact:
        status === "succeeded" && artifact
          ? {
              path: directArtifactPath(),
              sha256: artifact.sha256,
              media_type: ARTIFACT_MEDIA_TYPE,
              byte_size: artifact.source.byteLength,
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
      created_at: "2026-08-04T12:00:00.000000Z",
      started_at: status === "queued" ? null : "2026-08-04T12:00:01.000000Z",
      completed_at: terminal ? "2026-08-04T12:00:02.000000Z" : null,
    },
  };
}

/** @param {boolean} [withContext] */
function directArtifactFixture(withContext = false) {
  const contents = Buffer.from("Movie Catalog\n");
  const file = {
    path: "README.md",
    sha256: sha256(contents),
    mode: 0o644,
    owner: "renderer:readme",
    source_subject_uuids: [],
    contents_base64: contents.toString("base64"),
  };
  const files = [file];
  if (withContext) {
    for (const [filePath, source] of [
      [".firstdraft/gaps.json", Buffer.from('{"gaps":[]}\n')],
      [".firstdraft/submitted-foundation-plan.json", PLAN_SOURCE],
    ]) {
      const contents = /** @type {Buffer} */ (source);
      files.push({
        ...file,
        path: String(filePath),
        sha256: sha256(contents),
        contents_base64: contents.toString("base64"),
      });
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
  const metadata = {
    files: files.map(({ path, sha256, mode, owner, source_subject_uuids }) => ({
      path,
      sha256,
      mode,
      owner,
      source_subject_uuids,
    })),
  };
  const body = {
    format: "firstdraft.compilation-artifact/1",
    provenance: {
      compilation_id: COMPILATION_ID,
      project_id: PROJECT_ID,
      graph_version: 1,
      head_source_sha256: HEAD_SHA256,
      foundation_plan: {
        format: FOUNDATION_PLAN_FORMAT,
        sha256: HEAD_SHA256,
      },
      analysis: { id: ANALYSIS_ID, release: ANALYZER_RELEASE },
      compiler_release: COMPILER_RELEASE,
      target: TARGET,
      core: {
        repository: "firstdraft/foundation-rails-core",
        revision: "2".repeat(40),
        sha256: "3".repeat(64),
      },
    },
    manifest_sha256: sha256(Buffer.from(JSON.stringify(metadata))),
    files,
  };
  const source = Buffer.from(JSON.stringify(body));
  return { source, sha256: sha256(source) };
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

function compilationCollectionPath() {
  return `/v1/projects/${PROJECT_ID}/compilations`;
}

function directCompilationPath() {
  return `${compilationCollectionPath()}/${COMPILATION_ID}`;
}

function directArtifactPath() {
  return `${directCompilationPath()}/artifact`;
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
