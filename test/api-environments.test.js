import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { run } from "../src/cli.js";

const PRODUCTION = "https://firstdraft.com";
const STAGING = "https://staging.firstdraft.com";
const PROJECT_ID = "01900000-0000-7000-8000-000000008001";
const COMPILATION_ID = "01900000-0000-7000-8000-000000008002";
const PRODUCTION_TOKEN = "canary-production-token";
const STAGING_TOKEN = "canary-staging-token";
const CUSTOM = "http://127.0.0.1:4300";
const SAVED_PRODUCTION_TOKEN = "fd_canary-saved-production-token";
const SAVED_STAGING_TOKEN = "fd_canary-saved-staging-token";
const SAVED_CUSTOM_TOKEN = "fd_canary-saved-custom-token";
const REMOTE_COMMANDS = [
  ["plan", "push"],
  ["plan", "status"],
  ["plan", "compile", "--output", "application"],
  ["plan", "compile", "--github"],
  ["compilation", "status", COMPILATION_ID],
  ["compilation", "download", COMPILATION_ID, "--output", "application"],
];

test("production and staging credentials follow the pinned origin on every remote command", async (context) => {
  for (const argv of REMOTE_COMMANDS) {
    for (const [origin, token] of [
      [PRODUCTION, PRODUCTION_TOKEN],
      [STAGING, STAGING_TOKEN],
    ]) {
      const cwd = projectDirectory(context, origin);
      let requests = 0;
      const result = await invoke(argv, {
        cwd,
        fetchFunction: async (input, init) => {
          requests += 1;
          assert.equal(new URL(String(input)).origin, origin);
          assert.equal(
            new Headers(init?.headers).get("authorization"),
            `Bearer ${token}`,
          );
          return authenticationProblem();
        },
      });
      assert.equal(requests, 1, argv.join(" "));
      assert.equal(result.status, 1);
      assert.equal(errorEnvelope(result.stderr).status, 401);
      assert.equal(
        errorEnvelope(result.stderr).error,
        "authentication_required",
      );
      assert.doesNotMatch(result.stderr, /canary/);
    }
  }
});

test("staging accepts a root or remote-command flag and a matching URL override", async (context) => {
  for (const command of REMOTE_COMMANDS) {
    for (const argv of [
      ["--staging", ...command],
      [...command, "--staging"],
    ]) {
      const cwd = projectDirectory(context, STAGING);
      let requests = 0;
      const result = await invoke(argv, {
        cwd,
        apiUrl: `${STAGING}/`,
        fetchFunction: async (input, init) => {
          requests += 1;
          assert.equal(new URL(String(input)).origin, STAGING);
          assert.equal(
            new Headers(init?.headers).get("authorization"),
            `Bearer ${STAGING_TOKEN}`,
          );
          return authenticationProblem();
        },
      });
      assert.equal(requests, 1);
      assert.equal(errorEnvelope(result.stderr).status, 401);
    }
  }
});

test("the first remote request defaults to production or explicitly selects staging", async (context) => {
  for (const command of [REMOTE_COMMANDS[0], REMOTE_COMMANDS[2]]) {
    assert(command);
    for (const staging of [false, true]) {
      const cwd = projectDirectory(context);
      let requests = 0;
      const result = await invoke(
        staging ? ["--staging", ...command] : command,
        {
          cwd,
          fetchFunction: async (input, init) => {
            requests += 1;
            assert.equal(
              new URL(String(input)).origin,
              staging ? STAGING : PRODUCTION,
            );
            assert.equal(
              new Headers(init?.headers).get("authorization"),
              `Bearer ${staging ? STAGING_TOKEN : PRODUCTION_TOKEN}`,
            );
            return authenticationProblem();
          },
        },
      );
      assert.equal(requests, 1);
      assert.equal(errorEnvelope(result.stderr).status, 401);
    }
  }
});

test("neither environment token substitutes for the other", async (context) => {
  for (const argv of REMOTE_COMMANDS) {
    for (const origin of [STAGING, PRODUCTION]) {
      const result = await invoke(argv, {
        cwd: projectDirectory(context, origin),
        apiToken: origin === STAGING ? PRODUCTION_TOKEN : "",
        stagingApiToken: origin === PRODUCTION ? STAGING_TOKEN : "",
      });
      assert.equal(result.status, 1);
      assert.equal(
        errorEnvelope(result.stderr).error,
        "authentication_required",
      );
      assert.equal(errorEnvelope(result.stderr).status, undefined);
      assert.doesNotMatch(result.stderr, /canary/);
    }
  }
});

test("staging rejects a conflicting URL or pinned origin before any request", async (context) => {
  for (const command of REMOTE_COMMANDS) {
    for (const options of [
      {
        cwd: projectDirectory(context, STAGING),
        apiUrl: "https://canary-conflict.test",
      },
      { cwd: projectDirectory(context, PRODUCTION) },
      { cwd: projectDirectory(context, "http://localhost:3000") },
    ]) {
      const result = await invoke([...command, "--staging"], options);
      assert.equal(result.status, 2);
      assert.equal(errorEnvelope(result.stderr).error, "invalid_configuration");
      assert.doesNotMatch(result.stderr, /canary|token/);
      if (options.apiUrl)
        assert.match(
          result.stderr,
          /--staging conflicts with FIRSTDRAFT_API_URL/,
        );
    }
  }
});

test("retained reads ignore an initial URL override when selecting staging credentials", async (context) => {
  for (const argv of [
    REMOTE_COMMANDS[1],
    REMOTE_COMMANDS[4],
    REMOTE_COMMANDS[5],
  ]) {
    assert(argv);
    let requests = 0;
    const result = await invoke(argv, {
      cwd: projectDirectory(context, STAGING),
      apiUrl: "https://unused-origin.test",
      fetchFunction: async (input, init) => {
        requests += 1;
        assert.equal(new URL(String(input)).origin, STAGING);
        assert.equal(
          new Headers(init?.headers).get("authorization"),
          `Bearer ${STAGING_TOKEN}`,
        );
        return authenticationProblem();
      },
    });
    assert.equal(requests, 1);
    assert.equal(errorEnvelope(result.stderr).status, 401);
  }
});

test("a custom initial origin retains explicit support and uses its own supplied token", async (context) => {
  const origin = "http://127.0.0.1:4300";
  let requests = 0;
  const result = await invoke(["plan", "push"], {
    cwd: projectDirectory(context),
    apiUrl: origin,
    fetchFunction: async (input, init) => {
      requests += 1;
      assert.equal(new URL(String(input)).origin, origin);
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        `Bearer ${PRODUCTION_TOKEN}`,
      );
      return authenticationProblem();
    },
  });
  assert.equal(requests, 1);
  assert.equal(errorEnvelope(result.stderr).status, 401);
});

test("a saved login authenticates its exact origin when the environment has no token", async (context) => {
  for (const argv of REMOTE_COMMANDS) {
    for (const [origin, token] of [
      [PRODUCTION, SAVED_PRODUCTION_TOKEN],
      [STAGING, SAVED_STAGING_TOKEN],
      [CUSTOM, SAVED_CUSTOM_TOKEN],
    ]) {
      let requests = 0;
      const result = await invoke(argv, {
        cwd: projectDirectory(context, origin),
        apiToken: "",
        stagingApiToken: undefined,
        env: savedLogins(context, {
          [PRODUCTION]: SAVED_PRODUCTION_TOKEN,
          [STAGING]: SAVED_STAGING_TOKEN,
          [CUSTOM]: SAVED_CUSTOM_TOKEN,
        }),
        fetchFunction: async (input, init) => {
          requests += 1;
          assert.equal(new URL(String(input)).origin, origin);
          assert.equal(
            new Headers(init?.headers).get("authorization"),
            `Bearer ${token}`,
          );
          return authenticationProblem();
        },
      });
      assert.equal(requests, 1, argv.join(" "));
      assert.equal(errorEnvelope(result.stderr).status, 401);
      assert.doesNotMatch(result.stdout + result.stderr, /canary/);
    }
  }
});

test("an environment token takes precedence over a saved login", async (context) => {
  for (const argv of REMOTE_COMMANDS) {
    for (const [origin, token] of [
      [PRODUCTION, PRODUCTION_TOKEN],
      [STAGING, STAGING_TOKEN],
    ]) {
      let requests = 0;
      await invoke(argv, {
        cwd: projectDirectory(context, origin),
        env: savedLogins(context, {
          [PRODUCTION]: SAVED_PRODUCTION_TOKEN,
          [STAGING]: SAVED_STAGING_TOKEN,
        }),
        fetchFunction: async (_input, init) => {
          requests += 1;
          assert.equal(
            new Headers(init?.headers).get("authorization"),
            `Bearer ${token}`,
          );
          return authenticationProblem();
        },
      });
      assert.equal(requests, 1);
    }
  }
});

test("a saved login never authenticates a different origin", async (context) => {
  /** @type {[string, Record<string, string>][]} */
  const cases = [
    [
      PRODUCTION,
      { [STAGING]: SAVED_STAGING_TOKEN, [CUSTOM]: SAVED_CUSTOM_TOKEN },
    ],
    [STAGING, { [PRODUCTION]: SAVED_PRODUCTION_TOKEN }],
    [CUSTOM, { [PRODUCTION]: SAVED_PRODUCTION_TOKEN }],
  ];
  for (const argv of REMOTE_COMMANDS) {
    for (const [origin, saved] of cases) {
      const result = await invoke(argv, {
        cwd: projectDirectory(context, origin),
        apiToken: "",
        stagingApiToken: "",
        env: savedLogins(context, saved),
      });
      assert.equal(result.status, 1);
      assert.deepEqual(errorEnvelope(result.stderr), {
        error: "authentication_required",
        detail:
          "First Draft authentication is required. Run 'firstdraft login' for the same environment, or set FIRSTDRAFT_API_TOKEN for production or custom origins, or FIRSTDRAFT_STAGING_API_TOKEN for staging.",
      });
      assert.doesNotMatch(result.stderr, /canary/);
    }
  }
});

test("an unreadable saved login file is treated as no saved login", async (context) => {
  const configHome = mkdtempSync(path.join(tmpdir(), "firstdraft-saved-"));
  context.after(() => rmSync(configHome, { recursive: true, force: true }));
  mkdirSync(path.join(configHome, "firstdraft"));
  writeFileSync(
    path.join(configHome, "firstdraft", "credentials.json"),
    `{"canary": "${SAVED_PRODUCTION_TOKEN}"`,
  );
  const result = await invoke(["plan", "push"], {
    cwd: projectDirectory(context, PRODUCTION),
    apiToken: "",
    stagingApiToken: "",
    env: { XDG_CONFIG_HOME: configHome },
  });
  assert.equal(result.status, 1);
  assert.equal(errorEnvelope(result.stderr).error, "authentication_required");
  assert.doesNotMatch(result.stderr, /canary/);
});

/**
 * @param {import("node:test").TestContext} context
 * @param {Record<string, string>} tokens
 */
function savedLogins(context, tokens) {
  const configHome = mkdtempSync(path.join(tmpdir(), "firstdraft-saved-"));
  context.after(() => rmSync(configHome, { recursive: true, force: true }));
  mkdirSync(path.join(configHome, "firstdraft"));
  writeFileSync(
    path.join(configHome, "firstdraft", "credentials.json"),
    JSON.stringify({
      format: "firstdraft.cli-credentials/1",
      origins: Object.fromEntries(
        Object.entries(tokens).map(([origin, token]) => [
          origin,
          {
            access_token: token,
            token_type: "Bearer",
            created_at: "2026-09-29T12:00:00.000Z",
          },
        ]),
      ),
    }),
  );
  return { XDG_CONFIG_HOME: configHome };
}

/** @param {import("node:test").TestContext} context @param {string} [origin] */
function projectDirectory(context, origin) {
  const cwd = mkdtempSync(path.join(tmpdir(), "firstdraft-environment-"));
  context.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(path.join(cwd, ".firstdraft"));
  writeFileSync(path.join(cwd, ".firstdraft", "foundation-plan.json"), "{}\n");
  writeFileSync(
    path.join(cwd, ".firstdraft", "state.json"),
    `${JSON.stringify({
      format: "firstdraft.cli-state/1",
      project_id: PROJECT_ID,
      ...(origin
        ? {
            api_url: origin,
            foundation_plan_etag: '"sha256:' + "1".repeat(64) + '"',
          }
        : {}),
    })}\n`,
  );
  return cwd;
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
    env: { XDG_CONFIG_HOME: "/nonexistent/firstdraft-test-config" },
    fetchFunction: async () => assert.fail("No network request was expected"),
    ...options,
  });
  return { status, stdout, stderr };
}

/** @param {string} stderr */
function errorEnvelope(stderr) {
  return JSON.parse(
    stderr
      .split("\n")
      .filter((line) => !line.startsWith("First Draft: "))
      .join("\n"),
  );
}

function authenticationProblem() {
  return new Response(
    JSON.stringify({
      type: "about:blank",
      title: "Unauthorized",
      status: 401,
      code: "authentication_required",
      detail: "A valid token is required.",
    }),
    { status: 401, headers: { "Content-Type": "application/problem+json" } },
  );
}
