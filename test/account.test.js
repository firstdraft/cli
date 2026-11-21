import assert from "node:assert/strict";
import test from "node:test";

import { run } from "../src/cli.js";

const PRODUCTION = "https://firstdraft.com";
const STAGING = "https://staging.firstdraft.com";
const PRODUCTION_TOKEN = "canary-production-token";
const STAGING_TOKEN = "canary-staging-token";
const ACCOUNT_HELP = `First Draft CLI

Usage:
  firstdraft account

Options:
      --staging  Use staging
  -h, --help     Show help

Environment:
  FIRSTDRAFT_API_TOKEN          Authenticate production or custom API origins
  FIRSTDRAFT_STAGING_API_TOKEN  Authenticate staging.firstdraft.com
  FIRSTDRAFT_API_URL            Use a custom API origin

The command reads the signed-in account once and prints whether it sends
progress and failure reports. Only the person turns reports on or off: when
approving firstdraft login, or later on their First Draft account page.
`;

test("account help is printed without a request", async () => {
  for (const argv of [
    ["account", "--help"],
    ["account", "-h"],
  ]) {
    assert.deepEqual(await invoke(argv), {
      status: 0,
      stdout: ACCOUNT_HELP,
      stderr: "",
    });
  }
});

test("account rejects invalid arguments before any request", async () => {
  for (const argv of [
    ["account", "canary-positional"],
    ["account", "--canary-option"],
    ["account", "--staging", "--staging"],
  ]) {
    const result = await invoke(argv);
    assert.equal(result.status, 2);
    assert.deepEqual(JSON.parse(result.stderr), {
      error: "invalid_arguments",
      detail: "Invalid arguments. Run 'firstdraft account --help' for usage.",
    });
    assert.doesNotMatch(result.stderr, /canary/);
  }
});

test("account prints whether reports are on, and nothing else the Service sent", async () => {
  for (const reports of ["on", "off"]) {
    /** @type {RequestInit | undefined} */
    let sent;
    const result = await invoke(["account"], {
      fetchFunction: async (input, init) => {
        sent = init;
        assert.equal(String(input), `${PRODUCTION}/v1/account`);
        return json({ reports, canary_extra: "ignored" });
      },
    });

    assert.deepEqual(result, {
      status: 0,
      stdout: `${JSON.stringify({ reports }, null, 2)}\n`,
      stderr: "",
    });
    assert.equal(sent?.method, "GET");
    assert.equal(sent?.redirect, "error");
    const headers = new Headers(sent?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${PRODUCTION_TOKEN}`);
    assert.match(String(headers.get("firstdraft-client")), /^cli\//);
  }
});

test("account selects its origin as login does", async () => {
  for (const [argv, options, origin, token] of [
    [["--staging", "account"], {}, STAGING, STAGING_TOKEN],
    [["account", "--staging"], {}, STAGING, STAGING_TOKEN],
    [
      ["account"],
      { apiUrl: "http://127.0.0.1:3000" },
      "http://127.0.0.1:3000",
      PRODUCTION_TOKEN,
    ],
  ]) {
    const result = await invoke(/** @type {string[]} */ (argv), {
      .../** @type {object} */ (options),
      fetchFunction: async (input, init) => {
        assert.equal(new URL(String(input)).origin, origin);
        assert.equal(
          new Headers(init?.headers).get("authorization"),
          `Bearer ${token}`,
        );
        return json({ reports: "off" });
      },
    });
    assert.equal(result.status, 0, result.stderr);
  }

  const conflict = await invoke(["account", "--staging"], {
    apiUrl: "https://canary.example",
  });
  assert.equal(conflict.status, 2);
  assert.equal(JSON.parse(conflict.stderr).error, "invalid_configuration");
});

test("account maps authentication, unavailable, and invalid responses", async () => {
  const missing = await invoke(["account"], { apiToken: "" });
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stderr).error, "authentication_required");

  const rejected = await invoke(["account"], {
    fetchFunction: async () =>
      problem(401, "authentication_required", "A valid token is required."),
  });
  assert.equal(rejected.status, 1);
  assert.equal(JSON.parse(rejected.stderr).error, "authentication_required");
  assert.equal(JSON.parse(rejected.stderr).status, 401);

  for (const [response, expected] of [
    [
      () => problem(503, "service_unavailable", "Try again."),
      {
        error: "account_unavailable",
        detail:
          "Could not read the account. This read-only request is safe to retry.",
        status: 503,
        response: {
          type: "about:blank",
          title: "Service Unavailable",
          status: 503,
          code: "service_unavailable",
          detail: "Try again.",
        },
      },
    ],
    [
      () => new Response("<html>canary</html>", { status: 404 }),
      {
        error: "account_unavailable",
        detail:
          "Could not read the account. This read-only request is safe to retry.",
        status: 404,
      },
    ],
    [
      () => {
        throw new TypeError("canary network failure");
      },
      {
        error: "account_unavailable",
        detail:
          "Could not read the account. This read-only request is safe to retry.",
      },
    ],
    ...[
      json({ reports: "maybe" }),
      json({ reports: true }),
      json([]),
      new Response('{"reports":"on"}', { status: 200 }),
      new Response(null, { status: 204 }),
    ].map((value) => [
      () => value,
      {
        error: "invalid_server_response",
        detail:
          "First Draft returned an invalid account response. Retrying the unchanged request will not repair this protocol mismatch.",
        status: value.status,
      },
    ]),
  ]) {
    const result = await invoke(["account"], {
      fetchFunction: async () => /** @type {() => Response} */ (response)(),
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.deepEqual(JSON.parse(result.stderr), expected);
    assert.doesNotMatch(result.stderr, /canary/);
  }
});

/** @param {unknown} body */
function json(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** @param {number} status @param {string} code @param {string} detail */
function problem(status, code, detail) {
  return new Response(
    JSON.stringify({
      type: "about:blank",
      title: status === 401 ? "Unauthorized" : "Service Unavailable",
      status,
      code,
      detail,
    }),
    { status, headers: { "Content-Type": "application/problem+json" } },
  );
}

/** @param {readonly string[]} argv @param {Partial<import("../src/cli.js").RunOptions>} [options] */
async function invoke(argv, options = {}) {
  let stdout = "";
  let stderr = "";
  const status = await run({
    argv,
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
    apiToken: PRODUCTION_TOKEN,
    stagingApiToken: STAGING_TOKEN,
    apiUrl: undefined,
    env: { XDG_CONFIG_HOME: "/nonexistent/firstdraft-test-config" },
    fetchFunction: async () => assert.fail("No network request was expected"),
    ...options,
  });
  return { status, stdout, stderr };
}
