import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { run } from "../src/cli.js";
import { VERSION } from "../src/version.js";

const PRODUCTION = "https://firstdraft.com";
const STAGING = "https://staging.firstdraft.com";
const SAVED_TOKEN = "fd_canary-saved-token";
const ENVIRONMENT_TOKEN = "fd_canary-environment-token";

const START_HELP = `First Draft CLI

Usage:
  firstdraft start

Options:
      --staging  Use staging
  -h, --help     Show help

Environment:
  FIRSTDRAFT_API_TOKEN          Authenticate production or custom API origins
  FIRSTDRAFT_STAGING_API_TOKEN  Authenticate staging.firstdraft.com
  FIRSTDRAFT_API_URL            Use a custom API origin

An agent runs this once before other First Draft work. It prints the versions,
any update notice, whether this computer is logged in and how to log in if
not, and, when the person agreed to reports, when to send them. With a token
it reads the account once; without one it makes no request. It exits 0 only
when First Draft accepted the login.
`;

const REPORTS_ON = [
  "Reports are on: this person agreed that you send First Draft progress and failure reports about the code it generates, and notes about problems with First Draft itself.",
  "Progress: run 'firstdraft report progress --step <step>' when bin/setup finishes (setup), when the first spec run finishes (specs_first_run), when every item under the README's Behavior to write is written (behavior_written), when the specs pass (specs_passing), and when the preview starts (preview_started). Add the counts you have; 'firstdraft report progress --help' lists them.",
  "Failure: when generated code fails in a way the README does not list, run 'firstdraft report failure --kind <kind>' once you have fixed it or stopped trying, where <kind> is setup_failure, spec_failure, boot_error, or lint_failure; 'firstdraft report failure --help' lists the other fields.",
  "Each report names the Compilation whose code 'firstdraft plan compile' or 'firstdraft compilation download' last wrote for this Project, which the CLI records; to name a different one, put its compilation.id right after 'report progress' or 'report failure'.",
  "Run each report and note command from the generated application's root, or from the Project's directory before the code is written or after --output. Each prints what it sends: pass only text that may leave this computer, never secrets or the person's data.",
  "Notes: send a note only when a problem with First Draft cost you a real detour and is likely to happen again, never for routine debugging, and only after the Plan has been pushed once with 'firstdraft plan push' or 'firstdraft plan compile'.",
  "Unstated request: when the person asked for something the Plan could not state, run 'firstdraft note unstated_request --request <text>', adding --workaround <text> for what you wrote in the Plan instead or left for later.",
  "Unclear guidance: when a Skill page or a diagnostic was unclear, run 'firstdraft note unclear_guidance --page <page> --unclear <text>', where <page> is the page's path inside the Skill, such as SKILL.md or references/plan/policies.md; for a diagnostic code or a CLI error value, give --code <code> in place of or beside --page, and add --workaround <text> for what you did instead.",
  "Wrong output: when analysis or generated code was wrong, run 'firstdraft note wrong_output --source <source> --expected <text> --actual <text>', where <source> is analysis or generated_code; a note about generated code names the recorded Compilation as a report does, and 'firstdraft note wrong_output --help' lists --code, --file, and --workaround.",
  "Write each note in your own plain words, at most 300 characters a field: never secrets, credentials, personal data, or code from the person's project.",
];

test("start help is printed without a request", async (context) => {
  for (const argv of [
    ["start", "--help"],
    ["start", "-h"],
  ]) {
    const result = await invoke(context, argv);
    assert.deepEqual(
      { status: result.status, stdout: result.stdout, stderr: result.stderr },
      { status: 0, stdout: START_HELP, stderr: "" },
    );
  }
});

test("start rejects invalid arguments before any request", async (context) => {
  for (const argv of [
    ["start", "canary-positional"],
    ["start", "--canary-option"],
    ["start", "--staging", "--staging"],
  ]) {
    const result = await invoke(context, argv);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.deepEqual(JSON.parse(result.stderr), {
      error: "invalid_arguments",
      detail: "Invalid arguments. Run 'firstdraft start --help' for usage.",
    });
  }

  const conflict = await invoke(context, ["start", "--staging"], {
    apiUrl: "https://canary.example",
  });
  assert.equal(conflict.status, 2);
  assert.equal(conflict.stdout, "");
  assert.equal(JSON.parse(conflict.stderr).error, "invalid_configuration");
});

test("without a token, start makes no request and names both login steps", async (context) => {
  const result = await invoke(context, ["start"], {
    env: { FIRSTDRAFT_PLUGIN_VERSION: "0.10.0" },
  });

  assert.equal(result.status, 1);
  assert.equal(
    result.stdout,
    lines(
      `First Draft CLI ${VERSION} with plugin 0.10.0.`,
      `This computer has no saved login for ${PRODUCTION}.`,
      "To log in, run 'firstdraft login --no-wait'. It prints a link and a code: show both to the person and ask them to approve the login in their browser.",
      "When the person says they approved, run 'firstdraft login --finish', then run 'firstdraft start' again.",
    ),
  );
  assert.deepEqual(JSON.parse(result.stderr), {
    error: "authentication_required",
    detail: `This computer has no token for ${PRODUCTION}, so the CLI made no request. Log in with 'firstdraft login --no-wait' and, once the person approves, 'firstdraft login --finish'.`,
  });
});

test("start names the staging flag in every command it prints", async (context) => {
  for (const argv of [
    ["--staging", "start"],
    ["start", "--staging"],
  ]) {
    const result = await invoke(context, argv, {
      apiToken: ENVIRONMENT_TOKEN,
    });
    assert.equal(result.status, 1);
    assert.equal(
      result.stdout,
      lines(
        `First Draft CLI ${VERSION}.`,
        `This computer has no saved login for ${STAGING}.`,
        "To log in, run 'firstdraft login --no-wait --staging'. It prints a link and a code: show both to the person and ask them to approve the login in their browser.",
        "When the person says they approved, run 'firstdraft login --finish --staging', then run 'firstdraft start --staging' again.",
      ),
    );
  }
});

test("a malformed credentials file counts as no saved login", async (context) => {
  const configHome = temporaryConfigHome(context);
  mkdirSync(path.join(configHome, "firstdraft"));
  writeFileSync(
    path.join(configHome, "firstdraft", "credentials.json"),
    "{canary",
  );
  const result = await invoke(context, ["start"], { configHome });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /has no saved login/);
  assert.doesNotMatch(result.stdout + result.stderr, /canary/);
});

test("with reports on, start reads the account once and says when to send reports", async (context) => {
  /** @type {{url: string, init: RequestInit | undefined}[]} */
  const requests = [];
  const result = await invoke(context, ["start"], {
    saved: { [PRODUCTION]: SAVED_TOKEN },
    fetchFunction: async (input, init) => {
      requests.push({ url: String(input), init });
      return account("on");
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    lines(
      `First Draft CLI ${VERSION}.`,
      `This computer has a saved login for ${PRODUCTION}.`,
      "Ready: First Draft accepted this computer's login.",
      ...REPORTS_ON,
    ),
  );
  assert.equal(result.stderr, "");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, `${PRODUCTION}/v1/account`);
  assert.equal(requests[0]?.init?.method, "GET");
  const headers = new Headers(requests[0]?.init?.headers);
  assert.equal(headers.get("authorization"), `Bearer ${SAVED_TOKEN}`);
  assert.equal(
    headers.get("firstdraft-client"),
    `cli/${VERSION}; os/${process.platform}`,
  );
  assertNoTokens(result);
});

test("with reports off, start says nothing about reports", async (context) => {
  const result = await invoke(context, ["start"], {
    saved: { [PRODUCTION]: SAVED_TOKEN },
    fetchFunction: async () => account("off"),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    lines(
      `First Draft CLI ${VERSION}.`,
      `This computer has a saved login for ${PRODUCTION}.`,
      "Ready: First Draft accepted this computer's login.",
    ),
  );
  assert.doesNotMatch(result.stdout + result.stderr, /report|note/i);
});

test("start says when an environment token takes the place of the saved login", async (context) => {
  /** @type {Record<string, string>[]} */
  const savedLogins = [{}, { [PRODUCTION]: SAVED_TOKEN }];
  for (const saved of savedLogins) {
    /** @type {string | null} */
    let authorization = null;
    const result = await invoke(context, ["start"], {
      saved,
      apiToken: ENVIRONMENT_TOKEN,
      fetchFunction: async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization");
        return account("off");
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(authorization, `Bearer ${ENVIRONMENT_TOKEN}`);
    assert.equal(
      result.stdout,
      lines(
        `First Draft CLI ${VERSION}.`,
        `This computer has ${PRODUCTION in saved ? "a" : "no"} saved login for ${PRODUCTION}.`,
        `FIRSTDRAFT_API_TOKEN is set, so the CLI uses that token in place of any saved login for ${PRODUCTION}, and no login is needed.`,
        "Ready: First Draft accepted FIRSTDRAFT_API_TOKEN.",
      ),
    );
    assertNoTokens(result);
  }

  const staging = await invoke(context, ["start", "--staging"], {
    stagingApiToken: ENVIRONMENT_TOKEN,
    fetchFunction: async (input) => {
      assert.equal(new URL(String(input)).origin, STAGING);
      return account("off");
    },
  });
  assert.equal(staging.status, 0, staging.stderr);
  assert.match(
    staging.stdout,
    /^FIRSTDRAFT_STAGING_API_TOKEN is set, so the CLI uses that token in place of any saved login for https:\/\/staging\.firstdraft\.com, and no login is needed\.$/m,
  );
});

test("start prints the update line from First Draft's answer on standard output", async (context) => {
  for (const [env, headers, update] of [
    [
      {},
      { "FirstDraft-Latest-CLI": "99.0.0", "FirstDraft-Minimum-CLI": "0.1.0" },
      `First Draft: an update is available (CLI 99.0.0; this setup has CLI ${VERSION}). Tell the person the update steps are at https://firstdraft.com/update`,
    ],
    [
      { FIRSTDRAFT_PLUGIN_VERSION: "0.10.0" },
      {
        "FirstDraft-Latest-Plugin": "0.11.0",
        "FirstDraft-Minimum-Plugin": "0.1.0",
      },
      "First Draft: an update is available (plugin 0.11.0; this setup has plugin 0.10.0). Tell the person the update steps are at https://firstdraft.com/update",
    ],
  ]) {
    const result = await invoke(context, ["start"], {
      env: /** @type {Record<string, string>} */ (env),
      saved: { [PRODUCTION]: SAVED_TOKEN },
      fetchFunction: async () =>
        account("off", /** @type {Record<string, string>} */ (headers)),
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const [version, notice, ...rest] = result.stdout.split("\n");
    assert.match(String(version), /^First Draft CLI /);
    assert.equal(notice, update);
    assert.deepEqual(rest, [
      `This computer has a saved login for ${PRODUCTION}.`,
      "Ready: First Draft accepted this computer's login.",
      "",
    ]);
  }
});

test("below the minimum, start gives the handled refusal instead of ready", async (context) => {
  const result = await invoke(context, ["start"], {
    saved: { [PRODUCTION]: SAVED_TOKEN },
    fetchFunction: async () =>
      account("on", {
        "FirstDraft-Latest-CLI": "99.0.0",
        "FirstDraft-Minimum-CLI": "99.0.0",
      }),
  });

  assert.equal(result.status, 1);
  assert.equal(
    result.stdout,
    lines(
      `First Draft CLI ${VERSION}.`,
      `This computer has a saved login for ${PRODUCTION}.`,
    ),
  );
  assert.deepEqual(JSON.parse(result.stderr), {
    error: "update_required",
    detail: `First Draft requires CLI 99.0.0 or later, and this setup has CLI ${VERSION}. The CLI stopped before the command finished and sent nothing more. Tell the person to update with the steps at https://firstdraft.com/update, then run the same command again, with the same options.`,
    cli_version: VERSION,
    minimum_cli_version: "99.0.0",
    update_url: "https://firstdraft.com/update",
  });
});

test("an API contract outside the accepted range is not ready", async (context) => {
  for (const contract of ["0.8.0", "0.10.0"]) {
    const result = await invoke(context, ["start"], {
      saved: { [PRODUCTION]: SAVED_TOKEN },
      fetchFunction: async () =>
        account("on", { "FirstDraft-API-Contract": contract }),
    });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /Ready|Reports/);
    const envelope = JSON.parse(result.stderr);
    assert.equal(envelope.error, "api_contract_unsupported");
    assert.equal(envelope.api_contract, contract);
  }
});

test("a rejected login says how to log in again", async (context) => {
  const saved = await invoke(context, ["start"], {
    saved: { [PRODUCTION]: SAVED_TOKEN },
    fetchFunction: async () => unauthorized(),
  });
  assert.equal(saved.status, 1);
  assert.equal(
    saved.stdout,
    lines(
      `First Draft CLI ${VERSION}.`,
      `This computer has a saved login for ${PRODUCTION}.`,
      `Not logged in: First Draft did not accept the saved login for ${PRODUCTION}.`,
      "To log in, run 'firstdraft login --no-wait'. It prints a link and a code: show both to the person and ask them to approve the login in their browser.",
      "When the person says they approved, run 'firstdraft login --finish', then run 'firstdraft start' again.",
    ),
  );
  const envelope = JSON.parse(saved.stderr);
  assert.equal(envelope.error, "authentication_required");
  assert.equal(
    envelope.detail,
    `First Draft did not accept the saved login for ${PRODUCTION}. Log in with 'firstdraft login --no-wait' and, once the person approves, 'firstdraft login --finish'.`,
  );
  assert.equal(envelope.status, 401);

  const environment = await invoke(context, ["start"], {
    apiToken: ENVIRONMENT_TOKEN,
    fetchFunction: async () => unauthorized(),
  });
  assert.equal(environment.status, 1);
  assert.match(
    environment.stdout,
    /\nNot logged in: First Draft did not accept FIRSTDRAFT_API_TOKEN\. Ask the person to replace it or unset it; while it is set, the CLI uses no saved login\.\n$/,
  );
  assert.doesNotMatch(environment.stdout, /login --no-wait/);
  assert.equal(
    JSON.parse(environment.stderr).detail,
    "First Draft did not accept FIRSTDRAFT_API_TOKEN. Ask the person to replace it or unset it.",
  );
  assertNoTokens(environment);
});

test("an unreadable account leaves start not ready and safe to retry", async (context) => {
  const cases = [
    [
      () =>
        new Response(
          JSON.stringify({
            type: "about:blank",
            title: "Service Unavailable",
            status: 503,
            code: "service_unavailable",
            detail: "Try again.",
          }),
          {
            status: 503,
            headers: { "Content-Type": "application/problem+json" },
          },
        ),
      "account_unavailable",
    ],
    [
      () => {
        throw new TypeError("canary network failure");
      },
      "account_unavailable",
    ],
    [() => json({ reports: "maybe" }), "invalid_server_response"],
  ];
  for (const [response, error] of cases) {
    const result = await invoke(context, ["start"], {
      saved: { [PRODUCTION]: SAVED_TOKEN },
      fetchFunction: async () => /** @type {() => Response} */ (response)(),
    });
    assert.equal(result.status, 1);
    assert.equal(
      result.stdout,
      lines(
        `First Draft CLI ${VERSION}.`,
        `This computer has a saved login for ${PRODUCTION}.`,
      ),
    );
    const envelope = JSON.parse(result.stderr);
    assert.equal(envelope.error, error);
    if (error === "account_unavailable") {
      assert.equal(
        envelope.detail,
        "Could not read the account, so the CLI could not check the login or the reports choice. This read-only request is safe to retry: run 'firstdraft start' again.",
      );
    }
    assert.doesNotMatch(result.stdout + result.stderr, /canary/);
  }

  const limited = await invoke(context, ["start"], {
    saved: { [PRODUCTION]: SAVED_TOKEN },
    fetchFunction: async () =>
      new Response(null, { status: 429, headers: { "Retry-After": "60" } }),
  });
  assert.equal(limited.status, 1);
  assert.equal(JSON.parse(limited.stderr).error, "rate_limited");
});

test("a version refusal wins over a failed account read", async (context) => {
  for (const [response, error] of [
    [
      () => {
        const rejected = unauthorized();
        return new Response(rejected.body, {
          status: 401,
          headers: {
            "Content-Type": "application/problem+json",
            "FirstDraft-Latest-CLI": "99.0.0",
            "FirstDraft-Minimum-CLI": "99.0.0",
          },
        });
      },
      "update_required",
    ],
    [
      () =>
        new Response(JSON.stringify({ reports: "maybe" }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "FirstDraft-API-Contract": "0.10.0",
          },
        }),
      "api_contract_unsupported",
    ],
  ]) {
    const result = await invoke(context, ["start"], {
      saved: { [PRODUCTION]: SAVED_TOKEN },
      fetchFunction: async () => /** @type {() => Response} */ (response)(),
    });
    assert.equal(result.status, 1);
    assert.equal(
      result.stdout,
      lines(
        `First Draft CLI ${VERSION}.`,
        `This computer has a saved login for ${PRODUCTION}.`,
      ),
    );
    assert.equal(JSON.parse(result.stderr).error, error);
  }
});

test("start passes on none of the text in First Draft's problem answers", async (context) => {
  for (const [status, headers] of [
    [401, {}],
    [429, { "Retry-After": "60" }],
    [503, {}],
  ]) {
    const result = await invoke(context, ["start", "--staging"], {
      saved: { [STAGING]: SAVED_TOKEN },
      serviceNow: () => Date.parse("2026-11-21T12:00:00Z"),
      fetchFunction: async () =>
        new Response(
          JSON.stringify({
            type: "about:blank",
            title: "Problem for canary@example.com",
            status,
            code: status === 401 ? "authentication_required" : "canary_code",
            detail: "Write to canary@example.com.",
          }),
          {
            status: /** @type {number} */ (status),
            headers: {
              "Content-Type": "application/problem+json",
              .../** @type {Record<string, string>} */ (headers),
            },
          },
        ),
    });
    assert.equal(result.status, 1);
    const envelope = JSON.parse(result.stderr);
    assert.equal(envelope.response, undefined);
    assert.doesNotMatch(result.stdout + result.stderr, /canary/);
    if (status === 429) {
      assert.equal(envelope.error, "rate_limited");
      assert.equal(envelope.retry_at, "2026-11-21T12:01:00Z");
      assert.match(envelope.detail, /Try again after 2026-11-21T12:01:00Z\.$/);
    }
    if (status === 503) {
      assert.equal(
        envelope.detail,
        "Could not read the account, so the CLI could not check the login or the reports choice. This read-only request is safe to retry: run 'firstdraft start --staging' again.",
      );
    }
  }
});

/** @param {...string} values */
function lines(...values) {
  return values.map((value) => `${value}\n`).join("");
}

/**
 * @param {"on" | "off"} reports
 * @param {Record<string, string>} [headers]
 */
function account(reports, headers = {}) {
  return new Response(
    JSON.stringify({ reports, email: "canary@example.com" }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "FirstDraft-API-Contract": "0.9.0",
        ...headers,
      },
    },
  );
}

/** @param {unknown} body */
function json(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function unauthorized() {
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

/** @param {{stdout: string, stderr: string}} result */
function assertNoTokens(result) {
  assert.doesNotMatch(result.stdout + result.stderr, /fd_canary|canary@/);
}

/** @param {import("node:test").TestContext} context */
function temporaryConfigHome(context) {
  const directory = mkdtempSync(path.join(tmpdir(), "firstdraft-start-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/**
 * @param {import("node:test").TestContext} context
 * @param {readonly string[]} argv
 * @param {Partial<import("../src/cli.js").RunOptions> & {configHome?: string, saved?: Record<string, string>}} [options]
 */
async function invoke(context, argv, options = {}) {
  const {
    configHome = temporaryConfigHome(context),
    saved = {},
    env = {},
    ...rest
  } = options;
  if (Object.keys(saved).length > 0) {
    mkdirSync(path.join(configHome, "firstdraft"), { recursive: true });
    writeFileSync(
      path.join(configHome, "firstdraft", "credentials.json"),
      JSON.stringify({
        format: "firstdraft.cli-credentials/1",
        origins: Object.fromEntries(
          Object.entries(saved).map(([origin, token]) => [
            origin,
            {
              access_token: token,
              token_type: "Bearer",
              created_at: "2026-11-01T00:00:00.000Z",
            },
          ]),
        ),
      }),
    );
  }
  let stdout = "";
  let stderr = "";
  const status = await run({
    argv,
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
    apiToken: "",
    stagingApiToken: "",
    apiUrl: undefined,
    env: { XDG_CONFIG_HOME: configHome, ...env },
    homedir: () => assert.fail("The home directory must not be used"),
    fetchFunction: async () => assert.fail("No network request was expected"),
    ...rest,
  });
  return { status, stdout, stderr };
}
