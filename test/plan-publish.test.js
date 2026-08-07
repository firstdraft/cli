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
const RETRY_AT = "2026-08-07T16:15:00.000000Z";
const COMPILER_RELEASE = "foundation-plan-rails/compiler-2026-08";
const TARGET = { id: "rails", profile: "rails-sketch/2026-08" };
const ARTIFACT = {
  sha256: "1".repeat(64),
  manifest_sha256: "2".repeat(64),
  file_count: 197,
};
const TREE_SHA = "3".repeat(40);
const COMMIT_SHA = "4".repeat(40);
const SAFE_PROGRESS_REASON_CODES = [
  "github.configuration_missing",
  "github.oauth_unavailable",
  "github.api_unavailable",
  "github.reauthorization_required",
  "github.account_mismatch",
  "github.installation_unavailable",
  "github.installation_not_ready",
  "github.preflight_unavailable",
  "github.preflight_unclassified",
  "github.preflight_unavailable.configuration",
  "github.preflight_unavailable.authorization",
  "github.preflight_unavailable.repository_client",
  "github.preflight_unavailable.artifact_preparation",
  "github.preflight_unavailable.installation_token",
  "github.preflight_unavailable.publication_preparation",
  "github.preflight_unavailable.repository_ref_client",
];
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
const REPOSITORY_URL = REPOSITORY.html_url;
const REPLAY_PROGRESS = `First Draft: Analyzing Foundation Plan...
First Draft: Foundation Plan analysis valid.
First Draft: Compiling application...
First Draft: Application compiled.
First Draft: GitHub publication complete.
`;
const LIFECYCLE_PROGRESS = `First Draft: Analyzing Foundation Plan...
First Draft: Foundation Plan analysis valid.
First Draft: Compiling application...
First Draft: Application compiled.
First Draft: Preparing private GitHub repository...
First Draft: Preparing to verify GitHub repository creation...
First Draft: Preparing compiled application...
First Draft: Preparing to verify GitHub publication...
First Draft: GitHub publication complete.
`;
const PLAN_COMPILE_HELP = `First Draft CLI

Usage:
  firstdraft plan compile

Options:
  -h, --help  Show help

Environment:
  FIRSTDRAFT_API_TOKEN  Authenticate API requests
  FIRSTDRAFT_API_URL    Override the initial API origin

The command submits the exact current whole-file Plan, waits for its analysis,
and proceeds only when that analysis is valid. It then conditionally creates or
replays the internal GitHub Publication lifecycle. Progress is written to
stderr. Success prints only the validated private GitHub repository URL.
`;

test("plan compile invokes Publication and one conditional singleton PUT and polls sequentially", async (context) => {
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
  const result = await invoke(["plan", "compile"], {
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
    stdout: `${REPOSITORY_URL}\n`,
    stderr: LIFECYCLE_PROGRESS,
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
  assert.doesNotMatch(result.stdout, /canary-secret/);
});

test("progress reports each safe GitHub phase, scheduled retry, and parked retry once", async (context) => {
  const cwd = remoteDirectory(context, "https://api.example.test");
  const scheduled = {
    phase: "github_preflight",
    retry_at: RETRY_AT,
    retry_count: 2,
    reason_code: "github.api_unavailable",
  };
  const parked = {
    phase: "github_preflight",
    retry_at: null,
    retry_count: 7,
    reason_code: "github.installation_not_ready",
  };
  const responses = [
    jsonResponse(publicationBody("compiling"), 201),
    jsonResponse(
      publicationBody("compiling", {
        compilation: { status: "running" },
      }),
    ),
    jsonResponse(
      publicationBody("compiling", {
        compilation: { status: "running" },
      }),
    ),
    jsonResponse(
      publicationBody("compiling", {
        compilation: { status: "succeeded", artifact: ARTIFACT },
      }),
    ),
    jsonResponse(publicationBody("provisioning_repository")),
    jsonResponse(
      publicationBody("provisioning_repository", {
        publication: {
          progress: {
            phase: "github_preflight",
            retry_at: null,
            retry_count: 0,
            reason_code: null,
          },
        },
      }),
    ),
    jsonResponse(
      publicationBody("provisioning_repository", {
        publication: {
          progress: {
            phase: "github_preflight",
            retry_at: null,
            retry_count: 0,
            reason_code: null,
          },
        },
      }),
    ),
    jsonResponse(
      publicationBody("provisioning_repository", {
        publication: { progress: scheduled },
      }),
    ),
    jsonResponse(
      publicationBody("provisioning_repository", {
        publication: { progress: scheduled },
      }),
    ),
    jsonResponse(
      publicationBody("provisioning_repository", {
        publication: { progress: parked },
      }),
    ),
    jsonResponse(
      publicationBody("provisioning_repository", {
        publication: {
          progress: defaultProgress("provisioning_repository", {
            phase: "creating_repository",
          }),
        },
      }),
    ),
    jsonResponse(publicationBody("repository_unknown")),
    jsonResponse(
      publicationBody("repository_unknown", {
        publication: {
          progress: defaultProgress("repository_unknown", {
            phase: "reconciling_repository",
          }),
        },
      }),
    ),
    jsonResponse(publicationBody("publishing")),
    jsonResponse(
      publicationBody("publishing", {
        publication: {
          progress: {
            phase: "github_preflight",
            retry_at: null,
            retry_count: 0,
            reason_code: null,
          },
        },
      }),
    ),
    jsonResponse(
      publicationBody("publishing", {
        publication: {
          progress: defaultProgress("publishing", {
            phase: "publishing_artifact",
          }),
        },
      }),
    ),
    jsonResponse(publicationBody("publication_unknown")),
    jsonResponse(
      publicationBody("publication_unknown", {
        publication: {
          progress: defaultProgress("publication_unknown", {
            phase: "reconciling_publication",
          }),
        },
      }),
    ),
    jsonResponse(publicationBody("succeeded")),
  ];

  const result = await invoke(["plan", "compile"], {
    cwd,
    fetchFunction: sequenceFetch(responses),
    planPublishSleep: async () => {},
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, `${REPOSITORY_URL}\n`);
  assert.equal(
    result.stderr,
    `First Draft: Analyzing Foundation Plan...
First Draft: Foundation Plan analysis valid.
First Draft: Compiling application...
First Draft: Application compiled.
First Draft: Preparing private GitHub repository...
First Draft: Checking GitHub access...
First Draft: Checking GitHub access (reason: github.api_unavailable; retry count: 2; next retry: ${RETRY_AT}).
First Draft: Checking GitHub access (reason: github.installation_not_ready; retry count: 7; automatic retries paused; operator recovery required).
First Draft: Creating private GitHub repository...
First Draft: Preparing to verify GitHub repository creation...
First Draft: Verifying GitHub repository creation...
First Draft: Preparing compiled application...
First Draft: Checking GitHub access...
First Draft: Publishing compiled application to GitHub...
First Draft: Preparing to verify GitHub publication...
First Draft: Verifying GitHub publication...
First Draft: GitHub publication complete.
`,
  );
  for (const privateValue of [
    PROJECT_ID,
    COMPILATION_ID,
    PUBLICATION_ID,
    HEAD_SHA256,
    TREE_SHA,
    COMMIT_SHA,
    REPOSITORY.full_name,
    REPOSITORY_URL,
  ]) {
    assert.doesNotMatch(result.stderr, new RegExp(privateValue));
  }
});

test("progress accepts every coordinated safe reason code", async (context) => {
  const cwd = remoteDirectory(context, "https://api.example.test");
  const responses = SAFE_PROGRESS_REASON_CODES.map((reasonCode) =>
    jsonResponse(
      publicationBody("provisioning_repository", {
        publication: {
          progress: {
            phase: "github_preflight",
            retry_at: RETRY_AT,
            retry_count: 1,
            reason_code: reasonCode,
          },
        },
      }),
    ),
  );
  responses.push(jsonResponse(publicationBody("succeeded")));

  const result = await invoke(["plan", "compile"], {
    cwd,
    fetchFunction: sequenceFetch(responses),
    planPublishSleep: async () => {},
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, `${REPOSITORY_URL}\n`);
  assert.equal(
    result.stderr,
    `First Draft: Analyzing Foundation Plan...
First Draft: Foundation Plan analysis valid.
First Draft: Compiling application...
First Draft: Application compiled.
${SAFE_PROGRESS_REASON_CODES.map(
  (reasonCode) =>
    `First Draft: Checking GitHub access (reason: ${reasonCode}; retry count: 1; next retry: ${RETRY_AT}).`,
).join("\n")}
First Draft: GitHub publication complete.
`,
  );
});

test("a repeated singleton PUT accepts provenance matching local Plan state", async (context) => {
  const cwd = remoteDirectory(context, "https://api.example.test");
  /** @type {FetchCall[]} */
  const calls = [];
  const result = await invoke(["plan", "compile"], {
    cwd,
    fetchFunction: sequenceFetch(
      [jsonResponse(publicationBody("succeeded"), 200)],
      calls,
    ),
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, `${REPOSITORY_URL}\n`);
  assert.equal(result.stderr, REPLAY_PROGRESS);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.init?.method, "PUT");
  assert.equal(new Headers(calls[0]?.init?.headers).get("if-match"), ETAG);
});

test("an ambiguous PUT is reconciled by one safe singleton GET", async (context) => {
  const cwd = remoteDirectory(context, "https://api.example.test");
  /** @type {FetchCall[]} */
  const calls = [];
  const result = await invoke(["plan", "compile"], {
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
    stdout: `${REPOSITORY_URL}\n`,
    stderr: REPLAY_PROGRESS,
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
  const result = await invoke(["plan", "compile"], {
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
  assert.equal(errorEnvelope(result.stderr).status, 200);
  assert.match(
    errorEnvelope(result.stderr).detail,
    /Do not run concurrent Compile commands.*unchanged Plan bytes.*retained singleton/,
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
  const result = await invoke(["plan", "compile"], {
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
    stdout: `${REPOSITORY_URL}\n`,
    stderr: REPLAY_PROGRESS,
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
  const result = await invoke(["plan", "compile"], {
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
  assert.equal(errorEnvelope(result.stderr).status, 404);
  assert.equal(
    errorEnvelope(result.stderr).response.code,
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
    ["plan", "compile", "--help"],
    ["plan", "compile", "-h"],
    ["plan", "compile", "--help", "--help"],
  ]) {
    assert.deepEqual(
      await invoke(argv, {
        cwd: process.cwd(),
        getCwd: inaccessible,
        fetchFunction: inaccessible,
        planPushFileSystem: inaccessibleFileSystem(),
        apiToken: undefined,
      }),
      { status: 0, stdout: PLAN_COMPILE_HELP, stderr: "" },
    );
  }

  for (const argv of [
    ["plan", "compile", "canary-secret"],
    ["plan", "compile", "--canary-secret"],
  ]) {
    const result = await invoke(argv, {
      fetchFunction: inaccessible,
      planPushFileSystem: inaccessibleFileSystem(),
    });
    assertHandledFailure(result, "invalid_arguments", 2);
    assert.doesNotMatch(result.stderr, /canary-secret/);
  }

  assert.deepEqual(
    await invoke(["plan", "publish"], {
      getCwd: inaccessible,
      fetchFunction: inaccessible,
      planPushFileSystem: inaccessibleFileSystem(),
    }),
    {
      status: 2,
      stdout: "",
      stderr: "Unknown command.\nRun 'firstdraft plan --help' for usage.\n",
    },
  );
});

test("local prerequisites reject before publication network access", async (context) => {
  const inaccessible = inaccessibleFetch();
  const unpushed = localDirectory(context, {
    format: "firstdraft.cli-state/1",
    project_id: PROJECT_ID,
  });
  assertHandledFailure(
    await invoke(["plan", "compile"], {
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
    await invoke(["plan", "compile"], {
      cwd: opaque,
      fetchFunction: inaccessible,
      planCompilePush: async () => ({
        status: 200,
        etag: '"opaque"',
        outcome: "updated",
        body: { project: { graph_version: 11 } },
      }),
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
    await invoke(["plan", "compile"], {
      cwd: changed,
      fetchFunction: inaccessible,
    }),
    "local_plan_changed",
  );

  const missingPlan = remoteDirectory(context, "https://api.example.test");
  rmSync(planPath(missingPlan));
  assertHandledFailure(
    await invoke(["plan", "compile"], {
      cwd: missingPlan,
      fetchFunction: inaccessible,
    }),
    "local_input_unreadable",
  );
});

test("missing and rejected credentials use the stable authentication error", async (context) => {
  const cwd = remoteDirectory(context, "https://api.example.test");
  const missing = await invoke(["plan", "compile"], {
    cwd,
    apiToken: undefined,
    fetchFunction: inaccessibleFetch(),
  });
  assertHandledFailure(missing, "authentication_required");

  const rejected = await invoke(["plan", "compile"], {
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
  assert.equal(errorEnvelope(rejected.stderr).status, 401);

  const reconciliation = await invoke(["plan", "compile"], {
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
  assert.equal(errorEnvelope(reconciliation.stderr).status, 401);
});

test("validated start rejections are distinct from unknown mutation outcomes", async (context) => {
  const cwd = remoteDirectory(context, "https://api.example.test");
  const rejected = await invoke(["plan", "compile"], {
    cwd,
    fetchFunction: sequenceFetch([
      problemResponse(412, "precondition_failed", "The Plan changed."),
    ]),
  });

  assert.deepEqual(errorEnvelope(rejected.stderr), {
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

  const malformed = await invoke(["plan", "compile"], {
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
    const result = await invoke(["plan", "compile"], {
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
      stdout: `${REPOSITORY_URL}\n`,
      stderr: REPLAY_PROGRESS,
    });
    assert.deepEqual(
      calls.map(({ init }) => init?.method),
      ["PUT", "GET"],
    );
  }

  const cwd = remoteDirectory(context, "https://api.example.test");
  const unresolved = await invoke(["plan", "compile"], {
    cwd,
    fetchFunction: sequenceFetch([
      problemResponse(503, "publication_delayed", "Publication is delayed."),
      new Response("canary-secret", { status: 500 }),
    ]),
  });

  assertHandledFailure(unresolved, "request_outcome_unknown");
  assert.equal(errorEnvelope(unresolved.stderr).status, 503);
  assert.deepEqual(errorEnvelope(unresolved.stderr).response, {
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
  const unavailable = await invoke(["plan", "compile"], {
    cwd: unavailableCwd,
    fetchFunction: sequenceFetch([
      jsonResponse(publicationBody("compiling"), 201),
      problemResponse(503, "publication_unavailable", "Try later."),
    ]),
    planPublishSleep: async () => {},
  });
  assertHandledFailure(unavailable, "publication_status_unavailable");
  assert.equal(
    progressOutput(unavailable.stderr),
    `First Draft: Analyzing Foundation Plan...
First Draft: Foundation Plan analysis valid.
First Draft: Compiling application...
`,
  );
  assert.equal(errorEnvelope(unavailable.stderr).status, 503);
  assert.equal(
    errorEnvelope(unavailable.stderr).response.code,
    "publication_unavailable",
  );
  assert.match(
    errorEnvelope(unavailable.stderr).detail,
    /Do not run concurrent Compile commands.*unchanged Plan bytes.*retained singleton/,
  );

  const invalidCwd = remoteDirectory(context, "https://api.example.test");
  const invalidBody = {
    ...publicationBody("provisioning_repository"),
    canary: "canary-secret",
  };
  const invalid = await invoke(["plan", "compile"], {
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
    const result = await invoke(["plan", "compile"], {
      cwd,
      fetchFunction: sequenceFetch([
        jsonResponse(initial, 201),
        jsonResponse(changed),
      ]),
      planPublishSleep: async () => {},
    });

    assertHandledFailure(result, "publication_changed");
    const envelope = errorEnvelope(result.stderr);
    assert.deepEqual(envelope.current, initial);
    assert.deepEqual(envelope.rejected, changed);
  }
});

test("the bounded wait reports its last validated status", async (context) => {
  const cwd = remoteDirectory(context, "https://api.example.test");
  let clock = 0;
  const result = await invoke(["plan", "compile"], {
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
    errorEnvelope(result.stderr).current.publication.status,
    "compiling",
  );
  assert.match(
    errorEnvelope(result.stderr).detail,
    /stopped waiting.*Do not run concurrent Compile commands.*unchanged Plan bytes.*retained singleton/,
  );
});

test("terminal progress distinguishes Compilation outcomes from later GitHub outcomes", async (context) => {
  /** @type {[string, string, Parameters<typeof publicationBody>[1], string][]} */
  const cases = [
    [
      "failed",
      "publication_failed",
      { publication: { started_at: null } },
      "Application compilation failed.",
    ],
    [
      "cancelled",
      "publication_cancelled",
      { publication: { started_at: null } },
      "Application compilation cancelled.",
    ],
    [
      "failed",
      "publication_failed",
      {
        compilation: { status: "succeeded", artifact: ARTIFACT },
        publication: {
          failure: { phase: "publish", code: "publication_failed" },
        },
      },
      "GitHub publication failed.",
    ],
    [
      "cancelled",
      "publication_cancelled",
      { compilation: { status: "succeeded", artifact: ARTIFACT } },
      "GitHub publication cancelled.",
    ],
    [
      "repository_conflict",
      "publication_failed",
      { compilation: { status: "succeeded", artifact: ARTIFACT } },
      "GitHub publication failed.",
    ],
  ];

  for (const [status, expectedError, changes, terminalProgress] of cases) {
    const cwd = remoteDirectory(context, "https://api.example.test");
    const result = await invoke(["plan", "compile"], {
      cwd,
      fetchFunction: sequenceFetch([
        jsonResponse(publicationBody(status, changes), 201),
      ]),
    });

    assertHandledFailure(result, expectedError);
    const compiled = changes?.compilation?.status === "succeeded";
    assert.equal(
      progressOutput(result.stderr),
      `First Draft: Analyzing Foundation Plan...
First Draft: Foundation Plan analysis valid.
First Draft: Compiling application...
${compiled ? "First Draft: Application compiled.\n" : ""}First Draft: ${terminalProgress}
`,
    );
    assert.equal(
      errorEnvelope(result.stderr).current.publication.status,
      status,
    );
  }

  for (const status of ["failed", "cancelled"]) {
    const cwd = remoteDirectory(context, "https://api.example.test");
    const result = await invoke(["plan", "compile"], {
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
      errorEnvelope(result.stderr).current.publication.started_at,
      null,
    );
  }
});

test("exact response shapes and coherent terminal projections are required", async (context) => {
  const invalidBodies = [
    { ...publicationBody("succeeded"), canary: "canary-secret" },
    withoutPublicationProgress(publicationBody("succeeded")),
    publicationBody("succeeded", {
      publication: {
        progress: {
          ...defaultProgress("succeeded"),
          additive: "canary-secret",
        },
      },
    }),
    publicationBody("succeeded", {
      publication: {
        progress: defaultProgress("succeeded", {
          phase: "canary-secret",
        }),
      },
    }),
    publicationBody("succeeded", {
      publication: {
        progress: defaultProgress("succeeded", {
          phase: "preparing_repository",
        }),
      },
    }),
    publicationBody("provisioning_repository", {
      publication: {
        progress: defaultProgress("provisioning_repository", {
          retry_count: 1,
        }),
      },
    }),
    publicationBody("provisioning_repository", {
      publication: {
        progress: {
          phase: "github_preflight",
          retry_at: null,
          retry_count: 0,
          reason_code: "github.api_unavailable",
        },
      },
    }),
    publicationBody("provisioning_repository", {
      publication: {
        progress: {
          phase: "github_preflight",
          retry_at: null,
          retry_count: 1,
          reason_code: null,
        },
      },
    }),
    publicationBody("provisioning_repository", {
      publication: {
        progress: {
          phase: "github_preflight",
          retry_at: RETRY_AT,
          retry_count: 8,
          reason_code: "github.api_unavailable",
        },
      },
    }),
    publicationBody("provisioning_repository", {
      publication: {
        progress: {
          phase: "github_preflight",
          retry_at: "2026-08-07T16:15:00.000Z",
          retry_count: 1,
          reason_code: "github.api_unavailable",
        },
      },
    }),
    publicationBody("provisioning_repository", {
      publication: {
        progress: {
          phase: "github_preflight",
          retry_at: RETRY_AT,
          retry_count: 1,
          reason_code: "github.canary-secret",
        },
      },
    }),
    publicationBody("provisioning_repository", {
      publication: {
        progress: {
          phase: "github_preflight",
          retry_at: RETRY_AT,
          retry_count: 1,
          reason_code: "github.preflight_unavailable.canary-secret",
        },
      },
    }),
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
    const result = await invoke(["plan", "compile"], {
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
      progress: defaultProgress(status),
      created_at: CREATED_AT,
      started_at: status === "compiling" ? null : STARTED_AT,
      completed_at: terminal ? COMPLETED_AT : null,
      ...changes.publication,
    },
  };
}

/** @param {string} status @param {Record<string, unknown>} [changes] */
function defaultProgress(status, changes = {}) {
  /** @type {Record<string, string>} */
  const phases = {
    compiling: "compiling",
    provisioning_repository: "preparing_repository",
    repository_unknown: "preparing_repository_reconciliation",
    publishing: "preparing_artifact",
    publication_unknown: "preparing_publication_reconciliation",
    succeeded: "completed",
    repository_conflict: "failed",
    failed: "failed",
    cancelled: "cancelled",
  };
  return {
    phase: phases[status],
    retry_at: null,
    retry_count: 0,
    reason_code: null,
    ...changes,
  };
}

/** @param {ReturnType<typeof publicationBody>} body */
function withoutPublicationProgress(body) {
  const publication = /** @type {Record<string, unknown>} */ ({
    ...body.publication,
  });
  delete publication.progress;
  return { ...body, publication };
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
    planCompilePush: async () => ({
      status: 200,
      etag: ETAG,
      outcome: "updated",
      body: { project: { graph_version: 11 } },
    }),
    planCompileReadStatus: async () => ({
      status: 200,
      body: validAnalysis(),
    }),
    ...options,
  });
  return { status, stdout, stderr };
}

function validAnalysis() {
  return {
    project: { id: PROJECT_ID, graph_version: 11 },
    analysis: {
      id: ANALYSIS_ID,
      graph_version: 11,
      analyzer_release: "foundation-plan-analyzer/2026-08",
      status: "valid",
      diagnostics: [],
      started_at: STARTED_AT,
      completed_at: COMPLETED_AT,
    },
  };
}

/**
 * @param {{status: number, stdout: string, stderr: string}} result
 * @param {string} error
 * @param {number} [status]
 */
function assertHandledFailure(result, error, status = 1) {
  assert.equal(result.status, status);
  assert.equal(result.stdout, "");
  assert.equal(errorEnvelope(result.stderr).error, error);
  if (error === "request_outcome_unknown") {
    assert.equal(errorEnvelope(result.stderr).phase, "publication");
  }
}

/** @param {string} stderr */
function errorEnvelope(stderr) {
  const structured = stderr
    .split("\n")
    .filter((line) => !line.startsWith("First Draft: "))
    .join("\n");
  return JSON.parse(structured);
}

/** @param {string} stderr */
function progressOutput(stderr) {
  const lines = stderr
    .split("\n")
    .filter((line) => line.startsWith("First Draft: "));
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
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
