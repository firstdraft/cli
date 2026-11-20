import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { run } from "../src/cli.js";
import { CompilationRetainedError } from "../src/commands/compilation.js";
import {
  API_CONTRACT_RANGE,
  ApiContractUnsupportedError,
  RateLimitedError,
  UpdateRequiredError,
  compareVersions,
  createServiceSession,
} from "../src/service-client.js";
import { VERSION } from "../src/version.js";

const ORIGIN = "https://firstdraft.com";
const PROJECT_ID = "01900000-0000-7000-8000-000000009001";
const COMPILATION_ID = "01900000-0000-7000-8000-000000009002";
const TOKEN = "canary-service-token";
const ETAG = '"sha256:' + "a".repeat(64) + '"';
const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const UPDATE_URL = "https://firstdraft.com/update";

test("FirstDraft-Client names the CLI, plugin, agent, and operating system", async () => {
  /** @type {Headers[]} */
  const sent = [];
  const session = createServiceSession({
    env: { FIRSTDRAFT_PLUGIN_VERSION: "0.10.2", FIRSTDRAFT_AGENT: "codex" },
    notify: () => assert.fail("No update line was expected"),
    platform: "linux",
  });
  const request = session.fetch(async (_input, init) => {
    sent.push(new Headers(init?.headers));
    return new Response(null, { status: 204 });
  });

  await request(new URL("/v1/account", ORIGIN), {
    headers: { Authorization: "Bearer x" },
  });
  await request(new URL("/oauth/token", ORIGIN), {});

  for (const headers of sent) {
    assert.equal(
      headers.get("firstdraft-client"),
      `cli/${VERSION}; plugin/0.10.2; agent/codex; os/linux`,
    );
  }
  assert.equal(sent[0]?.get("authorization"), "Bearer x");
});

test("FirstDraft-Client keeps to the grammar the Service parses", () => {
  const session = createServiceSession({
    env: {
      FIRSTDRAFT_PLUGIN_VERSION: "0.10.2+ci.7",
      FIRSTDRAFT_AGENT: "Codex",
    },
    notify: () => undefined,
    platform: "win32",
  });
  assert.equal(
    session.clientHeader,
    `cli/${VERSION}; plugin/0.10.2; agent/codex; os/win32`,
  );
});

test("FirstDraft-Client leaves out a value longer than the Service accepts", () => {
  const long = `0.10.0-${"a".repeat(58)}`;
  assert.equal(
    createServiceSession({
      env: { FIRSTDRAFT_PLUGIN_VERSION: long, FIRSTDRAFT_AGENT: "codex" },
      notify: () => undefined,
      platform: "linux",
    }).clientHeader,
    `cli/${VERSION}; agent/codex; os/linux`,
  );
});

test("FirstDraft-Client omits parts that are unknown or not safe to send", async () => {
  for (const env of [
    {},
    { FIRSTDRAFT_PLUGIN_VERSION: "latest", FIRSTDRAFT_AGENT: "" },
    { FIRSTDRAFT_PLUGIN_VERSION: "0.10", FIRSTDRAFT_AGENT: "claude code" },
    { FIRSTDRAFT_PLUGIN_VERSION: "v0.10.0", FIRSTDRAFT_AGENT: "a\nb" },
  ]) {
    const session = createServiceSession({
      env,
      notify: () => undefined,
      platform: "darwin",
    });
    assert.equal(session.clientHeader, `cli/${VERSION}; os/darwin`);
  }
  assert.equal(
    createServiceSession({
      env: {},
      notify: () => undefined,
      platform: "Bad Platform",
    }).clientHeader,
    `cli/${VERSION}`,
  );
});

test("an older plugin prints one update line per command, however many requests it makes", async () => {
  /** @type {string[]} */
  const lines = [];
  const session = createServiceSession({
    env: { FIRSTDRAFT_PLUGIN_VERSION: "0.10.0" },
    notify: (line) => lines.push(line),
  });
  const request = session.fetch(async () =>
    versionedResponse({ latest: "0.10.1", minimum: "0.10.0" }),
  );

  for (let index = 0; index < 3; index += 1) {
    await request(new URL("/v1/account", ORIGIN), {});
  }

  // The line waits for the command's outcome, then comes just before it.
  assert.deepEqual(lines, []);
  assert.equal(await session.settle(Promise.resolve("done")), "done");
  session.flush();
  assert.deepEqual(lines, [
    `First Draft: an update is available (plugin 0.10.1; this setup has plugin 0.10.0). Tell the person the update steps are at ${UPDATE_URL}\n`,
  ]);
});

test("without a plugin version the CLI compares itself with the CLI versions", async () => {
  /** @type {string[]} */
  const lines = [];
  const session = createServiceSession({
    env: {},
    notify: (line) => lines.push(line),
  });
  await session.fetch(async () =>
    versionedResponse({
      latest: "99.0.0",
      minimum: "99.0.0",
      latestCli: "98.0.0",
    }),
  )(new URL("/v1/account", ORIGIN), {});
  assert.equal(await session.settle(Promise.resolve("done")), "done");

  assert.deepEqual(lines, [
    `First Draft: an update is available (CLI 98.0.0; this setup has CLI ${VERSION}). Tell the person the update steps are at ${UPDATE_URL}\n`,
  ]);
});

test("each setup reads only its own pair of version headers", async () => {
  for (const [
    env,
    versions,
  ] of /** @type {[Record<string, string>, Record<string, string>][]} */ ([
    // A plugin ignores the CLI versions.
    [
      { FIRSTDRAFT_PLUGIN_VERSION: "0.10.0" },
      { latestCli: "99.0.0", minimumCli: "99.0.0" },
    ],
    // A bare CLI ignores the plugin versions, and an older Service sends no CLI pair.
    [{}, { latest: "99.0.0", minimum: "99.0.0" }],
    [{}, {}],
  ])) {
    const session = createServiceSession({
      env,
      notify: () =>
        assert.fail(`No line was expected for ${JSON.stringify(versions)}`),
    });
    const request = session.fetch(async () => versionedResponse(versions));
    await request(new URL("/v1/account", ORIGIN), {});
    await request(new URL("/v1/account", ORIGIN), {});
    assert.equal(await session.settle(Promise.resolve("done")), "done");
  }
});

test("a current, newer, or unreadable latest version prints nothing", async () => {
  for (const latest of ["0.10.0", "0.9.9", "0.10.0-rc.1", "soon", ""]) {
    const session = createServiceSession({
      env: { FIRSTDRAFT_PLUGIN_VERSION: "0.10.0" },
      notify: () => assert.fail(`No update line was expected for ${latest}`),
    });
    await session.fetch(async () => versionedResponse({ latest }))(
      new URL("/v1/account", ORIGIN),
      {},
    );
  }
});

test("below the minimum, the CLI finishes that response and sends nothing more", async () => {
  let requests = 0;
  const session = createServiceSession({
    env: { FIRSTDRAFT_PLUGIN_VERSION: "0.9.3" },
    notify: () => assert.fail("A cut-short command prints no stop line"),
  });
  const request = session.fetch(async () => {
    requests += 1;
    return versionedResponse({ latest: "0.10.1", minimum: "0.10.0" });
  });

  const response = await request(new URL("/v1/account", ORIGIN), {});
  assert.equal(response.status, 200);
  const blocked = request(new URL("/v1/account", ORIGIN), {});
  await assert.rejects(blocked, UpdateRequiredError);
  assert.equal(requests, 1);

  const cause = new Error("the blocked request failed");
  await assert.rejects(session.settle(Promise.reject(cause)), (error) => {
    assert(error instanceof UpdateRequiredError);
    assert.equal(error.component, "plugin");
    assert.equal(error.installed, "0.9.3");
    assert.equal(error.minimum, "0.10.0");
    assert.equal(error.replaced, cause);
    return true;
  });
});

test("a stop that did not cut the command short keeps its result and names the stop", async () => {
  const stopLine = `First Draft: First Draft requires plugin 0.10.0 or later, and this setup has plugin 0.9.3. This command finished; tell the person to update with the steps at ${UPDATE_URL} before the next one.\n`;
  for (const work of [
    Promise.resolve("finished"),
    Promise.reject(new TypeError("its own local failure")),
  ]) {
    /** @type {string[]} */
    const lines = [];
    const session = createServiceSession({
      env: { FIRSTDRAFT_PLUGIN_VERSION: "0.9.3" },
      notify: (line) => lines.push(line),
    });
    await session.fetch(async () => versionedResponse({ minimum: "0.10.0" }))(
      new URL("/v1/account", ORIGIN),
      {},
    );

    const outcome = await session.settle(work).then(
      (value) => value,
      (error) => error,
    );
    assert.equal(outcome, await work.catch((error) => error));
    assert.deepEqual(lines, [stopLine]);
  }
});

test("the CLI accepts only its declared API contract range", async () => {
  assert.deepEqual(API_CONTRACT_RANGE, [">= 0.9.0", "< 0.10.0"]);

  for (const contract of [
    "0.9.0",
    "0.9.7",
    "  0.9.1 ",
    "0.9.2+build.7",
    "unknown",
    "0.10",
  ]) {
    const session = createServiceSession({
      env: {},
      notify: () => assert.fail(`${contract} is accepted`),
    });
    await session.fetch(async () => versionedResponse({ contract }))(
      new URL("/v1/account", ORIGIN),
      {},
    );
    assert.equal(await session.settle(Promise.resolve(contract)), contract);
  }

  for (const [contract, kind] of /** @type {[string, string][]} */ ([
    ["0.10.0", "newer"],
    ["0.10.0+build.7", "newer"],
    ["0.10.0-rc.1", "newer"],
    ["1.0.0", "newer"],
    ["0.8.1", "older"],
    ["0.9.0-rc.1", "older"],
    ["0.9.1-rc.1", "prerelease"],
  ])) {
    const session = createServiceSession({ env: {}, notify: () => undefined });
    const request = session.fetch(async () => versionedResponse({ contract }));
    await request(new URL("/v1/account", ORIGIN), {});
    const cutShort = request(new URL("/v1/account", ORIGIN), {});
    await assert.rejects(session.settle(cutShort), (error) => {
      assert(error instanceof ApiContractUnsupportedError);
      assert.equal(error.contract, contract);
      assert.equal(error.kind, kind);
      assert.equal(error.origin, ORIGIN);
      return true;
    });
  }
});

test("a 429 stops the command with the retry time and the validated problem", async () => {
  for (const [
    retryAfter,
    retryAt,
  ] of /** @type {[string | null, string | undefined][]} */ ([
    ["3600", "2026-11-20T13:00:00Z"],
    ["Fri, 21 Nov 2026 00:00:00 GMT", "2026-11-21T00:00:00Z"],
    ["tomorrow-ish", undefined],
    [null, undefined],
  ])) {
    const session = createServiceSession({
      env: {},
      notify: () => assert.fail("A 429 replaces the result"),
      now: () => NOW,
    });
    const response = await session.fetch(async () => limitResponse(retryAfter))(
      new URL("/v1/projects/x/compilations", ORIGIN),
      {},
    );
    const limit = /** @type {{code: string}} */ (await response.json());
    assert.equal(limit.code, "daily_compilation_limit");

    await assert.rejects(session.settle(Promise.resolve()), (error) => {
      assert(error instanceof RateLimitedError);
      assert.equal(error.retryAt, retryAt);
      assert.deepEqual(error.response, LIMIT_PROBLEM);
      return true;
    });
  }
});

test("a 429 that is the command's first response still carries the update notice", async () => {
  /** @type {string[]} */
  const lines = [];
  const session = createServiceSession({
    env: { FIRSTDRAFT_PLUGIN_VERSION: "0.10.0" },
    notify: (line) => lines.push(line),
    now: () => NOW,
  });
  const limited = limitResponse("60");
  limited.headers.set("FirstDraft-Latest-Plugin", "0.10.1");
  await session.fetch(async () => limited)(new URL("/v1/account", ORIGIN), {});
  await assert.rejects(session.settle(Promise.resolve()), RateLimitedError);
  assert.equal(lines.length, 1);
  assert.match(String(lines[0]), /^First Draft: an update is available/);
});

test("a 429 reports the limit even when the response also requires an update", async () => {
  for (const headers of [
    { "FirstDraft-Minimum-CLI": "99.0.0" },
    { "FirstDraft-API-Contract": "0.10.0" },
  ]) {
    const session = createServiceSession({
      env: {},
      notify: () => assert.fail("The limit is the command's outcome"),
      now: () => NOW,
    });
    const limited = limitResponse("3600");
    for (const [name, value] of Object.entries(headers)) {
      limited.headers.set(name, value);
    }
    await session.fetch(async () => limited)(
      new URL("/v1/account", ORIGIN),
      {},
    );
    await assert.rejects(session.settle(Promise.resolve()), (error) => {
      assert(error instanceof RateLimitedError);
      assert.equal(error.retryAt, "2026-11-20T13:00:00Z");
      return true;
    });
  }
});

test("the stop line for an older or prerelease contract does not advise updating", async () => {
  for (const [contract, sentence] of /** @type {[string, string][]} */ ([
    ["0.8.7", "serves API contract 0.8.7, which is older than"],
    ["0.9.1-rc.1", "serves prerelease API contract 0.9.1-rc.1, which"],
  ])) {
    /** @type {string[]} */
    const lines = [];
    const session = createServiceSession({
      env: {},
      notify: (line) => lines.push(line),
    });
    await session.fetch(async () => versionedResponse({ contract }))(
      new URL("/v1/account", ORIGIN),
      {},
    );
    assert.equal(await session.settle(Promise.resolve("done")), "done");
    assert.equal(lines.length, 1);
    assert.ok(lines[0]?.includes(sentence), lines[0]);
    assert.ok(
      lines[0]?.endsWith(
        "This command finished; use the CLI version that this First Draft origin supports before the next one.\n",
      ),
      lines[0],
    );
  }
});

test("a command writes one version line, the stop line replacing an earlier notice", async () => {
  /** @type {string[]} */
  const lines = [];
  const session = createServiceSession({
    env: { FIRSTDRAFT_PLUGIN_VERSION: "0.10.0" },
    notify: (line) => lines.push(line),
  });
  const request = session.fetch(
    (() => {
      const responses = [
        versionedResponse({ latest: "0.10.1", minimum: "0.9.0" }),
        versionedResponse({ latest: "0.11.0", minimum: "0.11.0" }),
      ];
      return async () => /** @type {Response} */ (responses.shift());
    })(),
  );
  await request(new URL("/v1/account", ORIGIN), {});
  assert.deepEqual(lines, []);
  await request(new URL("/v1/account", ORIGIN), {});
  assert.equal(await session.settle(Promise.resolve("done")), "done");
  assert.deepEqual(lines, [
    `First Draft: First Draft requires plugin 0.11.0 or later, and this setup has plugin 0.10.0. This command finished; tell the person to update with the steps at ${UPDATE_URL} before the next one.\n`,
  ]);
});

test("SemVer precedence orders prereleases before their release", () => {
  const ordered = [
    "0.9.0-alpha",
    "0.9.0-alpha.1",
    "0.9.0-alpha.beta",
    "0.9.0-beta.2",
    "0.9.0-beta.11",
    "0.9.0-rc.1",
    "0.9.0",
    "0.9.1",
    "0.10.0",
    "1.0.0",
  ].map(parse);

  for (let index = 1; index < ordered.length; index += 1) {
    const [left, right] = [ordered[index - 1], ordered[index]];
    assert(left && right);
    assert.equal(
      compareVersions(left, right),
      -1,
      `${left.text} < ${right.text}`,
    );
    assert.equal(compareVersions(right, left), 1);
    assert.equal(compareVersions(left, left), 0);
  }
});

test("an oversized 429 body is read once and does not stall the command", async () => {
  const chunk = new Uint8Array(16 * 1024).fill(32);
  let pulls = 0;
  const session = createServiceSession({ env: {}, notify: () => undefined });
  const response = await session.fetch(
    async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            pulls += 1;
            if (pulls > 10) controller.close();
            else controller.enqueue(chunk);
          },
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/problem+json",
            "Retry-After": "60",
          },
        },
      ),
  )(new URL("/v1/projects/x/compilations", ORIGIN), {});

  assert.equal(response.status, 429);
  assert.equal(await response.text(), "");
  await assert.rejects(session.settle(Promise.resolve()), (error) => {
    assert(error instanceof RateLimitedError);
    assert.equal(error.response, null);
    return true;
  });
});

test("plan push keeps its accepted result below the minimum and names the stop", async (context) => {
  const cwd = await initializedProject(context);
  let requests = 0;
  const result = await invoke(["plan", "push"], {
    cwd,
    env: { FIRSTDRAFT_PLUGIN_VERSION: "0.9.3" },
    fetchFunction: async () => {
      requests += 1;
      return acceptedPush(cwd, { minimum: "0.10.0" });
    },
  });

  assert.equal(requests, 1);
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).etag, ETAG);
  assert.equal(
    result.stderr,
    `First Draft: First Draft requires plugin 0.10.0 or later, and this setup has plugin 0.9.3. This command finished; tell the person to update with the steps at ${UPDATE_URL} before the next one.\n`,
  );
  assert.equal(readState(cwd).foundation_plan_etag, ETAG);
});

test("plan compile sends nothing after a response below the minimum", async (context) => {
  const cwd = await initializedProject(context);
  /** @type {string[]} */
  const requests = [];
  const result = await invoke(["plan", "compile", "--output", "application"], {
    cwd,
    env: {},
    fetchFunction: async (input, init) => {
      requests.push(`${init?.method} ${new URL(String(input)).pathname}`);
      return acceptedPush(cwd, { minimumCli: "99.0.0" });
    },
  });

  assert.deepEqual(requests, [
    `PUT /v1/projects/${PROJECT_ID}/foundation-plan`,
  ]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(errorEnvelope(result.stderr), {
    error: "update_required",
    detail: `First Draft requires CLI 99.0.0 or later, and this setup has CLI ${VERSION}. The CLI stopped before the command finished and sent nothing more. Tell the person to update with the steps at ${UPDATE_URL}, then run the same command again, with the same options.`,
    cli_version: VERSION,
    minimum_cli_version: "99.0.0",
    update_url: UPDATE_URL,
  });
  assert.equal(readState(cwd).foundation_plan_etag, ETAG);
});

test("a stop after a Compilation started names it instead of advising another", async (context) => {
  const cwd = await initializedProject(context);
  const current = {
    project: { id: PROJECT_ID, graph_version: 1 },
    compilation: { id: COMPILATION_ID, status: "queued" },
  };
  const result = await invoke(["plan", "compile", "--output", "application"], {
    cwd,
    planCompilePush: async () => ({
      outcome: "updated",
      etag: ETAG,
      status: 200,
      body: {
        project: { id: PROJECT_ID, graph_version: 1 },
        foundation_plan: { source_sha256: "a".repeat(64) },
        diagnostics: [],
      },
    }),
    planCompileReadStatus: async () => ({
      status: 200,
      body: /** @type {any} */ ({
        project: { id: PROJECT_ID, graph_version: 1 },
        analysis: {
          id: COMPILATION_ID,
          graph_version: 1,
          head_source_sha256: "a".repeat(64),
          status: "valid",
          compiler_release: "release",
          target: { id: "rails", profile: "profile" },
        },
      }),
    }),
    planCompileDownload: async ({ fetchFunction }) => {
      assert(fetchFunction);
      const url = new URL(`/v1/projects/${PROJECT_ID}/compilations`, ORIGIN);
      await fetchFunction(url, {});
      const error = await fetchFunction(url, {}).catch((cause) => cause);
      throw new CompilationRetainedError(error, /** @type {any} */ (current));
    },
    fetchFunction: async () => versionedResponse({ minimumCli: "99.0.0" }),
  });

  assert.equal(result.status, 1);
  assert.deepEqual(errorEnvelope(result.stderr), {
    error: "update_required",
    detail: `First Draft requires CLI 99.0.0 or later, and this setup has CLI ${VERSION}. The CLI stopped before the command finished and sent nothing more. Tell the person to update with the steps at ${UPDATE_URL}, then follow the Compilation that had already started with 'firstdraft compilation status ${COMPILATION_ID}' instead of compiling again.`,
    cli_version: VERSION,
    minimum_cli_version: "99.0.0",
    update_url: UPDATE_URL,
    current,
  });
});

test("a Service outside the API contract range is refused with both versions", async (context) => {
  const cwd = await initializedProject(context);
  const result = await invoke(["plan", "compile", "--output", "application"], {
    cwd,
    fetchFunction: async () => acceptedPush(cwd, { contract: "0.10.0" }),
  });

  assert.equal(result.status, 1);
  assert.deepEqual(errorEnvelope(result.stderr), {
    error: "api_contract_unsupported",
    detail: `First Draft at ${ORIGIN} serves API contract 0.10.0, which is newer than CLI ${VERSION} accepts. The CLI stopped before the command finished and sent nothing more. Tell the person to update with the steps at ${UPDATE_URL}, then run the same command again, with the same options.`,
    api_contract: "0.10.0",
    accepted_api_contract: [">= 0.9.0", "< 0.10.0"],
    cli_version: VERSION,
    update_url: UPDATE_URL,
  });
});

test("a daily cap reports rate_limited with when to try again", async (context) => {
  const cwd = await initializedProject(context);
  const result = await invoke(["plan", "push"], {
    cwd,
    serviceNow: () => NOW,
    fetchFunction: async () => limitResponse("43200"),
  });

  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stderr), {
    error: "rate_limited",
    detail:
      "First Draft refused a request because this account reached one of its limits. The refused request did nothing, and the CLI sent nothing after it. Try again after 2026-11-21T00:00:00Z; response.detail, when present, says which limit.",
    status: 429,
    retry_at: "2026-11-21T00:00:00Z",
    response: LIMIT_PROBLEM,
  });
  assert.equal(readState(cwd).foundation_plan_etag, undefined);
});

test("the update line precedes the command's own output on stderr", async (context) => {
  const cwd = await initializedProject(context);
  const result = await invoke(["plan", "push"], {
    cwd,
    env: { FIRSTDRAFT_PLUGIN_VERSION: "0.10.0" },
    fetchFunction: async () =>
      acceptedPush(cwd, { latest: "0.10.4", minimum: "0.10.0" }),
  });

  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).etag, ETAG);
  assert.equal(
    result.stderr,
    `First Draft: an update is available (plugin 0.10.4; this setup has plugin 0.10.0). Tell the person the update steps are at ${UPDATE_URL}\n`,
  );
});

const LIMIT_PROBLEM = {
  type: "about:blank",
  title: "Too Many Requests",
  status: 429,
  code: "daily_compilation_limit",
  detail:
    "This account has started 50 Compilations today. Try again after midnight UTC.",
};

/** @param {string | null} retryAfter */
function limitResponse(retryAfter) {
  return new Response(JSON.stringify(LIMIT_PROBLEM), {
    status: 429,
    headers: {
      "Content-Type": "application/problem+json",
      ...(retryAfter === null ? {} : { "Retry-After": retryAfter }),
    },
  });
}

/**
 * @param {{latest?: string, minimum?: string, latestCli?: string, minimumCli?: string, contract?: string}} versions
 * @param {string | null} [body]
 * @param {Record<string, string>} [headers]
 */
function versionedResponse(
  { latest, minimum, latestCli, minimumCli, contract },
  body = null,
  headers = {},
) {
  return new Response(body, {
    status: body === null ? 200 : 201,
    headers: {
      ...headers,
      ...(latest === undefined ? {} : { "FirstDraft-Latest-Plugin": latest }),
      ...(minimum === undefined
        ? {}
        : { "FirstDraft-Minimum-Plugin": minimum }),
      ...(latestCli === undefined
        ? {}
        : { "FirstDraft-Latest-CLI": latestCli }),
      ...(minimumCli === undefined
        ? {}
        : { "FirstDraft-Minimum-CLI": minimumCli }),
      ...(contract === undefined
        ? {}
        : { "FirstDraft-API-Contract": contract }),
    },
  });
}

/**
 * @param {string} cwd
 * @param {{latest?: string, minimum?: string, latestCli?: string, minimumCli?: string, contract?: string}} versions
 */
function acceptedPush(cwd, versions) {
  const source = readFileSync(
    path.join(cwd, ".firstdraft", "foundation-plan.json"),
  );
  return versionedResponse(
    versions,
    JSON.stringify({
      project: { id: PROJECT_ID, graph_version: 1 },
      foundation_plan: {
        format: "firstdraft.foundation-plan.sketch/0.23",
        source_sha256: createHash("sha256").update(source).digest("hex"),
      },
      diagnostics: [],
    }),
    { "Content-Type": "application/json", ETag: ETAG },
  );
}

/** @param {string} value */
function parse(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(value);
  assert(match);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split("."),
    text: value,
    release: value,
  };
}

/** @param {import("node:test").TestContext} context */
async function initializedProject(context) {
  const cwd = mkdtempSync(path.join(tmpdir(), "firstdraft-service-"));
  context.after(() => rmSync(cwd, { recursive: true, force: true }));
  const result = await invoke(["plan", "init", "--name", "Oscar Party"], {
    cwd,
    createProjectId: () => PROJECT_ID,
  });
  assert.equal(result.status, 0);
  return cwd;
}

/** @param {string} cwd */
function readState(cwd) {
  return JSON.parse(
    readFileSync(path.join(cwd, ".firstdraft", "state.json"), "utf8"),
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
    apiToken: TOKEN,
    stagingApiToken: "",
    apiUrl: undefined,
    env: {},
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
