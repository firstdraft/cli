import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const PROJECT_ID = "01900000-0000-7000-8000-000000009201";
const TOKEN = "canary-conversation-token";
const CONVERSATION = '{"role":"user","text":"A movie catalog, please."}\n';
const CONSENT_REQUIRED = {
  error: "consent_required",
  detail:
    "Nothing was sent. Ask the person whether to send this conversation, show them the file, and pass --person-agreed only after they say yes this time.",
};

test("conversation help is printed without a request", async () => {
  for (const argv of [["conversation"], ["conversation", "--help"]]) {
    const result = await invoke(argv);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /send {2}Send one planning conversation file/);
  }

  const help = await invoke(["conversation", "send", "--help"]);
  assert.equal(help.status, 0);
  assert.match(
    help.stdout,
    /firstdraft conversation send <file> --person-agreed/,
  );
  assert.match(help.stdout, /--person-agreed {2}The person said yes/);

  const unknown = await invoke(["conversation", "canary"]);
  assert.equal(unknown.status, 2);
  assert.match(
    unknown.stderr,
    /^Unknown command\.\nRun 'firstdraft conversation --help' for usage\.\n$/,
  );
});

test("conversation send requires the person's yes before reading anything", async () => {
  for (const argv of [
    ["conversation", "send", "canary.jsonl"],
    ["conversation", "send", "canary.jsonl", "--staging"],
  ]) {
    const result = await invoke(argv, { cwd: "/nonexistent/canary" });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.deepEqual(JSON.parse(result.stderr), CONSENT_REQUIRED);
  }

  for (const argv of [
    ["conversation", "send", "--person-agreed"],
    ["conversation", "send", "a", "b", "--person-agreed"],
    ["conversation", "send", "", "--person-agreed"],
    ["conversation", "send", "a", "--person-agreed", "--person-agreed"],
    ["conversation", "send", "a", "--canary"],
  ]) {
    const result = await invoke(argv);
    assert.equal(result.status, 2, argv.join(" "));
    assert.deepEqual(JSON.parse(result.stderr), {
      error: "invalid_arguments",
      detail:
        "Invalid arguments. Run 'firstdraft conversation send --help' for usage.",
    });
  }
});

test("conversation send prints the file and its size, then uploads its bytes once", async (context) => {
  const cwd = projectDirectory(context, PRODUCTION);
  /** @type {{url: string, init: RequestInit | undefined}[]} */
  const requests = [];
  const result = await invoke(
    ["conversation", "send", "transcripts/planning.jsonl", "--person-agreed"],
    {
      cwd,
      fetchFunction: async (input, init) => {
        requests.push({ url: String(input), init });
        return new Response('{"id":"canary"}', {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  );

  const file = path.join(cwd, "transcripts", "planning.jsonl");
  const digest = createHash("sha256").update(CONVERSATION).digest("hex");
  assert.deepEqual(result, {
    status: 0,
    stdout:
      `Sending ${file} (${Buffer.byteLength(CONVERSATION)} bytes, SHA-256 ${digest}) for Project ${PROJECT_ID} ` +
      `to ${PRODUCTION}.\nSent.\n`,
    stderr: "",
  });
  assert.equal(requests.length, 1);
  const [request] = requests;
  assert(request);
  assert.equal(
    request.url,
    `${PRODUCTION}/v1/projects/${PROJECT_ID}/conversations`,
  );
  assert.equal(request.init?.method, "POST");
  assert.equal(
    new Headers(request.init?.headers).get("authorization"),
    `Bearer ${TOKEN}`,
  );
  const form = /** @type {FormData} */ (request.init?.body);
  assert.deepEqual([...form.keys()], ["conversation[file]"]);
  const part = form.get("conversation[file]");
  assert(part instanceof File);
  assert.equal(part.name, "planning.jsonl");
  assert.equal(await part.text(), CONVERSATION);
});

test("conversation send stops on local problems before printing or sending", async (context) => {
  const unpushed = projectDirectory(context);
  const result = await invoke(
    ["conversation", "send", "transcripts/planning.jsonl", "--person-agreed"],
    { cwd: unpushed },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(JSON.parse(result.stderr).error, "project_not_pushed");

  const missingState = await invoke(
    ["conversation", "send", "x.jsonl", "--person-agreed"],
    { cwd: temporaryDirectory(context) },
  );
  assert.equal(missingState.status, 1);
  assert.equal(JSON.parse(missingState.stderr).error, "local_input_unreadable");

  const cwd = projectDirectory(context, PRODUCTION);
  writeFileSync(path.join(cwd, "empty.jsonl"), "");
  mkdirSync(path.join(cwd, "folder"));
  for (const [file, reason] of [
    ["missing.jsonl", "unreadable"],
    ["folder", "unreadable"],
    ["empty.jsonl", "empty"],
  ]) {
    const outcome = await invoke(
      ["conversation", "send", /** @type {string} */ (file), "--person-agreed"],
      { cwd },
    );
    assert.equal(outcome.status, 1);
    assert.equal(outcome.stdout, "");
    assert.deepEqual(JSON.parse(outcome.stderr), {
      error: "conversation_unreadable",
      detail:
        "The conversation file cannot be sent, so nothing was sent. reason says why: unreadable, empty, or too_large.",
      reason,
    });
  }

  const mismatch = await invoke(
    ["conversation", "send", "transcripts/planning.jsonl", "--person-agreed"],
    { cwd },
    ["--staging"],
  );
  assert.equal(mismatch.status, 2);
  assert.equal(mismatch.stdout, "");
  assert.equal(JSON.parse(mismatch.stderr).error, "invalid_configuration");

  const noToken = await invoke(
    ["conversation", "send", "transcripts/planning.jsonl", "--person-agreed"],
    { cwd: projectDirectory(context, STAGING), apiToken: TOKEN },
  );
  assert.equal(noToken.status, 1);
  assert.equal(noToken.stdout, "");
  assert.equal(JSON.parse(noToken.stderr).error, "authentication_required");
});

test("conversation send reports a refusal or an unconfirmed upload without retrying", async (context) => {
  const cwd = projectDirectory(context, PRODUCTION);
  for (const [response, expected] of [
    [
      () =>
        new Response(
          JSON.stringify({
            type: "about:blank",
            title: "Content Too Large",
            status: 413,
            code: "conversation_too_large",
            detail: "Send at most 10 MiB.",
          }),
          {
            status: 413,
            headers: { "Content-Type": "application/problem+json" },
          },
        ),
      {
        error: "conversation_rejected",
        detail:
          "First Draft rejected the conversation, so it was not kept; response.code says why.",
        status: 413,
        response: {
          type: "about:blank",
          title: "Content Too Large",
          status: 413,
          code: "conversation_too_large",
          detail: "Send at most 10 MiB.",
        },
      },
    ],
    [
      () => new Response("<html>Not Found</html>", { status: 404 }),
      {
        error: "conversation_unavailable",
        detail:
          "Could not confirm that First Draft received the conversation, and First Draft may hold it already. Do not send it again without asking the person.",
        status: 404,
      },
    ],
    [
      () => {
        throw new TypeError("canary reset");
      },
      {
        error: "conversation_unavailable",
        detail:
          "Could not confirm that First Draft received the conversation, and First Draft may hold it already. Do not send it again without asking the person.",
      },
    ],
  ]) {
    let requests = 0;
    const result = await invoke(
      ["conversation", "send", "transcripts/planning.jsonl", "--person-agreed"],
      {
        cwd,
        fetchFunction: async () => {
          requests += 1;
          return /** @type {() => Response} */ (response)();
        },
      },
    );
    assert.equal(requests, 1);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^Sending .*planning\.jsonl/);
    assert.deepEqual(JSON.parse(result.stderr), expected);
  }
});

/**
 * @param {import("node:test").TestContext} context
 * @param {string} [origin]
 */
function projectDirectory(context, origin) {
  const cwd = temporaryDirectory(context);
  mkdirSync(path.join(cwd, ".firstdraft"));
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
  mkdirSync(path.join(cwd, "transcripts"));
  writeFileSync(path.join(cwd, "transcripts", "planning.jsonl"), CONVERSATION);
  return cwd;
}

/** @param {import("node:test").TestContext} context */
function temporaryDirectory(context) {
  const cwd = realpathSync(
    mkdtempSync(path.join(tmpdir(), "firstdraft-conversation-")),
  );
  context.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

/**
 * @param {readonly string[]} argv
 * @param {Partial<import("../src/cli.js").RunOptions>} [options]
 * @param {readonly string[]} [prefix] root arguments before the command
 */
async function invoke(argv, options = {}, prefix = []) {
  let stdout = "";
  let stderr = "";
  const status = await run({
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
    apiToken: TOKEN,
    stagingApiToken: "",
    apiUrl: undefined,
    env: { XDG_CONFIG_HOME: "/nonexistent/firstdraft-test-config" },
    fetchFunction: async () => assert.fail("No network request was expected"),
    ...options,
    argv: [...prefix, ...argv],
  });
  return { status, stdout, stderr };
}
