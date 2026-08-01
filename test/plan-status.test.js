import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { run } from "../src/cli.js";

/** @typedef {{input: string | URL | Request, init: RequestInit | undefined}} FetchCall */

const PROJECT_ID = "01900000-0000-7000-8000-000000000301";
const OTHER_PROJECT_ID = "01900000-0000-7000-8000-000000000302";
const ANALYSIS_ID = "01900000-0000-7000-8000-000000000401";
const OTHER_ANALYSIS_ID = "01900000-0000-7000-8000-000000000402";
const SUBJECT_ID = "01900000-0000-7000-8000-000000000501";
const API_URL = "https://api.example.test";
const API_TOKEN = `fd_${"a".repeat(43)}`;
const ETAG = '"opaque:plan-validator"';
const STARTED_AT = "2026-07-30T12:00:00.123Z";
const COMPLETED_AT = "2026-07-30T12:00:01.456Z";
const PLAN_STATUS_HELP = `First Draft CLI

Usage:
  firstdraft plan status [--wait]

Options:
      --wait  Poll until the current analysis reaches a terminal status
  -h, --help  Show help

Environment:
  FIRSTDRAFT_API_TOKEN  Authenticate API requests

The command uses only the API origin pinned by a successful plan push.
Without --wait, it makes exactly one status request.
`;
const INVALID_ARGUMENTS = jsonOutput({
  error: "invalid_arguments",
  detail: "Invalid arguments. Run 'firstdraft plan status --help' for usage.",
});
const LOCAL_INPUT_UNREADABLE = jsonOutput({
  error: "local_input_unreadable",
  detail:
    "Could not read valid local First Draft state. No network request was made. Run 'firstdraft plan init' if this directory is not initialized; otherwise repair the private state before retrying.",
});
const PROJECT_NOT_PUSHED = jsonOutput({
  error: "project_not_pushed",
  detail:
    "The local Foundation Plan has not been pushed successfully. Run 'firstdraft plan push' before requesting analysis status.",
});

test("plan status help has no local or network prerequisites", async () => {
  const inaccessible = () => {
    throw new Error("help must not access dependencies");
  };

  for (const argv of [
    ["plan", "status", "--help"],
    ["plan", "status", "-h"],
    ["plan", "status", "--help", "--help"],
    ["plan", "status", "--wait", "--help"],
  ]) {
    assert.deepEqual(
      await invoke(argv, {
        fetchFunction: inaccessible,
        planPushFileSystem: inaccessibleFileSystem(),
      }),
      { status: 0, stdout: PLAN_STATUS_HELP, stderr: "" },
    );
  }
});

test("plan status validates arguments before local or network access", async () => {
  for (const argv of [
    ["plan", "status", "canary-secret-positional"],
    ["plan", "status", "--canary-secret-option"],
    ["plan", "status", "--wait", "--wait"],
  ]) {
    const result = await invoke(argv, {
      fetchFunction: inaccessibleFetch(),
      planPushFileSystem: inaccessibleFileSystem(),
    });

    assert.deepEqual(result, {
      status: 2,
      stdout: "",
      stderr: INVALID_ARGUMENTS,
    });
    assert.doesNotMatch(result.stderr, /canary-secret/);
  }
});

test("plan status makes one bounded GET to only the pinned origin", async (context) => {
  const cwd = remoteDirectory(context);
  /** @type {FetchCall[]} */
  const calls = [];
  const signal = new AbortController().signal;
  /** @type {number[]} */
  const requestTimeouts = [];
  const body = analysisBody("processing");
  const result = await invoke(["plan", "status"], {
    cwd,
    apiUrl: "https://canary-secret.example",
    fetchFunction: recordingFetch([jsonResponse(body)], calls),
    createRequestSignal: (timeoutMs) => {
      if (timeoutMs === undefined) throw new Error("missing request timeout");
      requestTimeouts.push(timeoutMs);
      return signal;
    },
  });

  assert.deepEqual(result, {
    status: 0,
    stdout: jsonOutput(body),
    stderr: "",
  });
  assert.deepEqual(requestTimeouts, [30_000]);
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert(call);
  assert.equal(
    String(call.input),
    `${API_URL}/v1/projects/${PROJECT_ID}/analysis`,
  );
  assert.equal(call.init?.method, "GET");
  assert.equal(call.init?.redirect, "error");
  assert.equal(call.init?.signal, signal);
  assert.deepEqual(
    new Headers(call.init?.headers),
    new Headers({
      Accept: "application/json, application/problem+json",
      Authorization: `Bearer ${API_TOKEN}`,
    }),
  );
  assert.equal(call.init?.body, undefined);
  assert.doesNotMatch(result.stdout, /api\.example|opaque|canary-secret/);
});

test("additive response fields are ignored rather than leaked or rejected", async (context) => {
  const cwd = remoteDirectory(context);
  const warning = diagnostic("warning");
  const expected = analysisBody("valid", {
    analysis: { diagnostics: [warning] },
  });
  const extended = {
    ...expected,
    canary: "canary-secret-envelope",
    project: {
      ...expected.project,
      canary: "canary-secret-project",
    },
    analysis: {
      ...expected.analysis,
      canary: "canary-secret-analysis",
      diagnostics: [
        {
          ...warning,
          canary: "canary-secret-diagnostic",
          location: {
            ...warning.location,
            canary: "canary-secret-location",
          },
          subject: {
            ...warning.subject,
            canary: "canary-secret-subject",
          },
          related_locations: [
            {
              ...warning.related_locations[0],
              canary: "canary-secret-related-location",
            },
          ],
        },
      ],
    },
  };
  const result = await invoke(["plan", "status"], {
    cwd,
    fetchFunction: recordingFetch([jsonResponse(extended)], []),
  });

  assert.deepEqual(result, {
    status: 0,
    stdout: jsonOutput(expected),
    stderr: "",
  });
  assert.doesNotMatch(result.stdout, /canary-secret/);
});

test("diagnostics preserve each supported optional subject shape", async (context) => {
  for (const subject of [
    null,
    { kind: "application", readable_path: "application" },
  ]) {
    const cwd = remoteDirectory(context);
    const body = analysisBody("valid", {
      analysis: { diagnostics: [diagnostic("warning", { subject })] },
    });
    const result = await invoke(["plan", "status"], {
      cwd,
      fetchFunction: recordingFetch([jsonResponse(body)], []),
    });

    assert.deepEqual(result, {
      status: 0,
      stdout: jsonOutput(body),
      stderr: "",
    });
  }
});

test("all validated analysis states are command results rather than transport failures", async (context) => {
  for (const status of [
    "processing",
    "valid",
    "issues_found",
    "analysis_failed",
    "superseded",
  ]) {
    const cwd = remoteDirectory(context);
    const body = analysisBody(status);
    const result = await invoke(["plan", "status"], {
      cwd,
      fetchFunction: recordingFetch([jsonResponse(body)], []),
    });

    assert.deepEqual(result, {
      status: 0,
      stdout: jsonOutput(body),
      stderr: "",
    });
  }
});

test("an initialized but unpushed Plan explains the required recovery", async (context) => {
  const cwd = localDirectory(context, {
    format: "firstdraft.cli-state/1",
    project_id: PROJECT_ID,
  });

  const result = await invoke(["plan", "status"], {
    cwd,
    apiUrl: "https://canary-secret.example",
    fetchFunction: inaccessibleFetch(),
  });

  assert.deepEqual(result, {
    status: 1,
    stdout: "",
    stderr: PROJECT_NOT_PUSHED,
  });
  assert.doesNotMatch(result.stderr, /canary-secret/);
});

test("invalid private state never selects a network destination", async (context) => {
  const cases = [
    Buffer.from("not json"),
    Buffer.from([0xff]),
    stateSource({
      format: "firstdraft.cli-state/1",
      project_id: PROJECT_ID,
      api_url: "http://canary-secret.example",
      foundation_plan_etag: ETAG,
    }),
    stateSource({
      format: "firstdraft.cli-state/1",
      project_id: PROJECT_ID,
      api_url: API_URL,
    }),
    stateSource({
      format: "firstdraft.cli-state/1",
      project_id: PROJECT_ID,
      api_url: API_URL,
      foundation_plan_etag: ETAG,
      canary: "canary-secret-extra-key",
    }),
    Buffer.alloc(4097, 0x20),
  ];

  for (const source of cases) {
    const cwd = temporaryDirectory(context);
    mkdirSync(path.join(cwd, ".firstdraft"));
    writeFileSync(path.join(cwd, ".firstdraft", "state.json"), source);
    const result = await invoke(["plan", "status"], {
      cwd,
      fetchFunction: inaccessibleFetch(),
    });

    assert.deepEqual(result, {
      status: 1,
      stdout: "",
      stderr: LOCAL_INPUT_UNREADABLE,
    });
    assert.doesNotMatch(result.stderr, /canary-secret/);
  }
});

test("missing paths and state symlinks are rejected without following them", async (context) => {
  const missing = temporaryDirectory(context);
  assert.deepEqual(
    await invoke(["plan", "status"], {
      cwd: missing,
      fetchFunction: inaccessibleFetch(),
    }),
    { status: 1, stdout: "", stderr: LOCAL_INPUT_UNREADABLE },
  );

  const target = remoteDirectory(context);
  const symlinked = temporaryDirectory(context);
  mkdirSync(path.join(symlinked, ".firstdraft"));
  symlinkSync(
    path.join(target, ".firstdraft", "state.json"),
    path.join(symlinked, ".firstdraft", "state.json"),
  );
  assert.deepEqual(
    await invoke(["plan", "status"], {
      cwd: symlinked,
      fetchFunction: inaccessibleFetch(),
    }),
    { status: 1, stdout: "", stderr: LOCAL_INPUT_UNREADABLE },
  );
});

test("wait polls sequentially until the same analysis becomes valid", async (context) => {
  const cwd = remoteDirectory(context);
  const processing = analysisBody("processing");
  const started = analysisBody("processing", {
    analysis: { started_at: STARTED_AT },
  });
  const valid = analysisBody("valid");
  /** @type {FetchCall[]} */
  const calls = [];
  /** @type {string[]} */
  const events = [];
  const responses = [processing, started, valid].map((body) =>
    jsonResponse(body),
  );
  let active = false;
  const result = await invoke(["plan", "status", "--wait"], {
    cwd,
    fetchFunction: async (input, init) => {
      assert.equal(active, false, "poll requests must not overlap");
      active = true;
      events.push("fetch");
      calls.push({ input, init });
      const response = responses.shift();
      assert(response);
      active = false;
      return response;
    },
    planStatusSleep: async (delayMs) => {
      assert.equal(active, false);
      assert.equal(delayMs, 1_000);
      events.push("sleep");
    },
  });

  assert.deepEqual(result, {
    status: 0,
    stdout: jsonOutput(valid),
    stderr: "",
  });
  assert.deepEqual(events, ["fetch", "sleep", "fetch", "sleep", "fetch"]);
  assert.equal(calls.length, 3);
  assert(calls.every((call) => String(call.input).startsWith(API_URL)));
});

test("wait stops on each terminal analysis status without another poll", async (context) => {
  for (const status of [
    "valid",
    "issues_found",
    "analysis_failed",
    "superseded",
  ]) {
    const cwd = remoteDirectory(context);
    const terminal = analysisBody(status);
    let sleeps = 0;
    const result = await invoke(["plan", "status", "--wait"], {
      cwd,
      fetchFunction: recordingFetch(
        [jsonResponse(analysisBody("processing")), jsonResponse(terminal)],
        [],
      ),
      planStatusSleep: async () => {
        sleeps += 1;
      },
    });

    assert.deepEqual(result, {
      status: 0,
      stdout: jsonOutput(terminal),
      stderr: "",
    });
    assert.equal(sleeps, 1);
  }
});

test("wait stops on its first failed read instead of repairing it speculatively", async (context) => {
  const processing = analysisBody("processing");

  {
    const cwd = remoteDirectory(context);
    let requests = 0;
    let sleeps = 0;
    const network = await invoke(["plan", "status", "--wait"], {
      cwd,
      fetchFunction: async () => {
        requests += 1;
        if (requests === 1) return jsonResponse(processing);

        throw new Error("canary-secret transient failure");
      },
      planStatusSleep: async () => {
        sleeps += 1;
      },
    });

    assert.equal(JSON.parse(network.stderr).error, "status_unavailable");
    assert.equal(requests, 2);
    assert.equal(sleeps, 1);
    assert.doesNotMatch(network.stderr, /canary-secret/);
  }

  {
    const cwd = remoteDirectory(context);
    const problem = {
      type: "about:blank",
      title: "Service Unavailable",
      status: 503,
      code: "service_unavailable",
      detail: "Analysis status is temporarily unavailable.",
    };
    let sleeps = 0;
    const rejected = await invoke(["plan", "status", "--wait"], {
      cwd,
      fetchFunction: recordingFetch(
        [jsonResponse(processing), problemResponse(problem, 503)],
        [],
      ),
      planStatusSleep: async () => {
        sleeps += 1;
      },
    });

    assert.deepEqual(JSON.parse(rejected.stderr), {
      error: "server_rejected",
      detail: "First Draft rejected the analysis status request.",
      status: 503,
      response: problem,
    });
    assert.equal(sleeps, 1);
  }
});

test("wait does not follow a replacement analysis silently", async (context) => {
  const cwd = remoteDirectory(context);
  const first = analysisBody("processing");
  const replacement = analysisBody("valid", {
    project: { graph_version: 2 },
    analysis: { id: OTHER_ANALYSIS_ID, graph_version: 2 },
  });
  const result = await invoke(["plan", "status", "--wait"], {
    cwd,
    fetchFunction: recordingFetch(
      [jsonResponse(first), jsonResponse(replacement)],
      [],
    ),
    planStatusSleep: async () => undefined,
  });

  assert.deepEqual(result, {
    status: 1,
    stdout: "",
    stderr: jsonOutput({
      error: "analysis_changed",
      detail:
        "The current analysis changed while waiting. Run 'firstdraft plan status --wait' again to follow the latest analysis.",
      current: replacement,
    }),
  });
});

test("wait has a fixed overall deadline and reports the last verified state", async (context) => {
  const cwd = remoteDirectory(context);
  const processing = analysisBody("processing");
  let clock = 0;
  let requests = 0;
  let sleeps = 0;
  /** @type {number[]} */
  const requestTimeouts = [];
  const result = await invoke(["plan", "status", "--wait"], {
    cwd,
    fetchFunction: async () => {
      requests += 1;
      return jsonResponse(processing);
    },
    createRequestSignal: (timeoutMs) => {
      if (timeoutMs === undefined) throw new Error("missing request timeout");
      requestTimeouts.push(timeoutMs);
      return new AbortController().signal;
    },
    planStatusNow: () => clock,
    planStatusSleep: async (delayMs) => {
      sleeps += 1;
      clock += delayMs;
    },
  });

  assert.deepEqual(result, {
    status: 1,
    stdout: "",
    stderr: jsonOutput({
      error: "wait_timed_out",
      detail:
        "The current analysis is still processing after the bounded wait. Run 'firstdraft plan status --wait' again to continue waiting.",
      current: processing,
    }),
  });
  assert.equal(requests, 120);
  assert.equal(sleeps, 120);
  assert.equal(clock, 120_000);
  assert.equal(requestTimeouts.at(0), 30_000);
  assert.equal(requestTimeouts.at(-1), 1_000);
  assert(requestTimeouts.every((timeout) => timeout >= 1 && timeout <= 30_000));
});

test("a response body failure at the wait deadline reports the last verified state", async (context) => {
  const cwd = remoteDirectory(context);
  const processing = analysisBody("processing");
  let clock = 0;
  const failingBody = new ReadableStream({
    pull(controller) {
      clock = 120_000;
      controller.error(new Error("canary-secret body deadline"));
    },
  });
  const result = await invoke(["plan", "status", "--wait"], {
    cwd,
    fetchFunction: recordingFetch(
      [
        jsonResponse(processing),
        new Response(failingBody, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ],
      [],
    ),
    createRequestSignal: () => new AbortController().signal,
    planStatusNow: () => clock,
    planStatusSleep: async (delayMs) => {
      clock += delayMs;
    },
  });

  assert.deepEqual(result, {
    status: 1,
    stdout: "",
    stderr: jsonOutput({
      error: "wait_timed_out",
      detail:
        "The current analysis is still processing after the bounded wait. Run 'firstdraft plan status --wait' again to continue waiting.",
      current: processing,
    }),
  });
  assert.doesNotMatch(result.stderr, /canary-secret/);
});

test("validated problem responses are whitelisted for agent recovery", async (context) => {
  const cwd = remoteDirectory(context);
  const problem = {
    type: "about:blank",
    title: "Not Found",
    status: 404,
    code: "analysis_not_found",
    detail: "This Project does not have a current analysis run.",
    canary: "canary-secret-problem-field",
  };
  const result = await invoke(["plan", "status"], {
    cwd,
    fetchFunction: recordingFetch([problemResponse(problem, 404)], []),
  });

  assert.deepEqual(result, {
    status: 1,
    stdout: "",
    stderr: jsonOutput({
      error: "server_rejected",
      detail: "First Draft rejected the analysis status request.",
      status: 404,
      response: {
        type: "about:blank",
        title: problem.title,
        status: 404,
        code: problem.code,
        detail: problem.detail,
      },
    }),
  });
  assert.doesNotMatch(result.stderr, /canary-secret/);
});

test("missing credentials and a validated 401 use one stable authentication error", async (context) => {
  const cwd = remoteDirectory(context);
  let requests = 0;
  const missing = await invoke(["plan", "status"], {
    cwd,
    apiToken: "",
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
  assert.equal(requests, 0);

  const problem = {
    type: "about:blank",
    title: "Unauthorized",
    status: 401,
    code: "authentication_required",
    detail: "Provide a valid API token.",
    canary: "canary-secret-response-field",
  };
  const rejected = await invoke(["plan", "status"], {
    cwd,
    fetchFunction: recordingFetch([problemResponse(problem, 401)], []),
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

test("invalid HTTP responses are non-retryable and never expose their body", async (context) => {
  for (const response of [
    new Response("canary-secret-json", {
      status: 404,
      headers: { "Content-Type": "application/json" },
    }),
    new Response("canary-secret-problem", {
      status: 404,
      headers: { "Content-Type": "application/problem+json" },
    }),
    new Response(null, { status: 204 }),
    new Response("canary-secret-redirect", {
      status: 302,
      headers: { Location: "https://canary-secret.example" },
    }),
  ]) {
    const cwd = remoteDirectory(context);
    const result = await invoke(["plan", "status"], {
      cwd,
      fetchFunction: recordingFetch([response], []),
    });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error, "invalid_server_response");
    assert.equal(JSON.parse(result.stderr).status, response.status);
    assert.doesNotMatch(result.stderr, /canary-secret/);
  }
});

test("network, redirect, and response-stream failures advise bounded retries", async (context) => {
  const cwd = remoteDirectory(context);
  const calls = [];
  const network = await invoke(["plan", "status"], {
    cwd,
    fetchFunction: async (input, init) => {
      calls.push({ input, init });
      assert.equal(init?.redirect, "error");
      throw new TypeError("canary-secret redirect or network failure");
    },
  });
  assert.deepEqual(JSON.parse(network.stderr), {
    error: "status_unavailable",
    detail:
      "Could not verify the current analysis status. Retry this read-only request a bounded number of times; if it keeps failing, inspect the API origin pinned in .firstdraft/state.json.",
  });
  assert.doesNotMatch(network.stderr, /canary-secret/);
  assert.equal(calls.length, 1);

  const stream = new ReadableStream({
    pull(controller) {
      controller.error(new Error("canary-secret stream failure"));
    },
  });
  const streamed = await invoke(["plan", "status"], {
    cwd,
    fetchFunction: recordingFetch(
      [
        new Response(stream, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ],
      [],
    ),
  });
  assert.equal(JSON.parse(streamed.stderr).error, "status_unavailable");
  assert.equal(JSON.parse(streamed.stderr).status, 200);
  assert.doesNotMatch(streamed.stderr, /canary-secret/);
});

test("success responses are rejected unless every contract field is valid", async (context) => {
  const valid = analysisBody("valid");
  const cases = [
    { name: "wrong media type", response: textResponse(JSON.stringify(valid)) },
    { name: "invalid UTF-8", response: byteResponse(Uint8Array.of(0xff)) },
    { name: "non-object", body: [] },
    {
      name: "wrong Project",
      body: analysisBody("valid", { project: { id: OTHER_PROJECT_ID } }),
    },
    {
      name: "nonpositive Project generation",
      body: analysisBody("valid", {
        project: { graph_version: 0 },
        analysis: { graph_version: 0 },
      }),
    },
    {
      name: "mismatched generation",
      body: analysisBody("valid", { analysis: { graph_version: 2 } }),
    },
    {
      name: "UUIDv4 analysis identity",
      body: analysisBody("valid", {
        analysis: { id: "550e8400-e29b-41d4-a716-446655440000" },
      }),
    },
    {
      name: "empty analyzer release",
      body: analysisBody("valid", { analysis: { analyzer_release: "" } }),
    },
    {
      name: "unknown status",
      body: analysisBody("valid", { analysis: { status: "done" } }),
    },
    {
      name: "non-array diagnostics",
      body: analysisBody("valid", { analysis: { diagnostics: {} } }),
    },
    {
      name: "incomplete diagnostic",
      body: analysisBody("valid", {
        analysis: { diagnostics: [{ code: "incomplete" }] },
      }),
    },
    {
      name: "invalid pointer escape",
      body: analysisBody("valid", {
        analysis: {
          diagnostics: [
            diagnostic("warning", {
              location: { source_pointer: "/bad~2pointer" },
            }),
          ],
        },
      }),
    },
    {
      name: "invalid coordinate",
      body: analysisBody("valid", {
        analysis: {
          diagnostics: [
            diagnostic("warning", { location: { line: 0, column: 1 } }),
          ],
        },
      }),
    },
    {
      name: "UUIDv4 diagnostic subject",
      body: analysisBody("valid", {
        analysis: {
          diagnostics: [
            diagnostic("warning", {
              subject: {
                kind: "entity",
                readable_path: "movie",
                subject_uuid: "550e8400-e29b-41d4-a716-446655440000",
              },
            }),
          ],
        },
      }),
    },
    {
      name: "impossible timestamp",
      body: analysisBody("valid", {
        analysis: { completed_at: "2026-02-30T12:00:01Z" },
      }),
    },
    {
      name: "processing completion timestamp",
      body: analysisBody("processing", {
        analysis: { completed_at: COMPLETED_AT },
      }),
    },
    {
      name: "terminal without completion timestamp",
      body: analysisBody("valid", { analysis: { completed_at: null } }),
    },
    {
      name: "completion before start",
      body: analysisBody("valid", {
        analysis: {
          started_at: COMPLETED_AT,
          completed_at: STARTED_AT,
        },
      }),
    },
    {
      name: "valid analysis with an error",
      body: analysisBody("valid", {
        analysis: { diagnostics: [diagnostic("error")] },
      }),
    },
    {
      name: "issues status without an error",
      body: analysisBody("issues_found", {
        analysis: { diagnostics: [diagnostic("warning")] },
      }),
    },
  ];

  for (const candidate of cases) {
    const cwd = remoteDirectory(context);
    const response =
      candidate.response ??
      jsonResponse(candidate.body, 200, {
        "X-Canary": "canary-secret-response",
      });
    const result = await invoke(["plan", "status"], {
      cwd,
      fetchFunction: recordingFetch([response], []),
    });

    assert.equal(result.status, 1, candidate.name);
    assert.equal(result.stdout, "", candidate.name);
    assert.deepEqual(
      JSON.parse(result.stderr),
      {
        error: "invalid_server_response",
        detail:
          "First Draft returned an invalid analysis response. Retrying the unchanged request will not repair this protocol mismatch.",
        status: 200,
      },
      candidate.name,
    );
    assert.doesNotMatch(result.stderr, /canary-secret/, candidate.name);
  }
});

test("valid timestamps include offsets, lowercase RFC 3339 markers, and leap seconds", async (context) => {
  const cwd = remoteDirectory(context);
  const body = analysisBody("valid", {
    analysis: {
      started_at: "2016-12-31t23:59:60z",
      completed_at: "2017-01-01T01:00:00+01:00",
    },
  });
  const result = await invoke(["plan", "status"], {
    cwd,
    fetchFunction: recordingFetch([jsonResponse(body)], []),
  });

  assert.deepEqual(result, {
    status: 0,
    stdout: jsonOutput(body),
    stderr: "",
  });
});

test("declared and streamed response sizes are bounded", async (context) => {
  const cwd = remoteDirectory(context);
  let declaredCancelled = false;
  const declaredStream = new ReadableStream({
    cancel() {
      declaredCancelled = true;
    },
  });
  const declared = await invoke(["plan", "status"], {
    cwd,
    fetchFunction: recordingFetch(
      [
        new Response(declaredStream, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(2 * 1024 * 1024 + 1),
          },
        }),
      ],
      [],
    ),
  });
  assert.equal(JSON.parse(declared.stderr).error, "invalid_server_response");
  assert.equal(declaredCancelled, true);

  let streamedCancelled = false;
  const streamedBody = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
    },
    cancel() {
      streamedCancelled = true;
    },
  });
  const streamed = await invoke(["plan", "status"], {
    cwd,
    fetchFunction: recordingFetch(
      [
        new Response(streamedBody, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ],
      [],
    ),
  });
  assert.equal(JSON.parse(streamed.stderr).error, "invalid_server_response");
  assert.equal(streamedCancelled, true);
});

test("the packaged executable polls a real local analysis endpoint", async (context) => {
  let requestMethod;
  /** @type {import("node:http").IncomingHttpHeaders | undefined} */
  let requestHeaders;
  const body = analysisBody("valid");
  const server = createServer((request, response) => {
    requestMethod = request.method;
    requestHeaders = request.headers;
    const source = JSON.stringify(body);
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(source),
    });
    response.end(source);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  assert(address && typeof address !== "string");
  const cwd = localDirectory(
    context,
    remoteState(`http://127.0.0.1:${address.port}`),
  );
  const executable = fileURLToPath(
    new URL("../bin/firstdraft.js", import.meta.url),
  );
  const child = spawn(
    process.execPath,
    [executable, "plan", "status", "--wait"],
    {
      cwd,
      env: {
        ...process.env,
        FIRSTDRAFT_API_TOKEN: API_TOKEN,
        FIRSTDRAFT_API_URL: "https://canary-secret.example",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const [status] = await once(child, "close");

  assert.equal(status, 0);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), body);
  assert.equal(requestMethod, "GET");
  assert.equal(
    requestHeaders?.accept,
    "application/json, application/problem+json",
  );
  assert.equal(requestHeaders?.authorization, `Bearer ${API_TOKEN}`);
  assert.doesNotMatch(stdout, /canary-secret/);
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
function remoteDirectory(context) {
  return localDirectory(context, remoteState(API_URL));
}

/** @param {string} apiUrl */
function remoteState(apiUrl) {
  return {
    format: "firstdraft.cli-state/1",
    project_id: PROJECT_ID,
    api_url: apiUrl,
    foundation_plan_etag: ETAG,
  };
}

/**
 * @param {import("node:test").TestContext} context
 * @param {Record<string, unknown>} state
 */
function localDirectory(context, state) {
  const cwd = temporaryDirectory(context);
  mkdirSync(path.join(cwd, ".firstdraft"));
  writeFileSync(
    path.join(cwd, ".firstdraft", "state.json"),
    stateSource(state),
    {
      mode: 0o600,
    },
  );
  return cwd;
}

/**
 * @param {string} status
 * @param {{project?: Record<string, unknown>, analysis?: Record<string, unknown>}} [overrides]
 */
function analysisBody(status, overrides = {}) {
  const terminal = status !== "processing";
  const diagnostics = status === "issues_found" ? [diagnostic("error")] : [];
  return {
    project: {
      id: PROJECT_ID,
      graph_version: 1,
      ...overrides.project,
    },
    analysis: {
      id: ANALYSIS_ID,
      graph_version: 1,
      analyzer_release: "scalar-rails/1",
      status,
      diagnostics,
      started_at: terminal ? STARTED_AT : null,
      completed_at: terminal ? COMPLETED_AT : null,
      ...overrides.analysis,
    },
  };
}

/**
 * @param {"error" | "warning"} severity
 * @param {Record<string, unknown>} [overrides]
 */
function diagnostic(severity, overrides = {}) {
  return {
    code: "foundation_plan.analysis.example",
    severity,
    message: "The Plan has an example diagnostic.",
    location: { source_pointer: "/application/entities/0" },
    subject: {
      kind: "entity",
      readable_path: "movie",
      subject_uuid: SUBJECT_ID,
    },
    related_locations: [{ line: 1, column: 2 }],
    suggestions: ["Choose a supported value."],
    ...overrides,
  };
}

/**
 * @param {Response[]} responses
 * @param {FetchCall[]} calls
 * @returns {typeof globalThis.fetch}
 */
function recordingFetch(responses, calls) {
  return async (input, init) => {
    calls.push({ input, init });
    const response = responses.shift();
    assert(response, "unexpected extra request");
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
function inaccessibleFileSystem() {
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
 * @param {unknown} body
 * @param {number} [status]
 * @param {Record<string, string>} [headers]
 */
function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** @param {unknown} body @param {number} status */
function problemResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/problem+json" },
  });
}

/** @param {string} body */
function textResponse(body) {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}

/** @param {Uint8Array} body */
function byteResponse(body) {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** @param {Record<string, unknown>} state */
function stateSource(state) {
  return Buffer.from(`${JSON.stringify(state, null, 2)}\n`);
}

/** @param {unknown} value */
function jsonOutput(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** @param {import("node:test").TestContext} context */
function temporaryDirectory(context) {
  const directory = mkdtempSync(path.join(tmpdir(), "firstdraft-plan-status-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
