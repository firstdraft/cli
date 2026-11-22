import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { run } from "../src/cli.js";

const PRODUCTION = "https://firstdraft.com";
const STAGING = "https://staging.firstdraft.com";
const PROJECT_ID = "01900000-0000-7000-8000-000000009300";
const COMPILATION_ID = "01900000-0000-7000-8000-000000009301";
const RECORDED_ID = "01900000-0000-7000-8000-000000009302";
const STORED_ID = "01900000-0000-7000-8000-000000009303";
const TOKEN = "canary-note-token";
const STAGING_TOKEN = "canary-staging-note-token";
const CWD = path.resolve("/work/movie_catalog");
const NOTES_PATH = `/v1/projects/${PROJECT_ID}/notes`;
const REPORTS_OFF =
  "Not kept: this account has reports off, so First Draft kept nothing. Continue without sending reports.\n";
const UNSTATED = [
  "note",
  "unstated_request",
  "--request",
  "A weekly digest email of new movies",
];
const GENERATED = [
  "note",
  "wrong_output",
  "--source",
  "generated_code",
  "--expected",
  "Only the owner edits a movie",
  "--actual",
  "Any member can edit it",
];

test("note help lists the three kinds and each kind's options", async () => {
  for (const argv of [["note"], ["note", "--help"], ["note", "-h"]]) {
    const result = await invoke(argv);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /firstdraft note <kind>/);
    assert.match(result.stdout, /unstated_request {2}The person asked/);
    assert.match(result.stdout, /unclear_guidance {2}A Skill page/);
    assert.match(result.stdout, /wrong_output {6}Analysis or generated code/);
  }

  for (const [kind, options] of /** @type {[string, string[]][]} */ ([
    ["unstated_request", ["--request <text>", "--workaround <text>"]],
    [
      "unclear_guidance",
      ["--page <page>", "--code <code>", "--unclear <text>", "--workaround"],
    ],
    [
      "wrong_output",
      [
        "--source <source>",
        "--code <code>",
        "--compilation-id <id>",
        "--file <path\\[:line\\]>",
        "--expected <text>",
        "--actual <text>",
        "--workaround <text>",
      ],
    ],
  ])) {
    const result = await invoke(["note", kind, "--help"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, new RegExp(`firstdraft note ${kind} `));
    for (const option of options) {
      assert.match(result.stdout, new RegExp(option), `${kind} ${option}`);
    }
  }

  for (const argv of [
    ["note", "canary"],
    ["note", "--canary"],
    ["note", "unstated-request"],
  ]) {
    const result = await invoke(argv);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Run 'firstdraft note --help' for usage\.\n$/);
    assert.doesNotMatch(result.stderr, /canary/);
  }
});

test("each note kind validates its arguments before any request", async () => {
  for (const argv of [
    ["note", "unstated_request"],
    ["note", "unstated_request", "--workaround", "Left it out"],
    [...UNSTATED, "--request", "Twice"],
    [...UNSTATED, "--page", "SKILL.md"],
    [...UNSTATED, "--canary"],
    [...UNSTATED, "positional"],
    ["note", "unclear_guidance", "--unclear", "Says nothing about roles"],
    ["note", "unclear_guidance", "--page", "SKILL.md"],
    [
      "note",
      "unclear_guidance",
      "--code",
      "x",
      "--unclear",
      "x",
      "--file",
      "x",
    ],
    ["note", "wrong_output", "--expected", "a", "--actual", "b"],
    [
      "note",
      "wrong_output",
      "--source",
      "code",
      "--expected",
      "a",
      "--actual",
      "b",
    ],
    ["note", "wrong_output", "--source", "analysis", "--expected", "a"],
    ["note", "wrong_output", "--source", "analysis", "--actual", "b"],
    [
      "note",
      "wrong_output",
      "--source",
      "analysis",
      "--expected",
      "a",
      "--actual",
      "b",
      "--compilation-id",
      COMPILATION_ID,
    ],
    [
      "note",
      "wrong_output",
      "--source",
      "analysis",
      "--expected",
      "a",
      "--actual",
      "b",
      "--file",
      "app/models/movie.rb",
    ],
    [...GENERATED, "--code", "foundation_plan.policy.unknown"],
    [...GENERATED, "--compilation-id", "0190000A-0000-7000-8000-000000009301"],
    [...GENERATED, "--compilation-id", "01900000-0000-4000-8000-000000009301"],
    [...GENERATED, "--compilation-id", ""],
    [...GENERATED, "--request", "x"],
  ]) {
    const kind = argv[1];
    const result = await invoke(argv);
    assert.equal(result.status, 2, argv.join(" "));
    assert.equal(result.stdout, "");
    assert.deepEqual(JSON.parse(result.stderr), {
      error: "invalid_arguments",
      detail: `Invalid arguments. Run 'firstdraft note ${kind} --help' for usage.`,
    });
  }
});

test("an unstated request reads the account, prints the exact note, then sends those bytes once", async (context) => {
  const cwd = projectDirectory(context, PRODUCTION);
  /** @type {{url: string, init: RequestInit | undefined}[]} */
  const requests = [];
  const result = await invoke(
    [
      ...UNSTATED,
      "--workaround",
      "Left it for later in the README's Behavior to write",
    ],
    {
      cwd,
      fetchFunction: async (input, init) => {
        requests.push({ url: String(input), init });
        if (requests.length === 1) return account("on");
        return stored({ kind: "unstated_request", compilation_id: null });
      },
    },
  );

  const body = `${JSON.stringify(
    {
      note: {
        kind: "unstated_request",
        request: "A weekly digest email of new movies",
        workaround: "Left it for later in the […]",
      },
    },
    null,
    2,
  )}\n`;
  assert.deepEqual(result, {
    status: 0,
    stdout: `Sending this unstated_request note to ${PRODUCTION}:\n${body}Sent.\n`,
    stderr: "",
  });
  assert.equal(requests.length, 2);
  const [read, request] = requests;
  assert(read && request);
  assert.equal(read.url, `${PRODUCTION}/v1/account`);
  assert.equal(read.init?.method ?? "GET", "GET");
  assert.equal(read.init?.body, undefined);
  assert.equal(request.url, `${PRODUCTION}${NOTES_PATH}`);
  assert.equal(request.init?.method, "POST");
  assert.equal(request.init?.body, body);
  const headers = new Headers(request.init?.headers);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("authorization"), `Bearer ${TOKEN}`);
  assert.match(String(headers.get("firstdraft-client")), /^cli\//);
});

test("a note keeps each field only in its shape and says what it left out", async (context) => {
  const cwd = projectDirectory(context, PRODUCTION);
  for (const [
    argv,
    note,
    leftOut,
  ] of /** @type {[string[], Record<string, string>, string][]} */ ([
    [
      [
        "note",
        "unclear_guidance",
        "--page",
        "references/plan/policies.md#roles",
        "--code",
        "foundation_plan.policy.unknown_role",
        "--unclear",
        "It never says whether a role can be empty",
        "--workaround",
        "Tried 'owner' and \"admin\" until one passed",
      ],
      {
        kind: "unclear_guidance",
        page: "references/plan/policies.md#roles",
        code: "foundation_plan.policy.unknown_role",
        unclear: "It never says whether a role can be empty",
        workaround: "Tried […]",
      },
      "",
    ],
    [
      [
        "note",
        "unclear_guidance",
        "--page",
        "../secrets.md",
        "--code",
        "invalid_output_path",
        "--unclear",
        "It names no fix",
      ],
      {
        kind: "unclear_guidance",
        code: "invalid_output_path",
        unclear: "It names no fix",
      },
      "Left out: page, which is not SKILL.md or another path ending in .md.\n",
    ],
    [
      [
        "note",
        "wrong_output",
        "--source",
        "analysis",
        "--code",
        "Foundation Plan",
        "--expected",
        "The Plan is valid",
        "--actual",
        "Analysis refused it",
        "--workaround",
        "\nsecond line",
      ],
      {
        kind: "wrong_output",
        source: "analysis",
        expected: "The Plan is valid",
        actual: "Analysis refused it",
      },
      "Left out: code, which is not a diagnostic code or CLI error value; workaround, which has no plain words on its first line.\n",
    ],
  ])) {
    /** @type {string | undefined} */
    let sent;
    const result = await invoke(argv, {
      cwd,
      fetchFunction: reportsOn(async (_input, init) => {
        sent = String(init?.body);
        return stored({ kind: note.kind ?? "", compilation_id: null });
      }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert(sent);
    assert.deepEqual(JSON.parse(sent), { note });
    assert.equal(
      result.stdout,
      `Sending this ${note.kind} note to ${PRODUCTION}:\n${sent}${leftOut}Sent.\n`,
    );
  }
});

test("a note about generated code names the recorded Compilation unless one is given", async (context) => {
  const root = adoptedRoot(context);
  writeRecord(path.join(root, ".firstdraft", "design", ".firstdraft"));
  for (const [argv, expected] of /** @type {[string[], string][]} */ ([
    [[...GENERATED, "--file", "app/policies/movie_policy.rb:12"], RECORDED_ID],
    [[...GENERATED, "--compilation-id", COMPILATION_ID], COMPILATION_ID],
  ])) {
    /** @type {string | undefined} */
    let sent;
    const result = await invoke(argv, {
      cwd: root,
      fetchFunction: reportsOn(async (input, init) => {
        assert.equal(String(input), `${PRODUCTION}${NOTES_PATH}`);
        sent = String(init?.body);
        return stored({ kind: "wrong_output", compilation_id: expected });
      }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert(sent);
    assert.equal(JSON.parse(sent).note.compilation_id, expected);
    assert.equal(
      result.stdout,
      `Sending this wrong_output note for Compilation ${expected} to ${PRODUCTION}:\n${sent}Sent.\n`,
    );
  }
});

test("a note about generated code with no Compilation given or recorded sends nothing", async (context) => {
  const cwd = projectDirectory(context, PRODUCTION);
  /** @type {string[]} */
  const urls = [];
  const result = await invoke(GENERATED, {
    cwd,
    fetchFunction: async (input) => {
      urls.push(String(input));
      return account("on");
    },
  });
  assert.deepEqual(urls, [`${PRODUCTION}/v1/account`]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), {
    error: "compilation_not_recorded",
    detail:
      "No Compilation is recorded for this Project, so nothing was sent. 'firstdraft plan compile' and 'firstdraft compilation download' record the one whose code they write; to name one yourself, pass its compilation.id with --compilation-id.",
  });

  // Only a note about generated code names a Compilation.
  const analysis = await invoke(
    [
      "note",
      "wrong_output",
      "--source",
      "analysis",
      "--expected",
      "Valid",
      "--actual",
      "Refused",
    ],
    {
      cwd,
      fetchFunction: reportsOn(async () =>
        stored({ kind: "wrong_output", compilation_id: null }),
      ),
    },
  );
  assert.equal(analysis.status, 0, analysis.stderr);
});

test("a required field with nothing left after shaping is refused locally", async (context) => {
  const cwd = projectDirectory(context, PRODUCTION);
  for (const [argv, detail] of /** @type {[string[], string][]} */ ([
    [
      ["note", "unstated_request", "--request", "\nThe person's email"],
      "Nothing was sent, because a field the note needs did not fit its shape: request, which has no plain words on its first line. Run 'firstdraft note unstated_request --help' for what each field may hold.",
    ],
    [
      [
        "note",
        "unclear_guidance",
        "--page",
        "references/../canary.md",
        "--unclear",
        "   ",
      ],
      "Nothing was sent, because a field the note needs did not fit its shape: page, which is not SKILL.md or another path ending in .md; unclear, which has no plain words on its first line. Run 'firstdraft note unclear_guidance --help' for what each field may hold.",
    ],
    [
      [
        ...GENERATED.slice(0, 6),
        "--actual",
        "",
        "--compilation-id",
        COMPILATION_ID,
      ],
      "Nothing was sent, because a field the note needs did not fit its shape: actual, which has no plain words on its first line. Run 'firstdraft note wrong_output --help' for what each field may hold.",
    ],
  ])) {
    /** @type {string[]} */
    const urls = [];
    const result = await invoke(argv, {
      cwd,
      fetchFunction: async (input) => {
        urls.push(String(input));
        return account("on");
      },
    });
    assert.deepEqual(urls, [`${PRODUCTION}/v1/account`], argv.join(" "));
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.deepEqual(JSON.parse(result.stderr), {
      error: "note_incomplete",
      detail,
    });
    assert.doesNotMatch(result.stderr, /canary|email/);
  }
});

test("with reports off, a note command sends nothing but the account read", async (context) => {
  const cwd = projectDirectory(context, PRODUCTION);
  for (const argv of [
    UNSTATED,
    GENERATED,
    ["note", "unstated_request", "--request", ""],
  ]) {
    /** @type {{url: string, init: RequestInit | undefined}[]} */
    const requests = [];
    const result = await invoke(argv, {
      cwd,
      fetchFunction: async (input, init) => {
        requests.push({ url: String(input), init });
        return account("off");
      },
    });
    assert.deepEqual(result, { status: 0, stdout: REPORTS_OFF, stderr: "" });
    assert.equal(requests.length, 1, argv.join(" "));
    assert.equal(requests[0]?.url, `${PRODUCTION}/v1/account`);
    assert.equal(requests[0]?.init?.body, undefined);
  }

  const turnedOff = await invoke(UNSTATED, {
    cwd,
    fetchFunction: reportsOn(async () =>
      problem(403, "reports_off", "Reports are off for this account."),
    ),
  });
  assert.equal(turnedOff.status, 0);
  assert.equal(turnedOff.stderr, "");
  assert.match(turnedOff.stdout, /^Sending this unstated_request note /);
  assert.ok(turnedOff.stdout.endsWith(REPORTS_OFF), turnedOff.stdout);
});

test("a note is not sent when the account cannot be read", async (context) => {
  const cwd = projectDirectory(context, PRODUCTION);
  const unavailable =
    "Could not read whether this account sends reports and notes, so no note was sent. Continue without it.";
  const invalid =
    "First Draft returned an invalid account response, so no note was sent. Continue without it.";
  for (const [
    response,
    expected,
  ] of /** @type {[() => Response, Record<string, unknown>][]} */ ([
    [
      () => {
        throw new TypeError("canary socket hang up");
      },
      { error: "account_unavailable", detail: unavailable },
    ],
    [
      () =>
        new Response('{"reports":"canary"}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      { error: "invalid_server_response", detail: invalid, status: 200 },
    ],
    [
      () =>
        new Response(null, { status: 429, headers: { "Retry-After": "60" } }),
      { error: "rate_limited", status: 429 },
    ],
  ])) {
    /** @type {string[]} */
    const urls = [];
    const result = await invoke(UNSTATED, {
      cwd,
      fetchFunction: async (input) => {
        urls.push(String(input));
        return response();
      },
    });
    assert.deepEqual(urls, [`${PRODUCTION}/v1/account`]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    const error = JSON.parse(result.stderr);
    for (const [key, value] of Object.entries(expected)) {
      assert.deepEqual(error[key], value, key);
    }
    assert.doesNotMatch(result.stderr, /canary/);
  }
});

test("note refusals and unconfirmed outcomes are handled without retrying", async (context) => {
  const cwd = projectDirectory(context, PRODUCTION);
  const rejected =
    "First Draft rejected the note, so it was not kept; response.code says why. Continue without it.";
  const unavailable =
    "Could not confirm that First Draft received the note, and First Draft may hold it already. Continue without it rather than sending it again.";
  for (const [
    argv,
    response,
    expected,
  ] of /** @type {[string[], () => Response, Record<string, unknown>][]} */ ([
    [
      UNSTATED,
      () => problem(400, "invalid_note", "request is not plain words."),
      {
        error: "note_rejected",
        detail: rejected,
        status: 400,
        response: {
          type: "about:blank",
          title: "Bad Request",
          status: 400,
          code: "invalid_note",
          detail: "request is not plain words.",
        },
      },
    ],
    [
      [...GENERATED, "--compilation-id", COMPILATION_ID],
      () =>
        problem(
          409,
          "compilation_not_succeeded",
          "This Compilation produced no code.",
        ),
      {
        error: "note_rejected",
        detail: rejected,
        status: 409,
        response: {
          type: "about:blank",
          title: "Conflict",
          status: 409,
          code: "compilation_not_succeeded",
          detail: "This Compilation produced no code.",
        },
      },
    ],
    [
      UNSTATED,
      () => new Response("<html>canary</html>", { status: 502 }),
      { error: "note_unavailable", detail: unavailable, status: 502 },
    ],
    [
      UNSTATED,
      () => {
        throw new TypeError("canary socket hang up");
      },
      { error: "note_unavailable", detail: unavailable },
    ],
    // A success without First Draft's acknowledgment confirms nothing.
    [
      UNSTATED,
      () => new Response("<html>canary</html>", { status: 200 }),
      { error: "note_unavailable", detail: unavailable, status: 200 },
    ],
    [
      UNSTATED,
      () =>
        stored({ kind: "unstated_request", compilation_id: COMPILATION_ID }),
      { error: "note_unavailable", detail: unavailable, status: 201 },
    ],
    [
      UNSTATED,
      () =>
        new Response(
          JSON.stringify({
            progress_report: { id: STORED_ID, compilation_id: null },
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      { error: "note_unavailable", detail: unavailable, status: 201 },
    ],
    [
      [...GENERATED, "--compilation-id", COMPILATION_ID],
      () => stored({ kind: "wrong_output", compilation_id: null }),
      { error: "note_unavailable", detail: unavailable, status: 201 },
    ],
  ])) {
    let requests = 0;
    const result = await invoke(argv, {
      cwd,
      fetchFunction: reportsOn(async () => {
        requests += 1;
        return response();
      }),
    });
    assert.equal(requests, 1);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^Sending this /);
    assert.doesNotMatch(result.stdout, /Sent\./);
    assert.deepEqual(JSON.parse(result.stderr), expected);
    assert.doesNotMatch(result.stderr, /canary/);
  }

  const limited = await invoke(UNSTATED, {
    cwd,
    fetchFunction: reportsOn(
      async () =>
        new Response(null, { status: 429, headers: { "Retry-After": "60" } }),
    ),
  });
  assert.equal(limited.status, 1);
  assert.equal(JSON.parse(limited.stderr).error, "rate_limited");

  const unauthenticated = await invoke(UNSTATED, {
    cwd,
    fetchFunction: reportsOn(async () =>
      problem(401, "authentication_required", "A valid token is required."),
    ),
  });
  assert.equal(unauthenticated.status, 1);
  assert.equal(
    JSON.parse(unauthenticated.stderr).error,
    "authentication_required",
  );
});

test("notes stop on local problems before printing anything", async (context) => {
  for (const [cwd, error] of [
    [projectDirectory(context), "project_not_pushed"],
    [temporaryDirectory(context), "local_input_unreadable"],
  ]) {
    const result = await invoke(UNSTATED, { cwd });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error, error);
  }

  const mismatch = await invoke([...UNSTATED, "--staging"], {
    cwd: projectDirectory(context, PRODUCTION),
  });
  assert.equal(mismatch.status, 2);
  assert.equal(JSON.parse(mismatch.stderr).error, "invalid_configuration");

  const noToken = await invoke(UNSTATED, {
    cwd: projectDirectory(context, STAGING),
    stagingApiToken: "",
  });
  assert.equal(noToken.status, 1);
  assert.equal(noToken.stdout, "");
  assert.equal(JSON.parse(noToken.stderr).error, "authentication_required");
});

test("a staging Project's note goes to staging with its token", async (context) => {
  /** @type {unknown} */
  let sent;
  const result = await invoke(["--staging", ...UNSTATED], {
    cwd: projectDirectory(context, STAGING),
    fetchFunction: async (input, init) => {
      assert.equal(new URL(String(input)).origin, STAGING);
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        `Bearer ${STAGING_TOKEN}`,
      );
      if (new URL(String(input)).pathname === "/v1/account") {
        return account("on");
      }
      sent = JSON.parse(String(init?.body));
      return stored({ kind: "unstated_request", compilation_id: null });
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(sent, {
    note: {
      kind: "unstated_request",
      request: "A weekly digest email of new movies",
    },
  });
});

/**
 * Answers the account read at the pinned production origin with reports on,
 * and hands every other request to `note`.
 *
 * @param {(input: string | URL | Request, init?: RequestInit) => Promise<Response>} note
 * @returns {typeof globalThis.fetch}
 */
function reportsOn(note) {
  return async (input, init) => {
    if (new URL(String(input)).pathname !== "/v1/account") {
      return note(input, init);
    }
    assert.equal(String(input), `${PRODUCTION}/v1/account`);
    return account("on");
  };
}

/** @param {"on" | "off"} reports */
function account(reports) {
  return new Response(JSON.stringify({ reports }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * First Draft's acknowledgment of a stored note.
 *
 * @param {{kind: string, compilation_id: string | null}} note
 */
function stored({ kind, compilation_id }) {
  return new Response(
    JSON.stringify({
      note: {
        id: STORED_ID,
        project_id: PROJECT_ID,
        kind,
        compilation_id,
        created_at: "2026-11-21T12:00:00Z",
      },
    }),
    { status: 201, headers: { "Content-Type": "application/json" } },
  );
}

/**
 * @param {number} status
 * @param {string} code
 * @param {string} detail
 */
function problem(status, code, detail) {
  const titles = /** @type {Record<number, string>} */ ({
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    409: "Conflict",
  });
  return new Response(
    JSON.stringify({
      type: "about:blank",
      title: titles[status],
      status,
      code,
      detail,
    }),
    { status, headers: { "Content-Type": "application/problem+json" } },
  );
}

/** @param {string} stateDirectory */
function writeRecord(stateDirectory) {
  writeFileSync(
    path.join(stateDirectory, "compilation.json"),
    `${JSON.stringify({ format: "firstdraft.cli-compilation/1", compilation_id: RECORDED_ID }, null, 2)}\n`,
  );
}

/**
 * @param {import("node:test").TestContext} context
 * @param {string} [origin]
 */
function projectDirectory(context, origin) {
  const cwd = temporaryDirectory(context);
  mkdirSync(path.join(cwd, ".firstdraft"));
  writeState(path.join(cwd, ".firstdraft"), origin);
  return cwd;
}

/**
 * An application root that adopted its Project's directory: the Project's
 * state is archived at .firstdraft/design/.firstdraft.
 *
 * @param {import("node:test").TestContext} context
 */
function adoptedRoot(context) {
  const root = temporaryDirectory(context);
  const design = path.join(root, ".firstdraft", "design", ".firstdraft");
  mkdirSync(design, { recursive: true });
  writeFileSync(path.join(root, ".firstdraft", "gaps.json"), "{}\n");
  writeState(design, PRODUCTION);
  return root;
}

/**
 * @param {string} stateDirectory
 * @param {string} [origin]
 */
function writeState(stateDirectory, origin) {
  writeFileSync(
    path.join(stateDirectory, "state.json"),
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
}

/** @param {import("node:test").TestContext} context */
function temporaryDirectory(context) {
  const cwd = realpathSync(
    mkdtempSync(path.join(tmpdir(), "firstdraft-note-")),
  );
  context.after(() => rmSync(cwd, { recursive: true, force: true }));
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
    cwd: CWD,
    apiToken: TOKEN,
    stagingApiToken: STAGING_TOKEN,
    apiUrl: undefined,
    env: { XDG_CONFIG_HOME: "/nonexistent/firstdraft-test-config" },
    fetchFunction: async () => assert.fail("No network request was expected"),
    ...options,
  });
  return { status, stdout, stderr };
}
