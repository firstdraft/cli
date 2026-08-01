import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { run } from "../src/cli.js";

const PROJECT_ID = "01900000-0000-7000-8000-000000001001";
const COMPILATION_ID = "01900000-0000-7000-8000-000000001002";
const OTHER_COMPILATION_ID = "01900000-0000-7000-8000-000000001003";
const ANALYSIS_ID = "01900000-0000-7000-8000-000000001004";
const PUBLICATION_ID = "01900000-0000-7000-8000-000000001005";
const OTHER_PUBLICATION_ID = "01900000-0000-7000-8000-000000001006";
const PLAN_SOURCE = Buffer.from(
  '{"format":"firstdraft.foundation-plan.sketch/0.19"}\n',
);
const HEAD_SHA256 = sha256(PLAN_SOURCE);
const ETAG = `"sha256:${HEAD_SHA256}"`;
const API_TOKEN = `fd_${"a".repeat(43)}`;
const CREATED_AT = "2026-08-01T12:00:00.000Z";
const STARTED_AT = "2026-08-01T12:00:01.000Z";
const COMPLETED_AT = "2026-08-01T12:00:02.000Z";
const COMPILER_RELEASE = "foundation-plan-rails/compiler-2026-08";
const TARGET = { id: "rails", profile: "rails-sketch/2026-08" };
const ARTIFACT = {
  sha256: "1".repeat(64),
  manifest_sha256: "2".repeat(64),
  file_count: 197,
};
const TREE_SHA = "3".repeat(40);
const COMMIT_SHA = "4".repeat(40);
const REPOSITORY = {
  id: 1_234_567,
  private: true,
  owner: { id: 7_654_321, login: "octocat", type: "User" },
  full_name: "octocat/oscar-party",
  default_branch: "main",
  html_url: "https://github.com/octocat/oscar-party",
  tree_sha: TREE_SHA,
  commit_sha: COMMIT_SHA,
};
const PLAN_PUBLISH_HELP = `First Draft CLI

Usage:
  firstdraft plan publish

Options:
  -h, --help  Show help

Environment:
  FIRSTDRAFT_API_TOKEN  Authenticate API requests

The command conditionally creates or replays the Project's one Publication.
Each Project can publish one retained Plan Head in this release. The command
waits up to ten minutes and prints the private GitHub repository URL.
`;

test("plan publish sends one conditional singleton PUT and polls sequentially", async (context) => {
  /** @type {{method: string | undefined, url: string | undefined, headers: import("node:http").IncomingHttpHeaders, body: Buffer}[]} */
  const requests = [];
  let reads = 0;
  const server = createServer(async (request, response) => {
    const body = await readRequestBody(request);
    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body,
    });

    if (request.method === "PUT" && request.url === publicationPath()) {
      respondJson(response, 201, publicationBody("compiling"));
      return;
    }
    if (request.method === "GET" && request.url === publicationPath()) {
      reads += 1;
      respondJson(
        response,
        200,
        reads === 1
          ? publicationBody("compiling", {
              compilation: { status: "succeeded", artifact: ARTIFACT },
            })
          : reads === 2
            ? publicationBody("provisioning_repository")
            : reads === 3
              ? publicationBody("repository_unknown")
              : reads === 4
                ? publicationBody("publishing")
                : reads === 5
                  ? publicationBody("publication_unknown")
                  : publicationBody("succeeded"),
      );
      return;
    }

    response.writeHead(404).end();
  });
  const apiUrl = await listen(context, server);
  const cwd = remoteDirectory(context, apiUrl);
  /** @type {number[]} */
  const timeouts = [];
  /** @type {number[]} */
  const delays = [];
  const result = await invoke(["plan", "publish"], {
    cwd,
    apiUrl: "https://canary-secret.example",
    createRequestSignal: (/** @type {number} */ timeoutMs) => {
      timeouts.push(timeoutMs);
      return new AbortController().signal;
    },
    planPublishSleep: async (/** @type {number} */ delayMs) => {
      delays.push(delayMs);
    },
  });

  assert.deepEqual(result, {
    status: 0,
    stdout: `${REPOSITORY.html_url}\n`,
    stderr: "",
  });
  assert.deepEqual(delays, [1000, 1000, 1000, 1000, 1000, 1000]);
  assert.deepEqual(
    timeouts,
    [30_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000],
  );
  assert.deepEqual(
    requests.map(({ method, url }) => [method, url]),
    [
      ["PUT", publicationPath()],
      ["GET", publicationPath()],
      ["GET", publicationPath()],
      ["GET", publicationPath()],
      ["GET", publicationPath()],
      ["GET", publicationPath()],
      ["GET", publicationPath()],
    ],
  );
  const [start, ...polls] = requests;
  assert(start);
  assert.equal(start.body.byteLength, 0);
  assert.equal(start.headers["if-match"], ETAG);
  assert.equal(start.headers.authorization, `Bearer ${API_TOKEN}`);
  assert.equal(
    start.headers.accept,
    "application/json, application/problem+json",
  );
  assert.equal(start.headers["content-type"], undefined);
  assert.equal(start.headers["idempotency-key"], undefined);
  for (const poll of polls) {
    assert.equal(poll.headers.authorization, `Bearer ${API_TOKEN}`);
    assert.equal(
      poll.headers.accept,
      "application/json, application/problem+json",
    );
  }
  assert.doesNotMatch(result.stdout, /canary-secret|sha256/);
});

test("a repeated singleton PUT accepts provenance matching local Plan state", async (context) => {
  const cwd = remoteDirectory(context, "https://api.example.test");
  /** @type {FetchCall[]} */
  const calls = [];
  const result = await invoke(["plan", "publish"], {
    cwd,
    fetchFunction: sequenceFetch(
      [jsonResponse(publicationBody("succeeded"), 200)],
      calls,
    ),
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, `${REPOSITORY.html_url}\n`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.init?.method, "PUT");
  assert.equal(new Headers(calls[0]?.init?.headers).get("if-match"), ETAG);
});

test("an ambiguous PUT is reconciled by one safe singleton GET", async (context) => {
  const cwd = remoteDirectory(context, "https://api.example.test");
  /** @type {FetchCall[]} */
  const calls = [];
  const result = await invoke(["plan", "publish"], {
    cwd,
    fetchFunction: sequenceFetch(
      [
        async () => {
          throw new TypeError("canary-secret-network");
        },
        jsonResponse(publicationBody("succeeded")),
      ],
      calls,
    ),
  });

  assert.deepEqual(result, {
    status: 0,
    stdout: `${REPOSITORY.html_url}\n`,
    stderr: "",
  });
  assert.deepEqual(
    calls.map(({ init }) => init?.method),
    ["PUT", "GET"],
  );
  assert.doesNotMatch(result.stdout, /canary-secret/);
});

test("an ambiguous PUT does not adopt a singleton from a different Plan Head", async (context) => {
  const cwd = remoteDirectory(context, "https://api.example.test");
  const retainedHead = "a".repeat(64);
  /** @type {FetchCall[]} */
  const calls = [];
  const result = await invoke(["plan", "publish"], {
    cwd,
    fetchFunction: sequenceFetch(
      [
        async () => {
          throw new TypeError("ambiguous publication request");
        },
        jsonResponse(
          publicationBody("succeeded", {
            project: {
              graph_version: 7,
              head_source_sha256: retainedHead,
            },
            compilation: {
              graph_version: 7,
              head_source_sha256: retainedHead,
            },
          }),
        ),
      ],
      calls,
    ),
  });

  assertHandledFailure(result, "request_outcome_unknown");
  assert.equal(JSON.parse(result.stderr).status, 200);
  assert.match(
    JSON.parse(result.stderr).detail,
    /if this Project's Publication is retained for a different Plan Head, it cannot be repointed/,
  );
  assert.deepEqual(
    calls.map(({ init }) => init?.method),
    ["PUT", "GET"],
  );
});

test("an invalid successful PUT response can reconcile to the exact singleton", async (context) => {
  const cwd = remoteDirectory(context, "https://api.example.test");
  /** @type {FetchCall[]} */
  const calls = [];
  const result = await invoke(["plan", "publish"], {
    cwd,
    fetchFunction: sequenceFetch(
      [
        jsonResponse(
          { ...publicationBody("succeeded"), canary: "canary-secret" },
          201,
        ),
        jsonResponse(publicationBody("succeeded")),
      ],
      calls,
    ),
  });

  assert.deepEqual(result, {
    status: 0,
    stdout: `${REPOSITORY.html_url}\n`,
    stderr: "",
  });
  assert.deepEqual(
    calls.map(({ init }) => init?.method),
    ["PUT", "GET"],
  );
  assert.doesNotMatch(result.stdout, /canary-secret/);
});

test("an unresolved ambiguous PUT remains outcome unknown without replaying the mutation", async (context) => {
  const cwd = remoteDirectory(context, "https://api.example.test");
  /** @type {FetchCall[]} */
  const calls = [];
  const result = await invoke(["plan", "publish"], {
    cwd,
    fetchFunction: sequenceFetch(
      [
        async () => {
          throw new TypeError("canary-secret-network");
        },
        problemResponse(404, "publication_not_found", "Not found."),
      ],
      calls,
    ),
  });

  assertHandledFailure(result, "request_outcome_unknown");
  assert.equal(JSON.parse(result.stderr).status, 404);
  assert.equal(
    JSON.parse(result.stderr).response.code,
    "publication_not_found",
  );
  assert.deepEqual(
    calls.map(({ init }) => init?.method),
    ["PUT", "GET"],
  );
  assert.doesNotMatch(result.stderr, /canary-secret/);
});

test("help and invalid arguments have no local or network prerequisites", async () => {
  const inaccessible = () => {
    throw new Error("dependency must remain inaccessible");
  };

  for (const argv of [
    ["plan", "publish", "--help"],
    ["plan", "publish", "-h"],
    ["plan", "publish", "--help", "--help"],
  ]) {
    assert.deepEqual(
      await invoke(argv, {
        cwd: process.cwd(),
        getCwd: inaccessible,
        fetchFunction: inaccessible,
        planPushFileSystem: inaccessibleFileSystem(),
        apiToken: undefined,
      }),
      { status: 0, stdout: PLAN_PUBLISH_HELP, stderr: "" },
    );
  }

  for (const argv of [
    ["plan", "publish", "canary-secret"],
    ["plan", "publish", "--canary-secret"],
  ]) {
    const result = await invoke(argv, {
      fetchFunction: inaccessible,
      planPushFileSystem: inaccessibleFileSystem(),
    });
    assertHandledFailure(result, "invalid_arguments", 2);
    assert.doesNotMatch(result.stderr, /canary-secret/);
  }
});

test("local prerequisites reject before publication network access", async (context) => {
  const inaccessible = inaccessibleFetch();
  const unpushed = localDirectory(context, {
    format: "firstdraft.cli-state/1",
    project_id: PROJECT_ID,
  });
  assertHandledFailure(
    await invoke(["plan", "publish"], {
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
    await invoke(["plan", "publish"], {
      cwd: opaque,
      fetchFunction: inaccessible,
    }),
    "invalid_configuration",
    2,
  );

  const changed = remoteDirectory(context, "https://api.example.test");
  writeFileSync(
    planPath(changed),
    Buffer.concat([PLAN_SOURCE, Buffer.from(" ")]),
  );
  assertHandledFailure(
    await invoke(["plan", "publish"], {
      cwd: changed,
      fetchFunction: inaccessible,
    }),
    "local_plan_changed",
  );

  const missingPlan = remoteDirectory(context, "https://api.example.test");
  rmSync(planPath(missingPlan));
  assertHandledFailure(
    await invoke(["plan", "publish"], {
      cwd: missingPlan,
      fetchFunction: inaccessible,
    }),
    "local_input_unreadable",
  );
});

test("missing and rejected credentials use the stable authentication error", async (context) => {
  const cwd = remoteDirectory(context, "https://api.example.test");
  const missing = await invoke(["plan", "publish"], {
    cwd,
    apiToken: undefined,
    fetchFunction: inaccessibleFetch(),
  });
  assertHandledFailure(missing, "authentication_required");

  const rejected = await invoke(["plan", "publish"], {
    cwd,
    fetchFunction: sequenceFetch([
      problemResponse(
        401,
        "authentication_required",
        "An API token is required.",
      ),
    ]),
  });
  assertHandledFailure(rejected, "authentication_required");
  assert.equal(JSON.parse(rejected.stderr).status, 401);

  const reconciliation = await invoke(["plan", "publish"], {
    cwd,
    fetchFunction: sequenceFetch([
      async () => {
        throw new TypeError("ambiguous publication request");
      },
      problemResponse(
        401,
        "authentication_required",
        "An API token is required.",
      ),
    ]),
  });
  assertHandledFailure(reconciliation, "authentication_required");
  assert.equal(JSON.parse(reconciliation.stderr).status, 401);
});

test("validated start rejections are distinct from unknown mutation outcomes", async (context) => {
  const cwd = remoteDirectory(context, "https://api.example.test");
  const rejected = await invoke(["plan", "publish"], {
    cwd,
    fetchFunction: sequenceFetch([
      problemResponse(412, "precondition_failed", "The Plan changed."),
    ]),
  });

  assert.deepEqual(JSON.parse(rejected.stderr), {
    error: "publication_start_rejected",
    detail: "First Draft rejected the publication request.",
    status: 412,
    response: {
      type: "about:blank",
      title: "Precondition Failed",
      status: 412,
      code: "precondition_failed",
      detail: "The Plan changed.",
    },
  });

  const malformed = await invoke(["plan", "publish"], {
    cwd,
    fetchFunction: sequenceFetch([
      new Response("canary-secret", { status: 500 }),
      problemResponse(404, "publication_not_found", "Not found."),
    ]),
  });
  assertHandledFailure(malformed, "request_outcome_unknown");
  assert.doesNotMatch(malformed.stderr, /canary-secret/);
});

test("validated timeout and server errors reconcile without replaying the PUT", async (context) => {
  for (const status of [408, 503]) {
    const cwd = remoteDirectory(context, "https://api.example.test");
    /** @type {FetchCall[]} */
    const calls = [];
    const result = await invoke(["plan", "publish"], {
      cwd,
      fetchFunction: sequenceFetch(
        [
          problemResponse(status, "publication_unavailable", "Try later."),
          jsonResponse(publicationBody("succeeded")),
        ],
        calls,
      ),
    });

    assert.deepEqual(result, {
      status: 0,
      stdout: `${REPOSITORY.html_url}\n`,
      stderr: "",
    });
    assert.deepEqual(
      calls.map(({ init }) => init?.method),
      ["PUT", "GET"],
    );
  }

  const cwd = remoteDirectory(context, "https://api.example.test");
  const unresolved = await invoke(["plan", "publish"], {
    cwd,
    fetchFunction: sequenceFetch([
      problemResponse(503, "publication_delayed", "Publication is delayed."),
      new Response("canary-secret", { status: 500 }),
    ]),
  });

  assertHandledFailure(unresolved, "request_outcome_unknown");
  assert.equal(JSON.parse(unresolved.stderr).status, 503);
  assert.deepEqual(JSON.parse(unresolved.stderr).response, {
    type: "about:blank",
    title: "Service Unavailable",
    status: 503,
    code: "publication_delayed",
    detail: "Publication is delayed.",
  });
  assert.doesNotMatch(unresolved.stderr, /canary-secret/);
});

test("polling distinguishes unavailable and invalid status responses", async (context) => {
  const unavailableCwd = remoteDirectory(context, "https://api.example.test");
  const unavailable = await invoke(["plan", "publish"], {
    cwd: unavailableCwd,
    fetchFunction: sequenceFetch([
      jsonResponse(publicationBody("compiling"), 201),
      problemResponse(503, "publication_unavailable", "Try later."),
    ]),
    planPublishSleep: async () => {},
  });
  assertHandledFailure(unavailable, "publication_status_unavailable");
  assert.equal(JSON.parse(unavailable.stderr).status, 503);
  assert.equal(
    JSON.parse(unavailable.stderr).response.code,
    "publication_unavailable",
  );

  const invalidCwd = remoteDirectory(context, "https://api.example.test");
  const invalidBody = {
    ...publicationBody("provisioning_repository"),
    canary: "canary-secret",
  };
  const invalid = await invoke(["plan", "publish"], {
    cwd: invalidCwd,
    fetchFunction: sequenceFetch([
      jsonResponse(publicationBody("compiling"), 201),
      jsonResponse(invalidBody),
    ]),
    planPublishSleep: async () => {},
  });
  assertHandledFailure(invalid, "invalid_publication_status");
  assert.doesNotMatch(invalid.stderr, /canary-secret/);
});

test("polling rejects replacement identities, regressions, and repository mutation", async (context) => {
  const cases = [
    {
      initial: publicationBody("compiling"),
      changed: publicationBody("provisioning_repository", {
        publication: { id: OTHER_PUBLICATION_ID },
      }),
    },
    {
      initial: publicationBody("compiling"),
      changed: publicationBody("provisioning_repository", {
        compilation: { id: OTHER_COMPILATION_ID },
      }),
    },
    {
      initial: publicationBody("publishing"),
      changed: publicationBody("publishing", {
        repository: { id: REPOSITORY.id + 1 },
      }),
    },
    {
      initial: publicationBody("publishing"),
      changed: publicationBody("provisioning_repository", {
        publication: {
          repository: { ...REPOSITORY, tree_sha: null, commit_sha: null },
        },
      }),
    },
    {
      initial: publicationBody("repository_unknown"),
      changed: publicationBody("provisioning_repository"),
    },
    {
      initial: publicationBody("publication_unknown"),
      changed: publicationBody("publishing"),
    },
  ];

  for (const { initial, changed } of cases) {
    const cwd = remoteDirectory(context, "https://api.example.test");
    const result = await invoke(["plan", "publish"], {
      cwd,
      fetchFunction: sequenceFetch([
        jsonResponse(initial, 201),
        jsonResponse(changed),
      ]),
      planPublishSleep: async () => {},
    });

    assertHandledFailure(result, "publication_changed");
    const envelope = JSON.parse(result.stderr);
    assert.deepEqual(envelope.current, initial);
    assert.deepEqual(envelope.rejected, changed);
  }
});

test("the bounded wait reports its last validated status", async (context) => {
  const cwd = remoteDirectory(context, "https://api.example.test");
  let clock = 0;
  const result = await invoke(["plan", "publish"], {
    cwd,
    fetchFunction: sequenceFetch([
      jsonResponse(publicationBody("compiling"), 201),
    ]),
    planPublishNow: () => clock,
    planPublishSleep: async () => {
      clock = 10 * 60_000;
    },
  });

  assertHandledFailure(result, "publication_wait_timed_out");
  assert.equal(
    JSON.parse(result.stderr).current.publication.status,
    "compiling",
  );
});

test("failed, conflicted, and cancelled publications preserve terminal status", async (context) => {
  /** @type {[string, string][]} */
  const cases = [
    ["failed", "publication_failed"],
    ["repository_conflict", "publication_failed"],
    ["cancelled", "publication_cancelled"],
  ];

  for (const [status, expectedError] of cases) {
    const cwd = remoteDirectory(context, "https://api.example.test");
    const result = await invoke(["plan", "publish"], {
      cwd,
      fetchFunction: sequenceFetch([
        jsonResponse(publicationBody(status), 201),
      ]),
    });

    assertHandledFailure(result, expectedError);
    assert.equal(JSON.parse(result.stderr).current.publication.status, status);
  }

  for (const status of ["failed", "cancelled"]) {
    const cwd = remoteDirectory(context, "https://api.example.test");
    const result = await invoke(["plan", "publish"], {
      cwd,
      fetchFunction: sequenceFetch([
        jsonResponse(
          publicationBody(status, { publication: { started_at: null } }),
          201,
        ),
      ]),
    });

    assertHandledFailure(
      result,
      status === "failed" ? "publication_failed" : "publication_cancelled",
    );
    assert.equal(
      JSON.parse(result.stderr).current.publication.started_at,
      null,
    );
  }
});

test("exact response shapes and coherent terminal projections are required", async (context) => {
  const invalidBodies = [
    { ...publicationBody("succeeded"), canary: "canary-secret" },
    publicationBody("succeeded", {
      project: { head_source_sha256: "f".repeat(64) },
    }),
    publicationBody("succeeded", {
      project: { graph_version: 7, head_source_sha256: "a".repeat(64) },
      compilation: {
        graph_version: 7,
        head_source_sha256: "a".repeat(64),
      },
    }),
    publicationBody("succeeded", {
      compilation: { artifact: null },
    }),
    publicationBody("succeeded", {
      compilation: { head_source_sha256: "f".repeat(64) },
    }),
    publicationBody("succeeded", {
      repository: { private: false },
    }),
    publicationBody("succeeded", {
      repository: {
        html_url: "https://github.com/octocat/a-different-repository",
      },
    }),
    publicationBody("succeeded", {
      repository: {
        full_name: "someone-else/oscar-party",
        html_url: "https://github.com/someone-else/oscar-party",
      },
    }),
    publicationBody("succeeded", {
      repository: {
        full_name: "octocat/team/oscar-party",
        html_url: "https://github.com/octocat/team/oscar-party",
      },
    }),
    publicationBody("succeeded", {
      repository: { commit_sha: null, tree_sha: null },
    }),
    publicationBody("succeeded", {
      publication: { started_at: null },
    }),
    publicationBody("failed", {
      publication: { failure: null },
    }),
    publicationBody("publishing", {
      publication: { completed_at: COMPLETED_AT },
    }),
  ];

  for (const [index, body] of invalidBodies.entries()) {
    const cwd = remoteDirectory(context, "https://api.example.test");
    const result = await invoke(["plan", "publish"], {
      cwd,
      fetchFunction: sequenceFetch([
        jsonResponse(body, 201),
        problemResponse(404, "publication_not_found", `Missing ${index}.`),
      ]),
    });

    assertHandledFailure(result, "request_outcome_unknown");
    assert.doesNotMatch(result.stderr, /canary-secret/);
  }
});

/** @typedef {{input: string | URL | Request, init: RequestInit | undefined}} FetchCall */

/**
 * @param {string} status
 * @param {{project?: Record<string, unknown>, compilation?: Record<string, unknown>, publication?: Record<string, unknown>, repository?: Record<string, unknown>}} [changes]
 */
function publicationBody(status, changes = {}) {
  const terminal = [
    "succeeded",
    "repository_conflict",
    "failed",
    "cancelled",
  ].includes(status);
  const compilationStatus =
    status === "compiling"
      ? "queued"
      : status === "cancelled"
        ? "cancelled"
        : status === "failed"
          ? "failed"
          : "succeeded";
  const repositoryRequired = [
    "publishing",
    "publication_unknown",
    "succeeded",
    "repository_conflict",
  ].includes(status);
  const repository = repositoryRequired
    ? {
        ...REPOSITORY,
        ...(status === "succeeded" ? {} : { tree_sha: null, commit_sha: null }),
        ...changes.repository,
      }
    : null;
  const failure = ["failed", "repository_conflict"].includes(status)
    ? { phase: status === "failed" ? "compile" : "publish", code: status }
    : null;

  return {
    project: {
      id: PROJECT_ID,
      graph_version: 11,
      head_source_sha256: HEAD_SHA256,
      ...changes.project,
    },
    compilation: {
      id: COMPILATION_ID,
      analysis_run_id: ANALYSIS_ID,
      graph_version: 11,
      head_source_sha256: HEAD_SHA256,
      status: compilationStatus,
      compiler_release: COMPILER_RELEASE,
      target: TARGET,
      artifact: compilationStatus === "succeeded" ? ARTIFACT : null,
      ...changes.compilation,
    },
    publication: {
      id: PUBLICATION_ID,
      status,
      repository,
      failure,
      created_at: CREATED_AT,
      started_at: status === "compiling" ? null : STARTED_AT,
      completed_at: terminal ? COMPLETED_AT : null,
      ...changes.publication,
    },
  };
}

function publicationPath() {
  return `/v1/projects/${PROJECT_ID}/github-publication`;
}

/** @param {Buffer} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {unknown} body @param {number} [status] */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** @param {number} status @param {string} code @param {string} detail */
function problemResponse(status, code, detail) {
  /** @type {Record<number, string>} */
  const titles = {
    401: "Unauthorized",
    404: "Not Found",
    408: "Request Timeout",
    412: "Precondition Failed",
    503: "Service Unavailable",
  };
  return new Response(
    JSON.stringify({
      type: "about:blank",
      title: titles[status] ?? "Error",
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
 * @param {FetchCall[]} [calls]
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

/** @param {import("node:http").ServerResponse} response @param {number} status @param {unknown} body */
function respondJson(response, status, body) {
  const source = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": source.byteLength,
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
  const directory = mkdtempSync(path.join(tmpdir(), "firstdraft-publish-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, ".firstdraft"));
  writeFileSync(
    path.join(directory, ".firstdraft", "state.json"),
    `${JSON.stringify(state, null, 2)}\n`,
    { mode: 0o600 },
  );
  writeFileSync(planPath(directory), PLAN_SOURCE);
  return directory;
}

/** @param {string} directory */
function planPath(directory) {
  return path.join(directory, ".firstdraft", "foundation-plan.json");
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
