import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { run } from "../src/cli.js";
import { RAILS_TARGET_PROFILE } from "../src/compilation-artifact.js";

const PROJECT_ID = "01900000-0000-7000-8000-000000004001";
const COMPILATION_ID = "01900000-0000-7000-8000-000000004002";
const ANALYSIS_ID = "01900000-0000-7000-8000-000000004004";
const API_TOKEN = `fd_canary${"c".repeat(37)}`;
const API_URL = "https://api.example.test";
const CREATED_AT = "2026-10-04T12:00:00.000000Z";
const STARTED_AT = "2026-10-04T12:00:01.000000Z";
const COMPLETED_AT = "2026-10-04T12:30:00.000000Z";
const STATUS_PATH = `/v1/projects/${PROJECT_ID}/compilations/${COMPILATION_ID}`;
const CANCEL_PATH = `${STATUS_PATH}/cancel`;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const COMPILATION_CANCEL_HELP = `First Draft CLI

Usage:
  firstdraft compilation cancel <compilation-id>

Options:
      --staging  Use staging; reject a different saved origin
  -h, --help     Show help

Environment:
  FIRSTDRAFT_API_TOKEN          Authenticate production or custom API origins
  FIRSTDRAFT_STAGING_API_TOKEN  Authenticate staging.firstdraft.com

The command asks First Draft once to cancel a queued or running Compilation of
the local Project and prints the cancelled Compilation. Cancelling it again
prints the same result; a succeeded or failed Compilation is not changed.
Once cancelled, it no longer blocks plan push or plan compile.
`;

test("compilation cancel help is printed on stdout and listed in its group", async () => {
  for (const argv of [
    ["compilation", "cancel", "--help"],
    ["compilation", "cancel", "-h"],
  ]) {
    const result = await invoke(argv, { cwd: process.cwd() });
    assert.deepEqual(result, {
      status: 0,
      stdout: COMPILATION_CANCEL_HELP,
      stderr: "",
    });
  }

  const group = await invoke(["compilation", "--help"], {
    cwd: process.cwd(),
  });
  assert.equal(group.status, 0);
  assert.match(
    group.stdout,
    /^ {2}cancel {4}Cancel one queued or running Compilation$/m,
  );
});

test("compilation cancel makes one POST and prints the cancelled Compilation", async (context) => {
  for (const startedAt of [null, STARTED_AT]) {
    const cwd = projectDirectory(context);
    /** @type {FetchCall[]} */
    const calls = [];
    const body = cancelledBody({ started_at: startedAt });
    const result = await invoke(["compilation", "cancel", COMPILATION_ID], {
      cwd,
      fetchFunction: sequenceFetch([jsonResponse(body)], calls),
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), body);
    assert.equal(result.stderr, "");
    assert.equal(calls.length, 1);
    assert.equal(String(calls[0]?.input), `${API_URL}${CANCEL_PATH}`);
    assert.equal(calls[0]?.init?.method, "POST");
    assert.equal(calls[0]?.init?.body, undefined);
    assert.equal(calls[0]?.init?.redirect, "error");
    const headers = new Headers(calls[0]?.init?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${API_TOKEN}`);
    assert.equal(
      headers.get("accept"),
      "application/json, application/problem+json",
    );
    assert.equal(headers.get("if-match"), null);
    assertNoSecrets(result);
  }
});

test("a rejected cancellation reports the validated Service problem", async (context) => {
  for (const problem of [
    {
      status: 409,
      code: "compilation_not_cancellable",
      detail: "A succeeded Compilation cannot be cancelled.",
    },
    {
      status: 404,
      code: "compilation_not_found",
      detail: "This Project does not contain that Compilation.",
    },
    {
      status: 404,
      code: "project_not_found",
      detail: "This Project does not exist.",
    },
  ]) {
    const result = await invoke(["compilation", "cancel", COMPILATION_ID], {
      cwd: projectDirectory(context),
      fetchFunction: sequenceFetch([problemResponse(problem)]),
    });

    assertHandledFailure(result, "compilation_cancel_rejected");
    const envelope = JSON.parse(result.stderr);
    assert.equal(envelope.status, problem.status);
    assert.deepEqual(envelope.response, {
      type: "about:blank",
      title: problem.status === 409 ? "Conflict" : "Not Found",
      ...problem,
    });
    assert.match(envelope.detail, /nothing was cancelled/);
    assertNoSecrets(result);
  }
});

test("an unconfirmed cancellation is reported as safe to repeat", async (context) => {
  const cases = [
    {
      response: async () => {
        throw new TypeError("canary network failure");
      },
      status: undefined,
      problem: false,
    },
    {
      response: async () =>
        problemResponse({
          status: 503,
          code: "service_unavailable",
          detail: "Try again later.",
        }),
      status: 503,
      problem: true,
    },
    {
      response: async () =>
        problemResponse({
          status: 408,
          code: "request_timeout",
          detail: "The request timed out.",
        }),
      status: 408,
      problem: true,
    },
    {
      response: async () =>
        new Response("canary upstream failure", {
          status: 502,
          headers: { "Content-Type": "text/html" },
        }),
      status: 502,
      problem: false,
    },
    {
      response: async () =>
        new Response(JSON.stringify({ error: "canary" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        }),
      status: 409,
      problem: false,
    },
  ];
  for (const { response, status, problem } of cases) {
    const result = await invoke(["compilation", "cancel", COMPILATION_ID], {
      cwd: projectDirectory(context),
      fetchFunction: response,
    });

    assertHandledFailure(result, "compilation_cancel_unavailable");
    const envelope = JSON.parse(result.stderr);
    assert.equal(envelope.status, status);
    assert.equal("response" in envelope, problem);
    assert.match(envelope.detail, /Cancelling again is safe/);
    assertNoSecrets(result);
  }
});

test("an oversized response is unconfirmed unless it claims success", async (context) => {
  for (const { status, error } of [
    { status: 503, error: "compilation_cancel_unavailable" },
    { status: 409, error: "compilation_cancel_unavailable" },
    { status: 200, error: "invalid_compilation_status" },
  ]) {
    for (const declared of [true, false]) {
      let bodyCancelled = false;
      const body = new ReadableStream({
        start(controller) {
          if (!declared) {
            controller.enqueue({ byteLength: MAX_RESPONSE_BYTES + 1 });
          }
        },
        cancel() {
          bodyCancelled = true;
        },
      });
      const result = await invoke(["compilation", "cancel", COMPILATION_ID], {
        cwd: projectDirectory(context),
        fetchFunction: sequenceFetch([
          new Response(body, {
            status,
            headers: {
              "Content-Type": "application/problem+json",
              ...(declared
                ? { "Content-Length": String(MAX_RESPONSE_BYTES + 1) }
                : {}),
            },
          }),
        ]),
      });

      assertHandledFailure(result, error);
      assert.equal(JSON.parse(result.stderr).status, status);
      assert.equal(bodyCancelled, true);
    }
  }
});

test("a cancellation response must be the exact cancelled Compilation", async (context) => {
  for (const response of [
    jsonResponse(cancelledBody({ status: "running", completed_at: null })),
    jsonResponse({ ...cancelledBody(), canary: true }),
    jsonResponse(cancelledBody({ id: "01900000-0000-7000-8000-000000004099" })),
    new Response(JSON.stringify(cancelledBody()), {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    }),
    new Response(null, { status: 204 }),
    new Response("canary", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  ]) {
    const result = await invoke(["compilation", "cancel", COMPILATION_ID], {
      cwd: projectDirectory(context),
      fetchFunction: sequenceFetch([response]),
    });

    assertHandledFailure(result, "invalid_compilation_status");
    assert.match(JSON.parse(result.stderr).detail, /outcome is unconfirmed/);
    assertNoSecrets(result);
  }
});

test("compilation cancel authentication problems are stable", async (context) => {
  const missing = await invoke(["compilation", "cancel", COMPILATION_ID], {
    cwd: projectDirectory(context),
    apiToken: undefined,
    fetchFunction: async () => {
      throw new Error("network must remain inaccessible");
    },
  });
  assertHandledFailure(missing, "authentication_required");
  assert.equal(JSON.parse(missing.stderr).status, undefined);

  const rejected = await invoke(["compilation", "cancel", COMPILATION_ID], {
    cwd: projectDirectory(context),
    fetchFunction: sequenceFetch([
      problemResponse({
        status: 401,
        code: "authentication_required",
        detail: "Provide a valid First Draft API token.",
      }),
    ]),
  });
  assertHandledFailure(rejected, "authentication_required");
  assert.equal(JSON.parse(rejected.stderr).status, 401);
  assert.equal(
    JSON.parse(rejected.stderr).response.code,
    "authentication_required",
  );
  assertNoSecrets(rejected);
});

test("compilation cancel syntax and local state fail before network access", async (context) => {
  const inaccessible = async () => {
    throw new Error("network must remain inaccessible");
  };
  for (const argv of [
    ["compilation", "cancel"],
    ["compilation", "cancel", "not-a-uuid"],
    ["compilation", "cancel", "0190ABCD-0000-7000-8000-000000004002"],
    ["compilation", "cancel", COMPILATION_ID, COMPILATION_ID],
    ["compilation", "cancel", COMPILATION_ID, "--wait"],
    ["compilation", "cancel", COMPILATION_ID, "--staging", "--staging"],
  ]) {
    const result = await invoke(argv, {
      cwd: projectDirectory(context),
      fetchFunction: inaccessible,
    });
    assertHandledFailure(result, "invalid_arguments", 2);
    assert.equal(
      JSON.parse(result.stderr).detail,
      "Invalid arguments. Run 'firstdraft compilation cancel --help' for usage.",
    );
  }

  const uninitialized = mkdtempSync(path.join(tmpdir(), "firstdraft-cancel-"));
  context.after(() => rmSync(uninitialized, { recursive: true, force: true }));
  const unreadable = await invoke(["compilation", "cancel", COMPILATION_ID], {
    cwd: uninitialized,
    fetchFunction: inaccessible,
  });
  assertHandledFailure(unreadable, "local_input_unreadable");

  const unpushed = await invoke(["compilation", "cancel", COMPILATION_ID], {
    cwd: projectDirectory(context, { pushed: false }),
    fetchFunction: inaccessible,
  });
  assertHandledFailure(unpushed, "project_not_pushed");
});

/** @param {Record<string, unknown>} [changes] */
function cancelledBody(changes = {}) {
  return {
    project: { id: PROJECT_ID, graph_version: 3 },
    compilation: {
      id: COMPILATION_ID,
      analysis_run_id: ANALYSIS_ID,
      graph_version: 3,
      head_source_sha256: "1".repeat(64),
      status: "cancelled",
      compiler_release:
        "foundation-plan-rails/compiler-application-2026-10-03-accounts-without-verification",
      target: { id: "rails", profile: RAILS_TARGET_PROFILE },
      status_path: STATUS_PATH,
      cancel_path: CANCEL_PATH,
      artifact: null,
      failure: null,
      created_at: CREATED_AT,
      started_at: STARTED_AT,
      completed_at: COMPLETED_AT,
      ...changes,
    },
  };
}

/** @param {{status: number, code: string, detail: string}} problem */
function problemResponse({ status, code, detail }) {
  const titles = new Map([
    [401, "Unauthorized"],
    [404, "Not Found"],
    [408, "Request Timeout"],
    [409, "Conflict"],
    [503, "Service Unavailable"],
  ]);
  return new Response(
    JSON.stringify({
      type: "about:blank",
      title: titles.get(status),
      status,
      code,
      detail,
    }),
    { status, headers: { "Content-Type": "application/problem+json" } },
  );
}

/**
 * @param {import("node:test").TestContext} context
 * @param {{pushed?: boolean}} [options]
 */
function projectDirectory(context, { pushed = true } = {}) {
  const cwd = mkdtempSync(path.join(tmpdir(), "firstdraft-cancel-"));
  context.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(path.join(cwd, ".firstdraft"));
  writeFileSync(
    path.join(cwd, ".firstdraft", "state.json"),
    `${JSON.stringify(
      {
        format: "firstdraft.cli-state/1",
        project_id: PROJECT_ID,
        ...(pushed
          ? {
              api_url: API_URL,
              foundation_plan_etag: `"sha256:${"9".repeat(64)}"`,
            }
          : {}),
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
    env: { XDG_CONFIG_HOME: "/nonexistent/firstdraft-test-config" },
    fetchFunction: async () => assert.fail("No network request was expected"),
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

/** @param {{stdout: string, stderr: string}} result */
function assertNoSecrets(result) {
  assert.doesNotMatch(result.stdout + result.stderr, /canary/);
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

/** @param {unknown} body @param {number} [status] */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
