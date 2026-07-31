import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ARTIFACT_MEDIA_TYPE,
  FOUNDATION_PLAN_FORMAT,
} from "../src/compilation-artifact.js";
import { run } from "../src/cli.js";

const PROJECT_ID = "01900000-0000-7000-8000-000000000701";
const COMPILATION_ID = "01900000-0000-7000-8000-000000000703";
const OTHER_COMPILATION_ID = "01900000-0000-7000-8000-000000000704";
const ANALYSIS_ID = "01900000-0000-7000-8000-000000000705";
const SUBJECT_ID = "01900000-0000-7000-8000-000000000706";
const HEAD_SHA256 = "1".repeat(64);
const ETAG = `"sha256:${HEAD_SHA256}"`;
const CREATED_AT = "2026-07-30T12:00:00.000Z";
const STARTED_AT = "2026-07-30T12:00:01.000Z";
const COMPLETED_AT = "2026-07-30T12:00:02.000Z";
const STATUS_PATH = `/v1/projects/${PROJECT_ID}/compilations/${COMPILATION_ID}`;
const CANCEL_PATH = `${STATUS_PATH}/cancel`;
const ARTIFACT_PATH = `${STATUS_PATH}/artifact`;
const COMPILER_RELEASE = "foundation-plan-rails/compiler-scalar-2026-08";
const TARGET = { id: "rails", profile: "rails-sketch/2026-08" };
const PLAN_COMPILE_HELP = `First Draft CLI

Usage:
  firstdraft plan compile --output <absent-path>

Options:
      --output <absent-path>  Materialize the generated application here
  -h, --help                  Show help

The command starts one compilation of the exact Plan ETag pinned by the
last successful push, waits up to ten minutes, validates the complete
artifact, and atomically renames it into an absent output path.
`;

test("plan compile uses one pinned POST, sequential polling, and one artifact GET", async (context) => {
  /** @type {{method: string | undefined, url: string | undefined, headers: import("node:http").IncomingHttpHeaders, body: Buffer}[]} */
  const requests = [];
  const artifact = artifactFixture();
  let statusReads = 0;
  const server = createServer(async (request, response) => {
    const body = await readRequestBody(request);
    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body,
    });

    if (request.method === "POST" && request.url === compilationCollection()) {
      respondJson(response, 202, compilationBody("queued"), {
        Location: STATUS_PATH,
      });
      return;
    }
    if (request.method === "GET" && request.url === STATUS_PATH) {
      statusReads += 1;
      respondJson(
        response,
        200,
        statusReads === 1
          ? compilationBody("running")
          : compilationBody("succeeded", { artifact }),
      );
      return;
    }
    if (request.method === "GET" && request.url === ARTIFACT_PATH) {
      response.writeHead(200, {
        "Content-Type": ARTIFACT_MEDIA_TYPE,
        "Content-Length": artifact.source.byteLength,
        ETag: `"sha256:${artifact.sha256}"`,
      });
      response.end(artifact.source);
      return;
    }

    response.writeHead(404).end();
  });
  const apiUrl = await listen(context, server);
  const cwd = remoteDirectory(context, apiUrl);
  const output = path.join(cwd, "generated-app");
  /** @type {string[]} */
  const events = [];
  /** @type {number[]} */
  const timeouts = [];
  const result = await invoke(["plan", "compile", "--output", output], {
    cwd,
    apiUrl: "https://canary-secret.example",
    planCompileSleep: async (/** @type {number} */ delayMs) => {
      events.push(`sleep:${delayMs}`);
    },
    createRequestSignal: (/** @type {number} */ timeoutMs) => {
      timeouts.push(timeoutMs);
      return new AbortController().signal;
    },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const printed = JSON.parse(result.stdout);
  assert.equal(printed.project.id, PROJECT_ID);
  assert.equal(printed.compilation.id, COMPILATION_ID);
  assert.equal(printed.compilation.status, "succeeded");
  assert.deepEqual(printed.output, {
    path: output,
    file_count: 2,
    manifest_sha256: artifact.manifestSha256,
  });
  assert.deepEqual(events, ["sleep:1000", "sleep:1000"]);
  assert.deepEqual(timeouts, [30_000, 30_000, 30_000, 30_000]);
  assert.deepEqual(
    requests.map(({ method, url }) => [method, url]),
    [
      ["POST", compilationCollection()],
      ["GET", STATUS_PATH],
      ["GET", STATUS_PATH],
      ["GET", ARTIFACT_PATH],
    ],
  );

  const [start, firstStatus, secondStatus, artifactRequest] = requests;
  assert(start);
  assert.equal(start.body.byteLength, 0);
  assert.equal(start.headers["if-match"], ETAG);
  assert.equal(
    start.headers.accept,
    "application/json, application/problem+json",
  );
  assert.equal(start.headers["content-type"], undefined);
  for (const statusRequest of [firstStatus, secondStatus]) {
    assert(statusRequest);
    assert.equal(
      statusRequest.headers.accept,
      "application/json, application/problem+json",
    );
  }
  assert(artifactRequest);
  assert.equal(
    artifactRequest.headers.accept,
    `${ARTIFACT_MEDIA_TYPE}, application/problem+json`,
  );
  assert.equal(
    readFileSync(path.join(output, "app/models/movie.rb"), "utf8"),
    "class Movie < ApplicationRecord\nend\n",
  );
  assert.deepEqual(
    readFileSync(path.join(output, "bin/setup")),
    Buffer.from([0, 255]),
  );
  if (process.platform !== "win32") {
    assert.equal(
      lstatSync(path.join(output, "app/models/movie.rb")).mode & 0o777,
      0o644,
    );
    assert.equal(lstatSync(path.join(output, "bin/setup")).mode & 0o777, 0o755);
  }
  assert.doesNotMatch(result.stdout, /canary-secret|sha256:1111/);
});

test("plan compile help and invalid arguments do not touch local or network dependencies", async () => {
  const inaccessible = () => {
    throw new Error("the dependency must remain inaccessible");
  };

  for (const argv of [
    ["plan", "compile", "--help"],
    ["plan", "compile", "-h"],
    ["plan", "compile", "--output", "canary-secret", "--help"],
  ]) {
    assert.deepEqual(
      await invoke(argv, {
        cwd: process.cwd(),
        getCwd: inaccessible,
        fetchFunction: inaccessible,
        planPushFileSystem: inaccessibleFileSystem(),
      }),
      { status: 0, stdout: PLAN_COMPILE_HELP, stderr: "" },
    );
  }

  for (const argv of [
    ["plan", "compile"],
    ["plan", "compile", "--output"],
    ["plan", "compile", "--output", "one", "--output", "two"],
    ["plan", "compile", "canary-secret"],
    ["plan", "compile", "--canary-secret"],
  ]) {
    const result = await invoke(argv, {
      getCwd: () => process.cwd(),
      fetchFunction: inaccessible,
      planPushFileSystem: inaccessibleFileSystem(),
    });

    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.deepEqual(JSON.parse(result.stderr), {
      error: "invalid_arguments",
      detail:
        "Invalid arguments. Run 'firstdraft plan compile --help' for usage.",
    });
    assert.doesNotMatch(result.stderr, /canary-secret/);
  }
});

test("local prerequisites fail before a compilation can start", async (context) => {
  const inaccessible = inaccessibleFetch();
  const unpushed = localDirectory(context, {
    format: "firstdraft.cli-state/1",
    project_id: PROJECT_ID,
  });
  assertHandledFailure(
    await invoke(["plan", "compile", "--output", "generated"], {
      cwd: unpushed,
      fetchFunction: inaccessible,
    }),
    "project_not_pushed",
  );

  const opaque = localDirectory(context, {
    format: "firstdraft.cli-state/1",
    project_id: PROJECT_ID,
    api_url: "https://api.example.test",
    foundation_plan_etag: '"opaque"',
  });
  assertHandledFailure(
    await invoke(["plan", "compile", "--output", "generated"], {
      cwd: opaque,
      fetchFunction: inaccessible,
    }),
    "invalid_configuration",
    2,
  );

  const existing = remoteDirectory(context, "https://api.example.test");
  mkdirSync(path.join(existing, "generated"));
  assertHandledFailure(
    await invoke(["plan", "compile", "--output", "generated"], {
      cwd: existing,
      fetchFunction: inaccessible,
    }),
    "invalid_output_path",
    2,
  );

  const symlinkedParent = path.join(existing, "linked-parent");
  symlinkSync(existing, symlinkedParent);
  assertHandledFailure(
    await invoke(["plan", "compile", "--output", "linked-parent/generated"], {
      cwd: existing,
      fetchFunction: inaccessible,
    }),
    "invalid_output_path",
    2,
  );
});

test("a sent start request is never retried when its outcome is ambiguous", async (context) => {
  const cwd = remoteDirectory(context, "https://api.example.test");
  let requests = 0;
  const result = await invoke(["plan", "compile", "--output", "generated"], {
    cwd,
    fetchFunction: async () => {
      requests += 1;
      throw new TypeError("canary-secret-network");
    },
  });

  assert.equal(requests, 1);
  assertHandledFailure(result, "request_outcome_unknown");
  assert.doesNotMatch(result.stderr, /canary-secret|sha256:1111/);
});

test("a validated start rejection is safe and does not poll", async (context) => {
  const cwd = remoteDirectory(context, "https://api.example.test");
  const result = await invoke(["plan", "compile", "--output", "generated"], {
    cwd,
    fetchFunction: async () =>
      problemResponse(409, "project_not_valid", "Compile is unavailable."),
  });

  assert.deepEqual(JSON.parse(result.stderr), {
    error: "compilation_start_rejected",
    detail: "First Draft rejected the compilation start request.",
    status: 409,
    response: {
      type: "about:blank",
      title: "Conflict",
      status: 409,
      code: "project_not_valid",
      detail: "Compile is unavailable.",
    },
  });
  assert.equal(result.status, 1);
});

test("an unvalidated non-success start response remains ambiguous", async (context) => {
  const cwd = remoteDirectory(context, "https://api.example.test");
  /** @type {unknown[]} */
  const calls = [];
  const result = await invoke(["plan", "compile", "--output", "generated"], {
    cwd,
    fetchFunction: sequenceFetch(
      [
        new Response("<html>bad gateway</html>", {
          status: 502,
          headers: { "Content-Type": "text/html" },
        }),
      ],
      calls,
    ),
  });

  assert.equal(calls.length, 1);
  assertHandledFailure(result, "request_outcome_unknown");
  assert.equal(JSON.parse(result.stderr).status, 502);
  assert.doesNotMatch(result.stderr, /html|gateway/);
});

test("invalid accepted start responses remain ambiguous", async (context) => {
  const cwd = remoteDirectory(context, "https://api.example.test");
  for (const response of [
    jsonResponse(compilationBody("queued"), 200),
    jsonResponse(compilationBody("queued"), 202),
    jsonResponse(compilationBody("queued"), 202, {
      Location: "/wrong",
    }),
    new Response("{}", {
      status: 202,
      headers: { "Content-Type": "text/plain", Location: STATUS_PATH },
    }),
  ]) {
    const result = await invoke(["plan", "compile", "--output", "generated"], {
      cwd,
      fetchFunction: sequenceFetch([response]),
    });

    assertHandledFailure(result, "request_outcome_unknown");
  }
});

test("server-returned request paths stay inside the pinned compilation", async (context) => {
  const invalidStatusPaths = [
    `${STATUS_PATH}/../../../evil`,
    `${STATUS_PATH}/%2e%2e/evil`,
    "//evil.example/x",
    `${STATUS_PATH}?x=1`,
    `/v1/projects/${PROJECT_ID}/compilations/${OTHER_COMPILATION_ID}`,
  ];

  for (const [index, statusPath] of invalidStatusPaths.entries()) {
    const cwd = remoteDirectory(context, `https://api-${index}.example.test`);
    const result = await invoke(
      ["plan", "compile", "--output", `generated-status-${index}`],
      {
        cwd,
        fetchFunction: sequenceFetch([
          jsonResponse(
            compilationBody("queued", {
              compilation: { status_path: statusPath },
            }),
            202,
            { Location: statusPath },
          ),
        ]),
      },
    );

    assertHandledFailure(result, "request_outcome_unknown");
  }

  for (const [index, cancelPath] of [
    `${CANCEL_PATH}?x=1`,
    `/v1/projects/${PROJECT_ID}/compilations/${OTHER_COMPILATION_ID}/cancel`,
  ].entries()) {
    const cwd = remoteDirectory(
      context,
      `https://api-cancel-${index}.example.test`,
    );
    const result = await invoke(
      ["plan", "compile", "--output", `generated-cancel-${index}`],
      {
        cwd,
        fetchFunction: sequenceFetch([
          jsonResponse(
            compilationBody("queued", {
              compilation: { cancel_path: cancelPath },
            }),
            202,
            { Location: STATUS_PATH },
          ),
        ]),
      },
    );

    assertHandledFailure(result, "request_outcome_unknown");
  }

  const artifact = artifactFixture();
  const cwd = remoteDirectory(context, "https://api-artifact.example.test");
  /** @type {unknown[]} */
  const calls = [];
  const result = await invoke(["plan", "compile", "--output", "generated"], {
    cwd,
    fetchFunction: sequenceFetch(
      [
        jsonResponse(
          compilationBody("succeeded", {
            artifact,
            compilation: {
              artifact: {
                path: `/v1/projects/${PROJECT_ID}/compilations/${OTHER_COMPILATION_ID}/artifact`,
                sha256: artifact.sha256,
                media_type: ARTIFACT_MEDIA_TYPE,
                byte_size: artifact.source.byteLength,
              },
            },
          }),
          202,
          { Location: STATUS_PATH },
        ),
      ],
      calls,
    ),
  });

  assert.equal(calls.length, 1);
  assertHandledFailure(result, "request_outcome_unknown");
});

test("returned same-origin paths may use scoped action suffixes", async (context) => {
  const cwd = remoteDirectory(context, "https://api.example.test");
  const artifact = artifactFixture();
  const statusPath = `${STATUS_PATH}/status`;
  const artifactPath = `${STATUS_PATH}/downloads/artifact`;
  const body = compilationBody("succeeded", {
    artifact,
    compilation: {
      status_path: statusPath,
      cancel_path: `${STATUS_PATH}/actions/cancel`,
      artifact: {
        path: artifactPath,
        sha256: artifact.sha256,
        media_type: ARTIFACT_MEDIA_TYPE,
        byte_size: artifact.source.byteLength,
      },
    },
  });
  const output = path.join(cwd, "generated");
  const result = await invoke(["plan", "compile", "--output", output], {
    cwd,
    fetchFunction: sequenceFetch([
      jsonResponse(body, 202, { Location: statusPath }),
      new Response(artifact.source, {
        status: 200,
        headers: {
          "Content-Type": ARTIFACT_MEDIA_TYPE,
          "Content-Length": String(artifact.source.byteLength),
          ETag: `"sha256:${artifact.sha256}"`,
        },
      }),
    ]),
  });

  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).compilation.status_path, statusPath);
});

test("polling pins compilation identity and stops on its first failed read", async (context) => {
  const cwd = remoteDirectory(context, "https://api.example.test");
  const changed = compilationBody("running", {
    compilation: {
      id: OTHER_COMPILATION_ID,
      status_path: `/v1/projects/${PROJECT_ID}/compilations/${OTHER_COMPILATION_ID}`,
      cancel_path: `/v1/projects/${PROJECT_ID}/compilations/${OTHER_COMPILATION_ID}/cancel`,
    },
  });
  /** @type {unknown[]} */
  const calls = [];
  const result = await invoke(["plan", "compile", "--output", "generated"], {
    cwd,
    fetchFunction: sequenceFetch(
      [
        jsonResponse(compilationBody("queued"), 202, {
          Location: STATUS_PATH,
        }),
        jsonResponse(changed),
      ],
      calls,
    ),
    planCompileSleep: async () => undefined,
  });

  assert.equal(calls.length, 2);
  assertHandledFailure(result, "compilation_changed");
  assert.equal(
    JSON.parse(result.stderr).current.compilation.id,
    OTHER_COMPILATION_ID,
  );

  const unavailable = await invoke(
    ["plan", "compile", "--output", "another-generated"],
    {
      cwd,
      fetchFunction: sequenceFetch([
        jsonResponse(compilationBody("queued"), 202, {
          Location: STATUS_PATH,
        }),
        async () => {
          throw new TypeError("canary-secret-network");
        },
      ]),
      planCompileSleep: async () => undefined,
    },
  );
  assertHandledFailure(unavailable, "compilation_status_unavailable");
  assert.doesNotMatch(unavailable.stderr, /canary-secret/);
});

test("polling distinguishes a validated unavailable status from a protocol mismatch", async (context) => {
  const unavailableDirectory = remoteDirectory(
    context,
    "https://api.example.test",
  );
  const unavailable = await invoke(
    ["plan", "compile", "--output", "generated-unavailable"],
    {
      cwd: unavailableDirectory,
      fetchFunction: sequenceFetch([
        jsonResponse(compilationBody("queued"), 202, {
          Location: STATUS_PATH,
        }),
        problemResponse(503, "temporarily_unavailable", "Try later."),
      ]),
      planCompileSleep: async () => undefined,
    },
  );
  assertHandledFailure(unavailable, "compilation_status_unavailable");
  assert.equal(JSON.parse(unavailable.stderr).status, 503);

  const invalidDirectory = remoteDirectory(context, "https://api.example.test");
  const invalid = await invoke(
    ["plan", "compile", "--output", "generated-invalid"],
    {
      cwd: invalidDirectory,
      fetchFunction: sequenceFetch([
        jsonResponse(compilationBody("queued"), 202, {
          Location: STATUS_PATH,
        }),
        new Response('{"canary":"secret"}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ]),
      planCompileSleep: async () => undefined,
    },
  );
  assertHandledFailure(invalid, "invalid_compilation_status");
  assert.doesNotMatch(invalid.stderr, /canary|secret/);
});

test("polling enforces the bounded ten-minute deadline", async (context) => {
  const cwd = remoteDirectory(context, "https://api.example.test");
  let currentTime = 0;
  const result = await invoke(["plan", "compile", "--output", "generated"], {
    cwd,
    fetchFunction: sequenceFetch([
      jsonResponse(compilationBody("queued"), 202, {
        Location: STATUS_PATH,
      }),
    ]),
    planCompileNow: () => currentTime,
    planCompileSleep: async (/** @type {number} */ delayMs) => {
      assert.equal(delayMs, 1_000);
      currentTime = 600_000;
    },
  });

  assertHandledFailure(result, "compilation_wait_timed_out");
  assert.equal(JSON.parse(result.stderr).current.compilation.status, "queued");
});

test("failed and cancelled compilations are domain failures without artifact reads", async (context) => {
  for (const status of ["failed", "cancelled"]) {
    const cwd = remoteDirectory(context, "https://api.example.test");
    /** @type {unknown[]} */
    const calls = [];
    const body =
      status === "failed"
        ? compilationBody(status, {
            compilation: {
              failure: {
                phase: "render",
                code: "render_failed",
                message: "The renderer failed safely.",
              },
            },
          })
        : compilationBody(status);
    const result = await invoke(
      ["plan", "compile", "--output", `generated-${status}`],
      {
        cwd,
        fetchFunction: sequenceFetch(
          [jsonResponse(body, 202, { Location: STATUS_PATH })],
          calls,
        ),
      },
    );

    assert.equal(calls.length, 1);
    assertHandledFailure(result, `compilation_${status}`);
    assert.equal(JSON.parse(result.stderr).current.compilation.status, status);
  }
});

test("artifact transport metadata and exact bytes are verified before parsing", async (context) => {
  const validArtifact = artifactFixture();
  const cases = [
    new Response(validArtifact.source, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(validArtifact.source.byteLength),
        ETag: `"sha256:${validArtifact.sha256}"`,
      },
    }),
    new Response(validArtifact.source, {
      status: 200,
      headers: {
        "Content-Type": ARTIFACT_MEDIA_TYPE,
        "Content-Length": String(validArtifact.source.byteLength + 1),
        ETag: `"sha256:${validArtifact.sha256}"`,
      },
    }),
    new Response(validArtifact.source, {
      status: 200,
      headers: {
        "Content-Type": ARTIFACT_MEDIA_TYPE,
        "Content-Length": `0${validArtifact.source.byteLength}`,
        ETag: `"sha256:${validArtifact.sha256}"`,
      },
    }),
    new Response(validArtifact.source, {
      status: 200,
      headers: {
        "Content-Type": ARTIFACT_MEDIA_TYPE,
        "Content-Length": String(validArtifact.source.byteLength),
        ETag: `"sha256:${"0".repeat(64)}"`,
      },
    }),
  ];

  for (const [index, artifactResponse] of cases.entries()) {
    const cwd = remoteDirectory(context, "https://api.example.test");
    const result = await invoke(
      ["plan", "compile", "--output", `generated-${index}`],
      {
        cwd,
        fetchFunction: sequenceFetch([
          jsonResponse(
            compilationBody("succeeded", { artifact: validArtifact }),
            202,
            { Location: STATUS_PATH },
          ),
          artifactResponse,
        ]),
      },
    );

    assertHandledFailure(result, "invalid_artifact");
  }
});

test("an unavailable artifact is distinct from an invalid artifact", async (context) => {
  const artifact = artifactFixture();
  const cwd = remoteDirectory(context, "https://api.example.test");
  const result = await invoke(["plan", "compile", "--output", "generated"], {
    cwd,
    fetchFunction: sequenceFetch([
      jsonResponse(compilationBody("succeeded", { artifact }), 202, {
        Location: STATUS_PATH,
      }),
      problemResponse(503, "artifact_not_ready", "Try later."),
    ]),
  });

  assertHandledFailure(result, "artifact_unavailable");
  assert.equal(JSON.parse(result.stderr).status, 503);
});

test("a target created while compiling is preserved and never replaced", async (context) => {
  const artifact = artifactFixture();
  const cwd = remoteDirectory(context, "https://api.example.test");
  const output = path.join(cwd, "generated");
  const marker = path.join(output, "belongs-to-user");
  const result = await invoke(["plan", "compile", "--output", output], {
    cwd,
    fetchFunction: sequenceFetch([
      jsonResponse(compilationBody("queued"), 202, {
        Location: STATUS_PATH,
      }),
      jsonResponse(compilationBody("succeeded", { artifact })),
      new Response(artifact.source, {
        status: 200,
        headers: {
          "Content-Type": ARTIFACT_MEDIA_TYPE,
          "Content-Length": String(artifact.source.byteLength),
          ETag: `"sha256:${artifact.sha256}"`,
        },
      }),
    ]),
    planCompileSleep: async () => {
      mkdirSync(output);
      writeFileSync(marker, "preserve me");
    },
  });

  assertHandledFailure(result, "materialization_failed");
  assert.equal(readFileSync(marker, "utf8"), "preserve me");
  assert.deepEqual(
    readdirSync(cwd)
      .filter((name) => name.startsWith(".firstdraft-generated-"))
      .sort(),
    [],
  );
});

test("exact status shapes and lifecycle timestamps are required", async (context) => {
  const invalidBodies = [
    {
      ...compilationBody("queued"),
      canary: "canary-secret",
    },
    compilationBody("queued", {
      compilation: { started_at: STARTED_AT },
    }),
    compilationBody("running", {
      compilation: { completed_at: COMPLETED_AT },
    }),
    compilationBody("succeeded", {
      compilation: { artifact: null },
    }),
    compilationBody("failed", {
      compilation: { failure: null },
    }),
  ];

  for (const [index, body] of invalidBodies.entries()) {
    const cwd = remoteDirectory(context, "https://api.example.test");
    const result = await invoke(
      ["plan", "compile", "--output", `generated-${index}`],
      {
        cwd,
        fetchFunction: sequenceFetch([
          jsonResponse(body, 202, { Location: STATUS_PATH }),
        ]),
      },
    );

    assertHandledFailure(result, "request_outcome_unknown");
    assert.doesNotMatch(result.stderr, /canary-secret/);
  }
});

/** @param {string} status @param {{artifact?: ReturnType<typeof artifactFixture>, project?: Record<string, unknown>, compilation?: Record<string, unknown>}} [changes] */
function compilationBody(status, changes = {}) {
  const artifact = changes.artifact;
  const terminal = ["succeeded", "failed", "cancelled"].includes(status);
  const started = status === "queued" ? null : STARTED_AT;
  return {
    project: {
      id: PROJECT_ID,
      graph_version: 7,
      ...changes.project,
    },
    compilation: {
      id: COMPILATION_ID,
      analysis_run_id: ANALYSIS_ID,
      graph_version: 7,
      status,
      compiler_release: COMPILER_RELEASE,
      target: TARGET,
      status_path: STATUS_PATH,
      cancel_path: CANCEL_PATH,
      artifact:
        status === "succeeded" && artifact
          ? {
              path: ARTIFACT_PATH,
              sha256: artifact.sha256,
              media_type: ARTIFACT_MEDIA_TYPE,
              byte_size: artifact.source.byteLength,
            }
          : null,
      failure:
        status === "failed"
          ? {
              phase: "compile",
              code: "compilation_failed",
              message: "The compilation failed.",
            }
          : null,
      created_at: CREATED_AT,
      started_at: started,
      completed_at: terminal ? COMPLETED_AT : null,
      ...changes.compilation,
    },
  };
}

function artifactFixture() {
  const files = [
    artifactFile(
      "app/models/movie.rb",
      "class Movie < ApplicationRecord\nend\n",
      0o644,
      "renderer:model",
      [SUBJECT_ID],
    ),
    artifactFile(
      "bin/setup",
      Buffer.from([0, 255]),
      0o755,
      "core:foundation-rails-core",
      [],
    ),
  ];
  const metadata = files.map(
    ({ path: filePath, sha256, mode, owner, source_subject_uuids }) => ({
      path: filePath,
      sha256,
      mode,
      owner,
      source_subject_uuids,
    }),
  );
  const manifestSha256 = sha256(
    Buffer.from(JSON.stringify({ files: metadata })),
  );
  const body = {
    format: "firstdraft.compilation-artifact/1",
    provenance: {
      compilation_id: COMPILATION_ID,
      project_id: PROJECT_ID,
      graph_version: 7,
      head_source_sha256: HEAD_SHA256,
      foundation_plan: {
        format: FOUNDATION_PLAN_FORMAT,
        sha256: "2".repeat(64),
      },
      analysis: {
        id: ANALYSIS_ID,
        release: "foundation-plan-rails/scalar-2026-08",
      },
      compiler_release: COMPILER_RELEASE,
      target: TARGET,
      core: {
        repository: "firstdraft/foundation-rails-core",
        revision: "3".repeat(40),
        sha256: "4".repeat(64),
      },
    },
    manifest_sha256: manifestSha256,
    files,
  };
  const source = Buffer.from(JSON.stringify(body));
  return {
    body,
    files,
    source,
    sha256: sha256(source),
    manifestSha256,
  };
}

/** @param {string} filePath @param {string | Buffer} contents @param {number} mode @param {string} owner @param {string[]} subjectIds */
function artifactFile(filePath, contents, mode, owner, subjectIds) {
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  return {
    path: filePath,
    sha256: sha256(bytes),
    mode,
    owner,
    source_subject_uuids: subjectIds,
    contents_base64: bytes.toString("base64"),
  };
}

/** @param {Buffer} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compilationCollection() {
  return `/v1/projects/${PROJECT_ID}/compilations`;
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
      title: status === 409 ? "Conflict" : "Service Unavailable",
      status,
      code,
      detail,
    }),
    {
      status,
      headers: { "Content-Type": "application/problem+json" },
    },
  );
}

/**
 * @param {(Response | (() => Promise<Response>))[]} responses
 * @param {unknown[]} [calls]
 * @returns {typeof globalThis.fetch}
 */
function sequenceFetch(responses, calls = []) {
  return async (input, init) => {
    calls.push({ input, init });
    const response = responses.shift();
    assert(response, "unexpected request");
    return typeof response === "function" ? response() : response;
  };
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
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  context.after(
    () =>
      new Promise(
        (
          /** @type {(value?: void) => void} */ resolve,
          /** @type {(error: Error) => void} */ reject,
        ) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        },
      ),
  );
  const address = server.address();
  assert(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

/** @param {import("node:test").TestContext} context @param {string} apiUrl */
function remoteDirectory(context, apiUrl) {
  return localDirectory(context, {
    format: "firstdraft.cli-state/1",
    project_id: PROJECT_ID,
    api_url: apiUrl,
    foundation_plan_etag: ETAG,
  });
}

/** @param {import("node:test").TestContext} context @param {Record<string, unknown>} state */
function localDirectory(context, state) {
  const directory = mkdtempSync(path.join(tmpdir(), "firstdraft-compile-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, ".firstdraft"));
  writeFileSync(
    path.join(directory, ".firstdraft", "state.json"),
    `${JSON.stringify(state, null, 2)}\n`,
    { mode: 0o600 },
  );
  return directory;
}

/** @param {readonly string[]} argv @param {Record<string, unknown>} [options] */
async function invoke(argv, options = {}) {
  let stdout = "";
  let stderr = "";
  const status = await run({
    argv,
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
    ...options,
  });
  return { status, stdout, stderr };
}

/**
 * @param {{status: number, stdout: string, stderr: string}} result
 * @param {string} error
 * @param {number} [status]
 */
function assertHandledFailure(result, error, status = 1) {
  assert.equal(result.status, status);
  assert.equal(result.stdout, "");
  assert.equal(JSON.parse(result.stderr).error, error);
}

function inaccessibleFetch() {
  return async () => {
    throw new Error("network must remain inaccessible");
  };
}

function inaccessibleFileSystem() {
  return {
    lstatSync: () => {
      throw new Error("filesystem must remain inaccessible");
    },
    readFileSync: () => {
      throw new Error("filesystem must remain inaccessible");
    },
    renameSync: () => {
      throw new Error("filesystem must remain inaccessible");
    },
    writeFileSync: () => {
      throw new Error("filesystem must remain inaccessible");
    },
  };
}
