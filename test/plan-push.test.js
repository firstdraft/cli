import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { run } from "../src/cli.js";
import {
  PlanPushStateWriteError,
  pushPlan,
} from "../src/commands/plan-push.js";

/** @typedef {{input: string | URL | Request, init: RequestInit | undefined}} FetchCall */

const PROJECT_ID = "01900000-0000-7000-8000-000000000301";
const API_URL = "https://api.example.test";
const API_TOKEN = `fd_${"a".repeat(43)}`;
const FIRST_ETAG = '"opaque:first-validator"';
const SECOND_ETAG = '"opaque:second-validator"';
const PLAN_PUSH_HELP = `First Draft CLI

Usage:
  firstdraft plan push

Options:
  -h, --help  Show help

Environment:
  FIRSTDRAFT_API_TOKEN  Authenticate API requests
  FIRSTDRAFT_API_URL    Override the initial API origin

The first successful push saves its API origin in .firstdraft/state.json.
Later pushes reject a different origin.
`;
const PLAN_PUSH_INVALID_ARGUMENTS_ERROR = jsonOutput({
  error: "invalid_arguments",
  detail: "Invalid arguments. Run 'firstdraft plan push --help' for usage.",
});
const PLAN_PUSH_CONFIGURATION_ERROR = jsonOutput({
  error: "invalid_configuration",
  detail:
    "Invalid First Draft API configuration. Run 'firstdraft plan push --help' for usage.",
});
const PLAN_PUSH_LOCAL_ERROR = jsonOutput({
  error: "local_input_unreadable",
  detail:
    "Could not read the local First Draft Plan or state. No network request was made. Preserve the local files for manual recovery.",
});
const PLAN_PUSH_OUTCOME_UNKNOWN_ERROR = requestOutcomeUnknownOutput();

test("plan push help has no local or network prerequisites", async () => {
  const inaccessible = () => {
    throw new Error("help must not access dependencies");
  };

  for (const argv of [
    ["plan", "push", "--help"],
    ["plan", "push", "-h"],
    ["plan", "push", "--help", "--help"],
  ]) {
    assert.deepEqual(
      await invoke(argv, {
        fetchFunction: inaccessible,
        planPushFileSystem: inaccessiblePlanPushFileSystem(),
      }),
      { status: 0, stdout: PLAN_PUSH_HELP, stderr: "" },
    );
  }
});

test("the initial push sends exact bytes and saves its origin and ETag", async (context) => {
  const cwd = await initializedDirectory(context);
  const source = planSource(cwd);
  const response = acceptedResponse(source, 201, FIRST_ETAG);
  /** @type {FetchCall[]} */
  const calls = [];
  const signal = new AbortController().signal;
  const result = await invoke(["plan", "push"], {
    cwd,
    fetchFunction: recordingFetch(response, calls),
    createRequestSignal: () => signal,
    createTemporaryId: () => "initial-push",
    apiUrl: `${API_URL}/`,
  });

  assert.equal(calls.length, 1);
  const [call] = calls;
  assert(call);
  assert.equal(
    String(call.input),
    `${API_URL}/v1/projects/${PROJECT_ID}/foundation-plan`,
  );
  assert.equal(call.init?.method, "PUT");
  assert.equal(call.init?.redirect, "error");
  assert.equal(call.init?.signal, signal);
  const headers = new Headers(call.init?.headers);
  assert.equal(
    headers.get("content-type"),
    "application/vnd.firstdraft.foundation-plan+json",
  );
  assert.equal(
    headers.get("accept"),
    "application/json, application/problem+json",
  );
  assert.equal(headers.get("if-none-match"), "*");
  assert.equal(headers.has("if-match"), false);
  assert.equal(headers.get("authorization"), `Bearer ${API_TOKEN}`);
  assert(Buffer.isBuffer(call.init?.body));
  assert.deepEqual(call.init.body, source);

  assert.deepEqual(result, {
    status: 0,
    stdout: `${JSON.stringify(
      {
        outcome: "created",
        etag: FIRST_ETAG,
        ...acceptedBody(source),
      },
      null,
      2,
    )}\n`,
    stderr: "",
  });
  assert.deepEqual(readState(cwd), {
    format: "firstdraft.cli-state/1",
    project_id: PROJECT_ID,
    api_url: API_URL,
    foundation_plan_etag: FIRST_ETAG,
  });
  assert.deepEqual(readdirSync(path.join(cwd, ".firstdraft")).sort(), [
    ".gitignore",
    "foundation-plan.json",
    "state.json",
  ]);
  if (process.platform !== "win32") {
    assert.equal(
      statSync(path.join(cwd, ".firstdraft", "state.json")).mode & 0o777,
      0o600,
    );
  }
});

test("the initial push defaults to the First Draft production origin", async (context) => {
  const cwd = await initializedDirectory(context);
  const source = planSource(cwd);
  /** @type {FetchCall[]} */
  const calls = [];
  const result = await pushPlan({
    cwd,
    fetchFunction: recordingFetch(
      acceptedResponse(source, 201, FIRST_ETAG),
      calls,
    ),
    createTemporaryId: () => "default-origin",
  });

  assert("etag" in result);
  assert.equal(
    String(calls[0]?.input),
    `https://firstdraft.com/v1/projects/${PROJECT_ID}/foundation-plan`,
  );
  assert.equal(readState(cwd).api_url, "https://firstdraft.com");
});

test("later pushes replay the saved ETag and rotate it opaquely", async (context) => {
  const cwd = await initializedDirectory(context);
  await successfulInitialPush(cwd);
  const pathToPlan = path.join(cwd, ".firstdraft", "foundation-plan.json");
  const replacement = `${readFileSync(pathToPlan, "utf8")} `;
  writeFileSync(pathToPlan, replacement);
  /** @type {FetchCall[]} */
  const calls = [];

  const result = await invoke(["plan", "push"], {
    cwd,
    apiUrl: API_URL,
    fetchFunction: recordingFetch(
      acceptedResponse(Buffer.from(replacement), 200, SECOND_ETAG),
      calls,
    ),
    createTemporaryId: () => "replacement",
  });

  const [call] = calls;
  assert(call);
  const headers = new Headers(call.init?.headers);
  assert.equal(headers.get("if-match"), FIRST_ETAG);
  assert.equal(headers.has("if-none-match"), false);
  assert(Buffer.isBuffer(call.init?.body));
  assert.deepEqual(call.init.body, Buffer.from(replacement));
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).outcome, "updated");
  assert.equal(JSON.parse(result.stdout).etag, SECOND_ETAG);
  assert.equal(readState(cwd).foundation_plan_etag, SECOND_ETAG);
  assert.equal(readState(cwd).api_url, API_URL);
});

test("a saved origin may be repeated but never changed", async (context) => {
  const cwd = await initializedDirectory(context);
  await successfulInitialPush(cwd);
  const before = stateSource(cwd);

  const same = await invoke(["plan", "push"], {
    cwd,
    fetchFunction: recordingFetch(
      acceptedResponse(planSource(cwd), 200, SECOND_ETAG),
      [],
    ),
    createTemporaryId: () => "same-origin",
    apiUrl: `${API_URL}/`,
  });
  assert.equal(same.status, 0);

  const different = await invoke(["plan", "push"], {
    cwd,
    apiUrl: "https://canary-secret.example",
    fetchFunction: inaccessibleFetch(),
  });
  assert.deepEqual(different, {
    status: 2,
    stdout: "",
    stderr: PLAN_PUSH_CONFIGURATION_ERROR,
  });
  assert.doesNotMatch(different.stderr, /canary-secret/);
  assert.notDeepEqual(stateSource(cwd), before);
  assert.equal(readState(cwd).api_url, API_URL);
  assert.equal(readState(cwd).foundation_plan_etag, SECOND_ETAG);
});

test("an API override must be one valid secure or loopback origin", async (context) => {
  const invalidApiUrls = [
    "canary-secret-not-a-url",
    "ftp://canary-secret.example",
    "http://canary-secret.example",
    "https://user:pass@canary-secret.example",
    "https://canary-secret.example/path",
    "https://canary-secret.example?query",
    "https://canary-secret.example#hash",
  ];

  for (const apiUrl of invalidApiUrls) {
    const cwd = await initializedDirectory(context);
    const before = stateSource(cwd);
    const result = await invoke(["plan", "push"], {
      cwd,
      apiUrl,
      fetchFunction: inaccessibleFetch(),
    });

    assert.deepEqual(result, {
      status: 2,
      stdout: "",
      stderr: PLAN_PUSH_CONFIGURATION_ERROR,
    });
    assert.doesNotMatch(result.stderr, /canary-secret/);
    assert.deepEqual(stateSource(cwd), before);
  }
});

test("usage errors happen before local or network access", async () => {
  for (const argv of [
    ["plan", "push", "--canary-secret-option"],
    ["plan", "push", "canary-secret-positional"],
  ]) {
    const result = await invoke(argv, {
      fetchFunction: inaccessibleFetch(),
      planPushFileSystem: inaccessiblePlanPushFileSystem(),
    });

    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, PLAN_PUSH_INVALID_ARGUMENTS_ERROR);
    assert.doesNotMatch(result.stderr, /canary-secret/);
  }
});

test("HTTP diagnostics and problems leave local state byte-for-byte unchanged", async (context) => {
  const cases = [
    {
      status: 422,
      body: {
        source_sha256: "replace-with-request-digest",
        diagnostics: [
          {
            code: "foundation_plan.import.unsupported_bootstrap_content",
            severity: "error",
            message: "The Plan is not supported yet.",
          },
        ],
      },
    },
    {
      status: 412,
      body: {
        type: "about:blank",
        title: "Precondition Failed",
        status: 412,
        code: "precondition_failed",
        detail: "The request precondition does not match.",
      },
    },
    {
      status: 428,
      body: {
        title: "Precondition Required",
        status: 428,
        code: "precondition_required",
        detail: "A representation-specific precondition is required.",
      },
    },
  ];

  for (const { status, body } of cases) {
    const cwd = await initializedDirectory(context);
    const before = stateSource(cwd);
    const responseBody =
      status === 422
        ? { ...body, source_sha256: sha256(planSource(cwd)) }
        : body;
    const response =
      status === 422
        ? jsonResponse(responseBody, status)
        : problemResponse(responseBody, status);
    const result = await invoke(["plan", "push"], {
      cwd,
      apiUrl: API_URL,
      fetchFunction: recordingFetch(response, []),
    });

    assert.deepEqual(result, {
      status: 1,
      stdout: "",
      stderr: serverRejectedOutput(status, responseBody),
    });
    assert.deepEqual(stateSource(cwd), before);
  }
});

test("server rejection envelopes expose only validated response fields", async (context) => {
  const cwd = await initializedDirectory(context);
  const sourceSha256 = sha256(planSource(cwd));
  const diagnostic = {
    code: "foundation_plan.example",
    severity: "error",
    message: "The Plan needs a supported value.",
    location: {
      source_pointer: "/application/entities/0",
      canary: "canary-secret-location",
    },
    subject: {
      kind: "entity",
      readable_path: "movie",
      subject_uuid: PROJECT_ID,
      canary: "canary-secret-subject",
    },
    related_locations: [
      { line: 1, column: 2, canary: "canary-secret-related" },
    ],
    suggestions: ["Choose a supported value.", 7],
    canary: "canary-secret-diagnostic",
  };
  const body = {
    source_sha256: sourceSha256,
    diagnostics: [diagnostic],
    canary: "canary-secret-response",
  };
  const result = await invoke(["plan", "push"], {
    cwd,
    apiUrl: API_URL,
    fetchFunction: recordingFetch(jsonResponse(body, 422), []),
  });

  assert.deepEqual(JSON.parse(result.stderr), {
    error: "server_rejected",
    detail: "First Draft rejected the Plan.",
    status: 422,
    response: {
      source_sha256: sourceSha256,
      diagnostics: [
        {
          code: diagnostic.code,
          severity: diagnostic.severity,
          message: diagnostic.message,
          location: { source_pointer: "/application/entities/0" },
          subject: {
            kind: "entity",
            readable_path: "movie",
            subject_uuid: PROJECT_ID,
          },
          related_locations: [{ line: 1, column: 2 }],
        },
      ],
    },
  });
  assert.doesNotMatch(result.stderr, /canary-secret/);

  const problem = {
    type: "about:blank",
    title: "Precondition Failed",
    status: 412,
    code: "precondition_failed",
    detail: "The Foundation Plan has changed.",
    source_sha256: "canary-secret-unverified-digest",
    diagnostics: [
      {
        code: "canary-secret-code",
        severity: "error",
        message: "canary-secret-message",
      },
    ],
    canary: "canary-secret-problem",
  };
  const problemResult = await invoke(["plan", "push"], {
    cwd,
    apiUrl: API_URL,
    fetchFunction: recordingFetch(problemResponse(problem, 412), []),
  });

  assert.deepEqual(JSON.parse(problemResult.stderr), {
    error: "server_rejected",
    detail: "First Draft rejected the Plan.",
    status: 412,
    response: {
      type: "about:blank",
      title: problem.title,
      status: 412,
      code: problem.code,
      detail: problem.detail,
    },
  });
  assert.doesNotMatch(problemResult.stderr, /canary-secret/);
});

test("missing credentials and a validated 401 use one stable authentication error", async (context) => {
  const cwd = await initializedDirectory(context);
  let requests = 0;
  for (const apiToken of ["", " \t\n"]) {
    const missing = await invoke(["plan", "push"], {
      cwd,
      apiUrl: API_URL,
      apiToken,
      fetchFunction: async () => {
        requests += 1;
        throw new Error("request must not be sent");
      },
    });

    assert.deepEqual(JSON.parse(missing.stderr), {
      error: "authentication_required",
      detail:
        "First Draft authentication is required. Set FIRSTDRAFT_API_TOKEN to an active API token.",
    });
    assert.equal(missing.status, 1);
  }
  assert.equal(requests, 0);

  const problem = {
    type: "about:blank",
    title: "Unauthorized",
    status: 401,
    code: "authentication_required",
    detail: "Provide a valid API token.",
    canary: "canary-secret-response-field",
  };
  const rejected = await invoke(["plan", "push"], {
    cwd,
    apiUrl: API_URL,
    fetchFunction: recordingFetch(problemResponse(problem, 401), []),
  });

  assert.deepEqual(JSON.parse(rejected.stderr), {
    error: "authentication_required",
    detail:
      "First Draft authentication is required. Set FIRSTDRAFT_API_TOKEN to an active API token.",
    status: 401,
    response: {
      type: "about:blank",
      title: "Unauthorized",
      status: 401,
      code: "authentication_required",
      detail: "Provide a valid API token.",
    },
  });
  assert.equal(rejected.status, 1);
  assert.doesNotMatch(rejected.stderr, /canary-secret/);
  assert.equal(rejected.stderr.includes(API_TOKEN), false);
});

test("a stale update preserves the prior ETag and exact local state", async (context) => {
  const cwd = await initializedDirectory(context);
  await successfulInitialPush(cwd);
  const before = stateSource(cwd);
  const problem = {
    type: "about:blank",
    title: "Precondition Failed",
    status: 412,
    code: "precondition_failed",
    detail: "The Foundation Plan has changed.",
  };
  /** @type {FetchCall[]} */
  const calls = [];

  const result = await invoke(["plan", "push"], {
    cwd,
    apiUrl: API_URL,
    fetchFunction: recordingFetch(problemResponse(problem, 412), calls),
  });

  const [call] = calls;
  assert(call);
  const headers = new Headers(call.init?.headers);
  assert.equal(headers.get("if-match"), FIRST_ETAG);
  assert.equal(headers.has("if-none-match"), false);
  assert.deepEqual(result, {
    status: 1,
    stdout: "",
    stderr: serverRejectedOutput(412, problem),
  });
  assert.deepEqual(stateSource(cwd), before);
  assert.equal(readState(cwd).foundation_plan_etag, FIRST_ETAG);
});

test("an update rejects a create status before changing local state", async (context) => {
  const cwd = await initializedDirectory(context);
  await successfulInitialPush(cwd);
  const before = stateSource(cwd);
  const result = await invoke(["plan", "push"], {
    cwd,
    apiUrl: API_URL,
    fetchFunction: recordingFetch(
      acceptedResponse(planSource(cwd), 201, SECOND_ETAG),
      [],
    ),
  });

  assert.deepEqual(result, {
    status: 1,
    stdout: "",
    stderr: requestOutcomeUnknownOutput(201),
  });
  assert.deepEqual(stateSource(cwd), before);
  assert.equal(readState(cwd).foundation_plan_etag, FIRST_ETAG);
});

test("422 diagnostics must identify the exact submitted bytes", async (context) => {
  const invalidBodies = [
    {
      source_sha256: "0".repeat(64),
      diagnostics: [
        { code: "wrong", severity: "error", message: "Wrong source." },
      ],
    },
    {
      source_sha256: "replace-with-request-digest",
      diagnostics: [
        { code: "warning", severity: "warning", message: "No error." },
      ],
    },
  ];

  for (const candidate of invalidBodies) {
    const cwd = await initializedDirectory(context);
    const before = stateSource(cwd);
    const body =
      candidate.source_sha256 === "replace-with-request-digest"
        ? { ...candidate, source_sha256: sha256(planSource(cwd)) }
        : candidate;
    const result = await invoke(["plan", "push"], {
      cwd,
      apiUrl: API_URL,
      fetchFunction: recordingFetch(jsonResponse(body, 422), []),
    });

    assert.deepEqual(result, {
      status: 1,
      stdout: "",
      stderr: requestOutcomeUnknownOutput(422),
    });
    assert.deepEqual(stateSource(cwd), before);
  }

  const cwd = await initializedDirectory(context);
  const before = stateSource(cwd);
  const diagnostic = {
    source_sha256: sha256(planSource(cwd)),
    diagnostics: [
      { code: "invalid", severity: "error", message: "Invalid Plan." },
    ],
  };
  const result = await invoke(["plan", "push"], {
    cwd,
    apiUrl: API_URL,
    fetchFunction: recordingFetch(
      new Response(JSON.stringify(diagnostic), {
        status: 422,
        headers: { "Content-Type": "text/plain" },
      }),
      [],
    ),
  });
  assert.deepEqual(result, {
    status: 1,
    stdout: "",
    stderr: requestOutcomeUnknownOutput(422),
  });
  assert.deepEqual(stateSource(cwd), before);
});

test("unverified HTTP failures have an ambiguous outcome without echoing their body", async (context) => {
  const cwd = await initializedDirectory(context);
  const before = stateSource(cwd);
  const result = await invoke(["plan", "push"], {
    cwd,
    apiUrl: API_URL,
    fetchFunction: recordingFetch(
      new Response("canary-secret-upstream-body", { status: 503 }),
      [],
    ),
  });

  assert.deepEqual(result, {
    status: 1,
    stdout: "",
    stderr: requestOutcomeUnknownOutput(503),
  });
  assert.doesNotMatch(result.stderr, /canary-secret/);
  assert.deepEqual(stateSource(cwd), before);
});

test("transport failures disclose the ambiguous outcome without leaking errors", async (context) => {
  const cwd = await initializedDirectory(context);
  const before = stateSource(cwd);
  const result = await invoke(["plan", "push"], {
    cwd,
    apiUrl: API_URL,
    fetchFunction: async () => {
      throw new TypeError("canary-secret-network-detail");
    },
  });

  assert.deepEqual(result, {
    status: 1,
    stdout: "",
    stderr: PLAN_PUSH_OUTCOME_UNKNOWN_ERROR,
  });
  assert.doesNotMatch(result.stderr, /canary-secret/);
  assert.deepEqual(stateSource(cwd), before);
});

test("response stream failures retain the received status without leaking errors", async (context) => {
  const cwd = await initializedDirectory(context);
  const before = stateSource(cwd);
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new Error("canary-secret-stream-detail"));
      },
    }),
    { status: 201 },
  );
  const result = await invoke(["plan", "push"], {
    cwd,
    apiUrl: API_URL,
    fetchFunction: recordingFetch(response, []),
  });

  assert.deepEqual(result, {
    status: 1,
    stdout: "",
    stderr: requestOutcomeUnknownOutput(201),
  });
  assert.doesNotMatch(result.stderr, /canary-secret/);
  assert.deepEqual(stateSource(cwd), before);
});

test("success responses are bound to the request before state changes", async (context) => {
  /** @type {((source: Buffer) => Response)[]} */
  const sourceMutators = [
    (source) => acceptedResponse(source, 200, FIRST_ETAG),
    (source) => acceptedResponse(source, 201, 'W/"weak"'),
    (source) => acceptedResponse(source, 201, `"${"x".repeat(1023)}"`),
    () => new Response(null, { status: 204 }),
    (source) =>
      new Response(JSON.stringify(acceptedBody(source)), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    (source) =>
      new Response(JSON.stringify(acceptedBody(source)), {
        status: 201,
        headers: { "Content-Type": "text/plain", ETag: FIRST_ETAG },
      }),
    (source) => {
      const body = acceptedBody(source);
      body.project.id = "01900000-0000-7000-8000-000000000399";
      return jsonResponse(body, 201, FIRST_ETAG);
    },
    (source) => {
      const body = acceptedBody(source);
      body.foundation_plan.source_sha256 = "0".repeat(64);
      return jsonResponse(body, 201, FIRST_ETAG);
    },
    (source) => {
      const body = acceptedBody(source);
      body.diagnostics = [
        { code: "canary", severity: "error", message: "canary-secret" },
      ];
      return jsonResponse(body, 201, FIRST_ETAG);
    },
  ];

  for (const makeResponse of sourceMutators) {
    const cwd = await initializedDirectory(context);
    const before = stateSource(cwd);
    const response = makeResponse(planSource(cwd));
    const result = await invoke(["plan", "push"], {
      cwd,
      apiUrl: API_URL,
      fetchFunction: recordingFetch(response, []),
    });

    assert.deepEqual(result, {
      status: 1,
      stdout: "",
      stderr: requestOutcomeUnknownOutput(response.status),
    });
    assert.doesNotMatch(result.stderr, /canary-secret/);
    assert.deepEqual(stateSource(cwd), before);
  }
});

test("warning diagnostics survive an accepted response", async (context) => {
  const cwd = await initializedDirectory(context);
  const warning = {
    code: "foundation_plan.example_warning",
    severity: "warning",
    message: "This Plan can be improved.",
  };
  const response = acceptedResponse(planSource(cwd), 201, FIRST_ETAG, [
    warning,
  ]);
  const result = await invoke(["plan", "push"], {
    cwd,
    apiUrl: API_URL,
    fetchFunction: recordingFetch(response, []),
    createTemporaryId: () => "warning",
  });

  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout).diagnostics, [warning]);
  assert.equal(readState(cwd).foundation_plan_etag, FIRST_ETAG);
});

test("success media types are compared case-insensitively", async (context) => {
  const cwd = await initializedDirectory(context);
  const source = planSource(cwd);
  const response = new Response(JSON.stringify(acceptedBody(source)), {
    status: 201,
    headers: {
      "Content-Type": "Application/JSON; Charset=UTF-8",
      ETag: FIRST_ETAG,
    },
  });
  const result = await invoke(["plan", "push"], {
    cwd,
    apiUrl: API_URL,
    fetchFunction: recordingFetch(response, []),
    createTemporaryId: () => "mixed-case-media-type",
  });

  assert.equal(result.status, 0);
  assert.equal(readState(cwd).foundation_plan_etag, FIRST_ETAG);
});

test("a push from an uninitialized directory makes no request", async (context) => {
  const cwd = temporaryDirectory(context);
  const result = await invoke(["plan", "push"], {
    cwd,
    apiUrl: API_URL,
    fetchFunction: inaccessibleFetch(),
  });

  assert.deepEqual(result, {
    status: 1,
    stdout: "",
    stderr: PLAN_PUSH_LOCAL_ERROR,
  });
});

test("local paths are bounded regular files beneath a real directory", async (context) => {
  /** @type {((cwd: string) => Promise<void>)[]} */
  const cases = [
    async (cwd) => rmSync(path.join(cwd, ".firstdraft", "state.json")),
    async (cwd) => {
      const plan = path.join(cwd, ".firstdraft", "foundation-plan.json");
      rmSync(plan);
      mkdirSync(plan);
    },
    async (cwd) =>
      writeFileSync(
        path.join(cwd, ".firstdraft", "foundation-plan.json"),
        Buffer.alloc(1024 * 1024 + 1),
      ),
  ];

  if (process.platform !== "win32") {
    cases.push(async (cwd) => {
      const plan = path.join(cwd, ".firstdraft", "foundation-plan.json");
      const target = path.join(cwd, "outside-plan.json");
      writeFileSync(target, "canary-secret-outside-plan");
      rmSync(plan);
      symlinkSync(target, plan);
    });
    cases.push(async (cwd) => {
      const state = statePath(cwd);
      const target = path.join(cwd, "outside-state.json");
      writeFileSync(target, stateSource(cwd));
      rmSync(state);
      symlinkSync(target, state);
    });
    cases.push(async (cwd) => {
      const directory = path.join(cwd, ".firstdraft");
      const target = path.join(cwd, "real-firstdraft");
      renameSync(directory, target);
      symlinkSync(target, directory, "dir");
    });
  }

  for (const mutate of cases) {
    const cwd = await initializedDirectory(context);
    await mutate(cwd);
    const result = await invoke(["plan", "push"], {
      cwd,
      apiUrl: API_URL,
      fetchFunction: inaccessibleFetch(),
    });

    assert.deepEqual(result, {
      status: 1,
      stdout: "",
      stderr: PLAN_PUSH_LOCAL_ERROR,
    });
    assert.doesNotMatch(result.stderr, /canary-secret/);
  }
});

test("invalid local state is rejected before exact Plan bytes leave the machine", async (context) => {
  const invalidStates = [
    Buffer.from("{"),
    Buffer.from([0xff]),
    Buffer.from("{}\n"),
    stateJson({ format: "other", project_id: PROJECT_ID }),
    stateJson({
      format: "firstdraft.cli-state/1",
      project_id: "01900000-0000-7000-8000-00000000030A",
    }),
    stateJson({
      format: "firstdraft.cli-state/1",
      project_id: PROJECT_ID,
      extra: "canary-secret",
    }),
    stateJson({
      format: "firstdraft.cli-state/1",
      project_id: PROJECT_ID,
      api_url: API_URL,
      foundation_plan_etag: 'W/"weak"',
    }),
    stateJson({
      format: "firstdraft.cli-state/1",
      project_id: PROJECT_ID,
      api_url: API_URL,
      foundation_plan_etag: `"${"x".repeat(1023)}"`,
    }),
    stateJson({
      format: "firstdraft.cli-state/1",
      project_id: PROJECT_ID,
      api_url: `${API_URL}/path`,
      foundation_plan_etag: FIRST_ETAG,
    }),
  ];

  for (const invalidState of invalidStates) {
    const cwd = await initializedDirectory(context);
    writeFileSync(statePath(cwd), invalidState);
    const result = await invoke(["plan", "push"], {
      cwd,
      apiUrl: API_URL,
      fetchFunction: inaccessibleFetch(),
    });

    assert.deepEqual(result, {
      status: 1,
      stdout: "",
      stderr: PLAN_PUSH_LOCAL_ERROR,
    });
    assert.doesNotMatch(result.stderr, /canary-secret/);
  }
});

test("the Plan is never parsed or reserialized locally", async (context) => {
  const cwd = await initializedDirectory(context);
  const invalidUtf8 = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]);
  writeFileSync(
    path.join(cwd, ".firstdraft", "foundation-plan.json"),
    invalidUtf8,
  );
  /** @type {FetchCall[]} */
  const calls = [];
  const diagnostic = {
    source_sha256: sha256(invalidUtf8),
    diagnostics: [
      {
        code: "foundation_plan.json.invalid",
        severity: "error",
        message: "The Foundation Plan is not valid UTF-8 JSON.",
      },
    ],
  };
  const result = await invoke(["plan", "push"], {
    cwd,
    apiUrl: API_URL,
    fetchFunction: recordingFetch(jsonResponse(diagnostic, 422), calls),
  });

  const [call] = calls;
  assert(call);
  assert(Buffer.isBuffer(call.init?.body));
  assert.deepEqual(call.init.body, invalidUtf8);
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stderr), {
    error: "server_rejected",
    detail: "First Draft rejected the Plan.",
    status: 422,
    response: diagnostic,
  });
});

test("failed atomic state replacements report the accepted ETag", async (context) => {
  for (const code of ["EACCES", "ERR_ACCESS_DENIED"]) {
    const cwd = await initializedDirectory(context);
    const before = stateSource(cwd);
    const fileSystem = {
      lstatSync,
      readFileSync,
      writeFileSync,
      renameSync() {
        const error = new Error("canary-secret-rename-detail");
        Object.assign(error, { code });
        throw error;
      },
    };
    const result = await invoke(["plan", "push"], {
      cwd,
      apiUrl: API_URL,
      planPushFileSystem: fileSystem,
      fetchFunction: recordingFetch(
        acceptedResponse(planSource(cwd), 201, FIRST_ETAG),
        [],
      ),
      createTemporaryId: () => code,
    });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.deepEqual(JSON.parse(result.stderr), {
      error: "local_state_not_saved",
      detail:
        "The Plan was accepted, but its ETag could not be saved. Do not push again until local state is repaired.",
      recovery_state: {
        format: "firstdraft.cli-state/1",
        project_id: PROJECT_ID,
        api_url: API_URL,
        foundation_plan_etag: FIRST_ETAG,
      },
    });
    assert.doesNotMatch(result.stderr, /canary-secret/);
    assert.deepEqual(stateSource(cwd), before);
    assert.equal(
      readFileSync(`${statePath(cwd)}.${code}.tmp`, "utf8"),
      `${JSON.stringify(
        {
          format: "firstdraft.cli-state/1",
          project_id: PROJECT_ID,
          api_url: API_URL,
          foundation_plan_etag: FIRST_ETAG,
        },
        null,
        2,
      )}\n`,
    );
  }
});

test("state serialization cannot create a file the CLI refuses to read", async (context) => {
  const cwd = await initializedDirectory(context);
  const before = stateSource(cwd);
  const oversizedApiUrl = `https://${"a".repeat(5000)}`;

  await assert.rejects(
    pushPlan({
      cwd,
      apiUrl: oversizedApiUrl,
      fetchFunction: recordingFetch(
        acceptedResponse(planSource(cwd), 201, FIRST_ETAG),
        [],
      ),
      createTemporaryId: () => "oversized-state",
    }),
    (error) => {
      assert(error instanceof PlanPushStateWriteError);
      assert.equal(error.recoveryState.api_url, oversizedApiUrl);
      assert.equal(error.recoveryState.foundation_plan_etag, FIRST_ETAG);
      return true;
    },
  );

  assert.deepEqual(stateSource(cwd), before);
  assert.deepEqual(readdirSync(path.join(cwd, ".firstdraft")).sort(), [
    ".gitignore",
    "foundation-plan.json",
    "state.json",
  ]);
});

test("oversized success responses stop before local state changes", async (context) => {
  const cwd = await initializedDirectory(context);
  const before = stateSource(cwd);
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([0x78]));
      },
      cancel() {
        cancelled = true;
      },
    }),
    {
      status: 201,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(2 * 1024 * 1024 + 1),
        ETag: FIRST_ETAG,
      },
    },
  );
  const result = await invoke(["plan", "push"], {
    cwd,
    apiUrl: API_URL,
    fetchFunction: recordingFetch(response, []),
  });

  assert.deepEqual(result, {
    status: 1,
    stdout: "",
    stderr: requestOutcomeUnknownOutput(201),
  });
  assert.deepEqual(stateSource(cwd), before);
  assert.equal(cancelled, true);
});

test("streamed oversized responses are cancelled at the byte cap", async (context) => {
  const cwd = await initializedDirectory(context);
  const before = stateSource(cwd);
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
        controller.enqueue(new Uint8Array(1024 * 1024));
        controller.enqueue(new Uint8Array([0x78]));
      },
      cancel() {
        cancelled = true;
      },
    }),
    {
      status: 201,
      headers: { "Content-Type": "application/json", ETag: FIRST_ETAG },
    },
  );
  const result = await invoke(["plan", "push"], {
    cwd,
    apiUrl: API_URL,
    fetchFunction: recordingFetch(response, []),
  });

  assert.deepEqual(result, {
    status: 1,
    stdout: "",
    stderr: requestOutcomeUnknownOutput(201),
  });
  assert.deepEqual(stateSource(cwd), before);
  assert.equal(cancelled, true);
});

test("the packaged executable completes a real local HTTP push", async (context) => {
  const cwd = await initializedDirectory(context);
  const source = planSource(cwd);
  let requestBody = Buffer.alloc(0);
  /** @type {import("node:http").IncomingHttpHeaders | undefined} */
  let requestHeaders;
  const server = createServer((request, response) => {
    /** @type {Buffer[]} */
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      requestBody = Buffer.concat(chunks);
      requestHeaders = request.headers;
      const body = JSON.stringify(acceptedBody(source));
      response.writeHead(201, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        ETag: FIRST_ETAG,
      });
      response.end(body);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  assert(address && typeof address !== "string");
  const apiUrl = `http://127.0.0.1:${address.port}`;
  const executable = fileURLToPath(
    new URL("../bin/firstdraft.js", import.meta.url),
  );
  const child = spawn(process.execPath, [executable, "plan", "push"], {
    cwd,
    env: {
      ...process.env,
      FIRSTDRAFT_API_TOKEN: API_TOKEN,
      FIRSTDRAFT_API_URL: apiUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const [status] = await once(child, "close");

  assert.equal(status, 0);
  assert.equal(stderr, "");
  assert.equal(JSON.parse(stdout).outcome, "created");
  assert.deepEqual(requestBody, source);
  assert.equal(requestHeaders?.["if-none-match"], "*");
  assert.equal(
    requestHeaders?.["content-type"],
    "application/vnd.firstdraft.foundation-plan+json",
  );
  assert.equal(requestHeaders?.authorization, `Bearer ${API_TOKEN}`);
  assert.equal(readState(cwd).api_url, apiUrl);
  assert.equal(readState(cwd).foundation_plan_etag, FIRST_ETAG);
});

/**
 * @param {readonly string[]} argv
 * @param {Partial<import("../src/cli.js").RunOptions>} [overrides]
 */
async function invoke(argv, overrides = {}) {
  let stdout = "";
  let stderr = "";
  const status = await run({
    argv,
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
    apiToken: API_TOKEN,
    ...overrides,
  });

  return { status, stdout, stderr };
}

/** @param {import("node:test").TestContext} context */
async function initializedDirectory(context) {
  const cwd = temporaryDirectory(context);
  const result = await invoke(
    [
      "plan",
      "init",
      "--application-key",
      "oscar_party",
      "--name",
      "Oscar Party",
    ],
    { cwd, createProjectId: () => PROJECT_ID },
  );
  assert.equal(result.status, 0);
  return cwd;
}

/** @param {string} cwd */
async function successfulInitialPush(cwd) {
  const result = await invoke(["plan", "push"], {
    cwd,
    apiUrl: API_URL,
    fetchFunction: recordingFetch(
      acceptedResponse(planSource(cwd), 201, FIRST_ETAG),
      [],
    ),
    createTemporaryId: () => "initial-setup",
  });
  assert.equal(result.status, 0);
}

/**
 * @param {Response} response
 * @param {FetchCall[]} calls
 * @returns {typeof globalThis.fetch}
 */
function recordingFetch(response, calls) {
  return async (input, init) => {
    calls.push({ input, init });
    return response;
  };
}

/** @returns {typeof globalThis.fetch} */
function inaccessibleFetch() {
  return async () => {
    throw new Error("network must not run");
  };
}

/** @returns {import("../src/commands/plan-push.js").PlanPushFileSystem} */
function inaccessiblePlanPushFileSystem() {
  return {
    lstatSync() {
      throw new Error("filesystem must not run");
    },
    readFileSync() {
      throw new Error("filesystem must not run");
    },
    renameSync() {
      throw new Error("filesystem must not run");
    },
    writeFileSync() {
      throw new Error("filesystem must not run");
    },
  };
}

/**
 * @param {Buffer} source
 * @param {number} status
 * @param {string} etag
 * @param {unknown[]} [diagnostics]
 */
function acceptedResponse(source, status, etag, diagnostics = []) {
  return jsonResponse(acceptedBody(source, diagnostics), status, etag);
}

/** @param {Buffer} source @param {unknown[]} [diagnostics] */
function acceptedBody(source, diagnostics = []) {
  return {
    project: { id: PROJECT_ID, graph_version: 1 },
    foundation_plan: {
      format: "firstdraft.foundation-plan.sketch/0.19",
      source_sha256: sha256(source),
    },
    diagnostics,
  };
}

/** @param {unknown} body @param {number} status @param {string} [etag] */
function jsonResponse(body, status, etag) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...(etag ? { ETag: etag } : {}),
    },
  });
}

/** @param {unknown} body @param {number} status */
function problemResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/problem+json" },
  });
}

/** @param {Buffer} source */
function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

/** @param {string} cwd */
function planSource(cwd) {
  return readFileSync(path.join(cwd, ".firstdraft", "foundation-plan.json"));
}

/** @param {string} cwd */
function stateSource(cwd) {
  return readFileSync(statePath(cwd));
}

/** @param {string} cwd */
function readState(cwd) {
  return JSON.parse(readFileSync(statePath(cwd), "utf8"));
}

/** @param {string} cwd */
function statePath(cwd) {
  return path.join(cwd, ".firstdraft", "state.json");
}

/** @param {Record<string, unknown>} state */
function stateJson(state) {
  return Buffer.from(`${JSON.stringify(state, null, 2)}\n`);
}

/** @param {unknown} value */
function jsonOutput(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** @param {number} status @param {unknown} [response] */
function serverRejectedOutput(status, response) {
  return jsonOutput({
    error: "server_rejected",
    detail: "First Draft rejected the Plan.",
    status,
    ...(response === undefined ? {} : { response }),
  });
}

/** @param {number} [status] */
function requestOutcomeUnknownOutput(status) {
  return jsonOutput({
    error: "request_outcome_unknown",
    detail:
      "The Plan may have been accepted, but the response could not be verified. Stop and reconcile before pushing again; local state was not changed.",
    ...(status === undefined ? {} : { status }),
  });
}

/** @param {import("node:test").TestContext} context */
function temporaryDirectory(context) {
  const directory = mkdtempSync(path.join(tmpdir(), "firstdraft-plan-push-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
