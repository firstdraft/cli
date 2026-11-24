import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { run } from "../src/cli.js";
import { ToolUnavailableError, fingerprint } from "../src/host-tools.js";

const PROJECT_ID = "01900000-0000-7000-8000-000000009001";
const API_TOKEN = `fd_canary${"h".repeat(37)}`;
const API_URL = "https://api.example.test";
const BASE = `/v1/projects/${PROJECT_ID}/environments/production/host`;
const PUBLIC_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGNhbmFyeS1ub3QtYS1yZWFsLWtleS0wMDAwMDAw firstdraft-test";
const PRIVATE_KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\ncanary-private\n";
const IPV4 = "203.0.113.10";
const SSLIP = "203-0-113-10.sslip.io";
const CREATED_AT = "2026-11-24T12:00:00Z";
const ENVIRONMENT = { project_id: PROJECT_ID, name: "production" };
const WORKFLOW = `name: CI
jobs:
  ci:
    runs-on: ubuntu-latest
  deploy:
    needs: [ci]
`;

test("host help lists its commands, and each command has help", async (context) => {
  const cwd = appDirectory(context);
  const group = await invoke(["host", "--help"], { cwd });
  assert.equal(group.status, 0);
  for (const command of [
    "create",
    "status",
    "resize",
    "destroy",
    "domain",
    "email",
  ]) {
    assert.match(group.stdout, new RegExp(`^ {2}${command} `, "m"));
    const help = await invoke(["host", command, "--help"], { cwd });
    assert.equal(help.status, 0);
    assert.match(help.stdout, new RegExp(`firstdraft host ${command}`));
  }

  const root = await invoke(["--help"], { cwd });
  assert.match(root.stdout, /^ {2}host {9}Create and operate/m);

  const bare = await invoke(["host"], { cwd });
  assert.deepEqual(bare, group);
});

test("invalid host arguments exit 2 before any request", async (context) => {
  const cwd = appDirectory(context);
  for (const argv of [
    ["host", "unknown"],
    ["host", "status", "--environment", "Production"],
    ["host", "status", "extra"],
    ["host", "status", "--wait", "--wait"],
    ["host", "resize", "--yes"],
    ["host", "create", "--size", "../x"],
    ["host", "domain", "connect"],
    ["host", "domain", "connect", "not a host"],
    ["host", "domain", "renew"],
    ["host", "email", "rotate"],
  ]) {
    const result = await invoke(argv, { cwd });
    assertHandledFailure(result, "invalid_arguments", 2);
  }
});

test("resize and destroy need the owner's confirmation before any request", async (context) => {
  const cwd = appDirectory(context);
  for (const argv of [
    ["host", "resize", "--size", "s-1vcpu-2gb"],
    ["host", "destroy"],
    ["host", "destroy", "--confirm", "staging"],
  ]) {
    const result = await invoke(argv, { cwd });
    assertHandledFailure(result, "confirmation_required", 2);
    assert.match(JSON.parse(result.stderr).detail, /Ask the owner/);
  }
});

test("create refuses an app without Kamal deploy files", async (context) => {
  const cwd = appDirectory(context, { deployFiles: false });
  const result = await invoke(["host", "create"], { cwd });
  assertHandledFailure(result, "deploy_files_missing");
  assert.deepEqual(JSON.parse(result.stderr).missing, [
    "config/deploy.yml",
    ".github/workflows/ci.yml",
  ]);

  const noJob = appDirectory(context, { workflow: "jobs:\n  ci:\n" });
  const second = await invoke(["host", "create"], { cwd: noJob });
  assertHandledFailure(second, "deploy_files_missing");
  assert.deepEqual(JSON.parse(second.stderr).missing, [
    ".github/workflows/ci.yml job deploy",
  ]);
});

test("create generates the key, creates the host, stores secrets, and connects the repository", async (context) => {
  const cwd = appDirectory(context);
  const config = configDirectory(context);
  const service = routes({
    [`GET ${BASE}`]: [
      problem(404, "host_not_found"),
      json({
        environment: ENVIRONMENT,
        host: host({ state: "ready", ipv4: IPV4 }),
      }),
    ],
    [`POST ${BASE}`]: [json({ environment: ENVIRONMENT, host: host() }, 202)],
  });
  const tools = toolRunner({
    variables: [],
    secrets: [],
    run: {
      conclusion: "failure",
      jobs: [job("ci", "failure"), job("deploy", "skipped")],
    },
  });
  const result = await invoke(["host", "create"], {
    cwd,
    env: { XDG_CONFIG_HOME: config },
    fetchFunction: service.fetch,
    hostTools: tools.run,
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.step, "connected");
  assert.equal(output.host.state, "ready");
  assert.equal(output.url, `https://${SSLIP}`);
  assert.deepEqual(output.github, {
    repository: "owner/app",
    secrets: ["SSH_PRIVATE_KEY", "SECRET_KEY_BASE", "POSTGRES_PASSWORD"],
    variables: ["DEPLOY_HOST", "APP_HOST"],
  });
  assert.deepEqual(output.checks.failed_jobs, ["ci"]);
  assert.match(output.next, /Nothing is deployed: CI failed on main \(ci\)/);
  assert.match(output.next, /Behavior to write/);

  const create = service.calls.find((call) => call.method === "POST");
  assert.deepEqual(JSON.parse(String(create?.body)), {
    host: { ssh_public_key: PUBLIC_KEY },
  });
  assert.equal(create?.authorization, `Bearer ${API_TOKEN}`);

  const secretCalls = tools.calls.filter(
    (call) =>
      call.command === "gh" &&
      call.args[0] === "secret" &&
      call.args[1] === "set",
  );
  assert.deepEqual(
    secretCalls.map((call) => call.args),
    [
      ["secret", "set", "SSH_PRIVATE_KEY"],
      ["secret", "set", "SECRET_KEY_BASE"],
      ["secret", "set", "POSTGRES_PASSWORD"],
    ],
  );
  assert.equal(secretCalls[0]?.input, PRIVATE_KEY);
  assert.match(String(secretCalls[1]?.input), /^[0-9a-f]{128}$/);
  assert.match(String(secretCalls[2]?.input), /^[0-9a-f]{48}$/);
  assert.deepEqual(
    tools.calls
      .filter((call) => call.args[0] === "variable" && call.args[1] === "set")
      .map((call) => call.args),
    [
      ["variable", "set", "APP_HOST", "--body", SSLIP],
      ["variable", "set", "DEPLOY_HOST", "--body", IPV4],
    ],
  );
  const sshCall = tools.calls.find((call) => call.command === "ssh");
  assert.equal(sshCall?.args.at(-2), `root@${IPV4}`);
  assert.equal(sshCall?.args.at(-1), "cloud-init status");
  assert.ok(sshCall?.args.includes("StrictHostKeyChecking=accept-new"));

  for (const secret of secretCalls) {
    assert.ok(!result.stdout.includes(String(secret.input)));
    assert.ok(!result.stderr.includes(String(secret.input)));
  }
  assertNoSecrets(result);
});

test("create resumes without a second host and keeps existing generated secrets", async (context) => {
  const cwd = appDirectory(context);
  const config = configDirectory(context, { key: true });
  const service = routes({
    [`GET ${BASE}`]: [
      json({
        environment: ENVIRONMENT,
        host: host({ state: "ready", ipv4: IPV4 }),
      }),
    ],
  });
  const tools = toolRunner({
    variables: [
      { name: "DEPLOY_HOST", value: IPV4 },
      { name: "APP_HOST", value: SSLIP },
    ],
    secrets: ["SSH_PRIVATE_KEY", "SECRET_KEY_BASE", "POSTGRES_PASSWORD"],
    run: null,
  });
  const result = await invoke(["host", "create"], {
    cwd,
    env: { XDG_CONFIG_HOME: config },
    fetchFunction: service.fetch,
    hostTools: tools.run,
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.step, "connected");
  assert.match(output.next, /Push to main/);
  assert.equal(
    service.calls.filter((call) => call.method === "POST").length,
    0,
  );
  assert.deepEqual(
    tools.calls
      .filter((call) => call.args[1] === "set")
      .map((call) => call.args.slice(0, 3)),
    [["secret", "set", "SSH_PRIVATE_KEY"]],
  );
  assert.equal(tools.calls.filter((call) => call.command === "ssh").length, 0);
  assert.equal(
    tools.calls.filter((call) => call.command === "ssh-keygen").length,
    0,
  );
});

test("create stops at the wait limit while the Droplet sets itself up", async (context) => {
  const cwd = appDirectory(context);
  const config = configDirectory(context, { key: true });
  let clock = 0;
  const service = routes({
    [`GET ${BASE}`]: [
      json({
        environment: ENVIRONMENT,
        host: host({ state: "ready", ipv4: IPV4 }),
      }),
    ],
  });
  const tools = toolRunner({
    variables: [],
    secrets: [],
    run: null,
    cloudInit: "status: running",
  });
  const result = await invoke(["host", "create"], {
    cwd,
    env: { XDG_CONFIG_HOME: config },
    fetchFunction: service.fetch,
    hostTools: tools.run,
    hostNow: () => clock,
    hostSleep: async (/** @type {number} */ ms) => {
      clock += ms;
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.step, "setting_up");
  assert.equal(output.checks, null);
  assert.match(output.next, /run 'firstdraft host create' again/);
  assert.equal(
    tools.calls.filter(
      (call) => call.args[0] === "variable" && call.args[1] === "set",
    ).length,
    0,
  );
});

test("create refuses a host whose key this computer does not hold", async (context) => {
  const cwd = appDirectory(context);
  const config = configDirectory(context);
  const service = routes({
    [`GET ${BASE}`]: [
      json({
        environment: ENVIRONMENT,
        host: host({ state: "ready", ipv4: IPV4 }),
      }),
    ],
  });
  const tools = toolRunner({ variables: [], secrets: [], run: null });
  const result = await invoke(["host", "create"], {
    cwd,
    env: { XDG_CONFIG_HOME: config },
    fetchFunction: service.fetch,
    hostTools: tools.run,
  });

  assertHandledFailure(result, "host_key_missing");
  assert.equal(
    tools.calls.filter(
      (call) => call.args[0] === "secret" && call.args[1] === "set",
    ).length,
    0,
  );
});

test("create reports a missing gh and a failed gh command", async (context) => {
  const cwd = appDirectory(context);
  const missing = await invoke(["host", "create"], {
    cwd,
    env: { XDG_CONFIG_HOME: configDirectory(context) },
    hostTools: () => {
      throw new ToolUnavailableError("gh");
    },
  });
  assertHandledFailure(missing, "tool_unavailable");
  assert.equal(JSON.parse(missing.stderr).tool, "gh");

  const failed = await invoke(["host", "create"], {
    cwd,
    env: { XDG_CONFIG_HOME: configDirectory(context) },
    hostTools: () => ({
      status: 1,
      stdout: "",
      stderr: "To get started with GitHub CLI, please run:  gh auth login\n",
    }),
  });
  assertHandledFailure(failed, "github_failed");
  assert.deepEqual(
    {
      command: JSON.parse(failed.stderr).command,
      message: JSON.parse(failed.stderr).message,
    },
    {
      command: "gh repo view",
      message: "To get started with GitHub CLI, please run:  gh auth login",
    },
  );
});

test("status says when there is no host", async (context) => {
  const service = routes({ [`GET ${BASE}`]: [problem(404, "host_not_found")] });
  const result = await invoke(["host", "status"], {
    cwd: appDirectory(context),
    fetchFunction: service.fetch,
    hostTools: toolRunner({ variables: [], secrets: [], run: null }).run,
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.host, null);
  assert.match(output.next, /firstdraft host create/);
});

test("status tells a live app from a failed deploy and from red checks", async (context) => {
  const cases = [
    {
      release: {
        state: "live",
        version: "a".repeat(40),
        changed_at: CREATED_AT,
      },
      run: {
        conclusion: "success",
        jobs: [job("ci", "success"), job("deploy", "success")],
      },
      up: 200,
      next: /The app is live/,
    },
    {
      release: { state: "none_yet", version: null, changed_at: null },
      run: {
        conclusion: "failure",
        jobs: [job("ci", "success"), job("deploy", "failure")],
      },
      up: 502,
      next: /The last deploy failed \(https:\/\/github.com\/owner\/app\/actions\/runs\/7\)/,
    },
    {
      release: { state: "none_yet", version: null, changed_at: null },
      run: {
        conclusion: "failure",
        jobs: [
          job("ci", "failure"),
          job("production-smoke", "success"),
          job("deploy", "skipped"),
        ],
      },
      up: 404,
      next: /CI failed on main \(ci\)/,
    },
    {
      release: { state: "none_yet", version: null, changed_at: null },
      run: { status: "in_progress", conclusion: "", jobs: [job("ci", "")] },
      up: 404,
      next: /CI is running on main/,
    },
    {
      release: { state: "none_yet", version: null, changed_at: null },
      run: {
        conclusion: "success",
        jobs: [job("ci", "success"), job("deploy", "skipped")],
      },
      up: 404,
      next: /gh run rerun 7/,
    },
  ];
  for (const scenario of cases) {
    const service = routes({
      [`GET ${BASE}`]: [
        json({
          environment: ENVIRONMENT,
          host: host({ state: "ready", ipv4: IPV4, release: scenario.release }),
        }),
      ],
      [`GET ${BASE}/backups`]: [
        json({ environment: ENVIRONMENT, backups: backups() }),
      ],
      [`GET ${BASE}/domain`]: [problem(404, "domain_not_found")],
      [`GET https://${SSLIP}/up`]: [new Response("", { status: scenario.up })],
    });
    const result = await invoke(["host", "status"], {
      cwd: appDirectory(context),
      fetchFunction: service.fetch,
      hostTools: toolRunner({
        variables: [
          { name: "DEPLOY_HOST", value: IPV4 },
          { name: "APP_HOST", value: SSLIP },
        ],
        secrets: [],
        run: scenario.run,
      }).run,
    });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.match(output.next, scenario.next);
    assert.equal(output.up.ok, scenario.up === 200);
    assert.equal(output.domain, null);
    assert.equal(output.backups.latest.state, "ok");
    const probe = service.calls.find((call) => call.url.endsWith("/up"));
    assert.equal(probe?.authorization, null);
  }
});

test("resize sends the size once confirmed", async (context) => {
  const service = routes({
    [`PATCH ${BASE}`]: [
      json(
        {
          environment: ENVIRONMENT,
          host: host({ state: "resizing", ipv4: IPV4, size: "s-1vcpu-2gb" }),
        },
        202,
      ),
    ],
  });
  const result = await invoke(
    ["host", "resize", "--size", "s-1vcpu-2gb", "--yes"],
    { cwd: appDirectory(context), fetchFunction: service.fetch },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).host.state, "resizing");
  assert.deepEqual(JSON.parse(String(service.calls[0]?.body)), {
    host: { size: "s-1vcpu-2gb" },
  });
});

test("destroy confirms the Environment, then cleans up GitHub and the local key", async (context) => {
  const config = configDirectory(context, { key: true });
  const service = routes({
    [`DELETE ${BASE}`]: [
      json(
        {
          environment: ENVIRONMENT,
          host: host({ state: "destroying", ipv4: IPV4 }),
        },
        202,
      ),
    ],
  });
  const tools = toolRunner({
    variables: [
      { name: "DEPLOY_HOST", value: IPV4 },
      { name: "APP_HOST", value: SSLIP },
    ],
    secrets: ["SSH_PRIVATE_KEY", "SECRET_KEY_BASE"],
    run: null,
  });
  const result = await invoke(["host", "destroy", "--confirm", "production"], {
    cwd: appDirectory(context),
    env: { XDG_CONFIG_HOME: config },
    fetchFunction: service.fetch,
    hostTools: tools.run,
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.github, {
    deleted: ["DEPLOY_HOST", "APP_HOST", "SSH_PRIVATE_KEY"],
    left: [],
  });
  assert.deepEqual(JSON.parse(String(service.calls[0]?.body)), {
    confirm: "production",
  });
  assert.equal(
    existsSync(
      path.join(config, "firstdraft", "hosts", PROJECT_ID, "production"),
    ),
    false,
  );
});

test("domain connect returns the records, and check switches APP_HOST once the app record is right", async (context) => {
  const cwd = appDirectory(context);
  const connected = routes({
    [`PUT ${BASE}/domain`]: [
      json({ environment: ENVIRONMENT, domain: domain("unchecked") }),
    ],
  });
  const connect = await invoke(
    ["host", "domain", "connect", "app.example.com"],
    {
      cwd,
      fetchFunction: connected.fetch,
    },
  );
  assert.equal(connect.status, 0, connect.stderr);
  assert.equal(JSON.parse(connect.stdout).domain.records[0].type, "A");
  assert.deepEqual(JSON.parse(String(connected.calls[0]?.body)), {
    domain: { hostname: "app.example.com" },
  });

  const checked = routes({
    [`POST ${BASE}/domain/check`]: [
      json({ environment: ENVIRONMENT, domain: domain("ok") }),
    ],
  });
  const tools = toolRunner({
    variables: [{ name: "APP_HOST", value: SSLIP }],
    secrets: [],
    run: null,
  });
  const check = await invoke(["host", "domain", "check"], {
    cwd,
    fetchFunction: checked.fetch,
    hostTools: tools.run,
  });
  assert.equal(check.status, 0, check.stderr);
  const output = JSON.parse(check.stdout);
  assert.equal(output.app_host_changed, true);
  assert.match(output.next, /APP_HOST is now app.example.com/);
  assert.deepEqual(tools.calls.find((call) => call.args[1] === "set")?.args, [
    "variable",
    "set",
    "APP_HOST",
    "--body",
    "app.example.com",
  ]);
});

test("email connect stores the SMTP password through gh and never prints it", async (context) => {
  const password = "canary-smtp-password";
  const smtp = {
    host: "email-smtp.us-east-1.amazonaws.com",
    port: 587,
    username: "AKIAEXAMPLE",
    headers: { "X-SES-TENANT": "fd-1" },
  };
  const service = routes({
    [`POST ${BASE}/email/smtp-credentials`]: [
      json({ environment: ENVIRONMENT, smtp: { ...smtp, password } }, 201),
    ],
  });
  const tools = toolRunner({ variables: [], secrets: [], run: null });
  const result = await invoke(["host", "email", "connect"], {
    cwd: appDirectory(context),
    fetchFunction: service.fetch,
    hostTools: tools.run,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).smtp, smtp);
  const secret = tools.calls.find((call) => call.args[0] === "secret");
  assert.deepEqual(secret?.args, ["secret", "set", "SMTP_PASSWORD"]);
  assert.equal(secret?.input, password);
  assertNoSecrets(result);
});

test("email reads the state and the month's allowance", async (context) => {
  const email = {
    state: "waiting_for_domain",
    sending_domain: null,
    paused_reason: null,
    allowance: {
      limit: 2000,
      used: 0,
      period_start: "2026-11-01",
      resets_at: "2026-12-01T00:00:00Z",
    },
    smtp: null,
  };
  const service = routes({
    [`GET ${BASE}/email`]: [json({ environment: ENVIRONMENT, email })],
  });
  const result = await invoke(["host", "email"], {
    cwd: appDirectory(context),
    fetchFunction: service.fetch,
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.email, email);
  assert.match(output.next, /domain connect/);
});

test("service refusals and failures map to handled errors", async (context) => {
  const cwd = appDirectory(context);
  for (const [response, error] of /** @type {const} */ ([
    [problem(409, "host_busy"), "host_rejected"],
    [problem(503, "unavailable"), "host_unavailable"],
    [
      json({ environment: ENVIRONMENT, host: { state: "unknown" } }),
      "invalid_host_response",
    ],
    [
      json({ environment: { ...ENVIRONMENT, name: "staging" }, host: host() }),
      "invalid_host_response",
    ],
    [problem(401, "authentication_required"), "authentication_required"],
  ])) {
    const service = routes({ [`GET ${BASE}/email`]: [response] });
    const result = await invoke(["host", "email"], {
      cwd,
      fetchFunction: service.fetch,
    });
    assertHandledFailure(result, error);
  }

  const noProject = mkdtempSync(path.join(tmpdir(), "firstdraft-host-"));
  context.after(() => rmSync(noProject, { recursive: true, force: true }));
  const unpinned = await invoke(["host", "email"], { cwd: noProject });
  assertHandledFailure(unpinned, "local_input_unreadable");
});

/**
 * @param {import("node:test").TestContext} context
 * @param {{deployFiles?: boolean, workflow?: string}} [options]
 */
function appDirectory(
  context,
  { deployFiles = true, workflow = WORKFLOW } = {},
) {
  const cwd = mkdtempSync(path.join(tmpdir(), "firstdraft-host-"));
  context.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(path.join(cwd, ".firstdraft"));
  writeFileSync(
    path.join(cwd, ".firstdraft", "state.json"),
    `${JSON.stringify({
      format: "firstdraft.cli-state/1",
      project_id: PROJECT_ID,
      api_url: API_URL,
      foundation_plan_etag: `"sha256:${"9".repeat(64)}"`,
    })}\n`,
    { mode: 0o600 },
  );
  if (deployFiles) {
    mkdirSync(path.join(cwd, "config"));
    writeFileSync(path.join(cwd, "config", "deploy.yml"), "service: app\n");
    mkdirSync(path.join(cwd, ".github", "workflows"), { recursive: true });
    writeFileSync(path.join(cwd, ".github", "workflows", "ci.yml"), workflow);
  }
  return cwd;
}

/**
 * @param {import("node:test").TestContext} context
 * @param {{key?: boolean}} [options]
 */
function configDirectory(context, { key = false } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "firstdraft-host-config-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  if (key)
    writeKey(
      path.join(directory, "firstdraft", "hosts", PROJECT_ID, "production"),
    );
  return directory;
}

/** @param {string} directory */
function writeKey(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(directory, "id_ed25519"), PRIVATE_KEY, {
    mode: 0o600,
  });
  writeFileSync(path.join(directory, "id_ed25519.pub"), `${PUBLIC_KEY}\n`);
}

/** @param {Record<string, unknown>} [changes] */
function host(changes = {}) {
  return {
    state: "provisioning",
    region: "nyc1",
    size: "s-1vcpu-1gb",
    ipv4: null,
    ssh_user: "root",
    ssh_key_fingerprint: fingerprint(PUBLIC_KEY),
    created_at: CREATED_AT,
    ready_at: null,
    failure: null,
    release: { state: "none_yet", version: null, changed_at: null },
    ...changes,
  };
}

function backups() {
  return {
    schedule: "daily, 03:00 to 04:00 UTC",
    retention_days: 30,
    latest: {
      taken_at: "2026-11-24T03:12:09Z",
      database_bytes: 1832190,
      uploads_bytes: 52011200,
      state: "ok",
    },
    checked_at: "2026-11-24T06:00:00Z",
    latest_restore_check: null,
  };
}

/** @param {string} status */
function domain(status) {
  return {
    hostname: "app.example.com",
    state: "checking",
    checked_at: status === "unchecked" ? null : CREATED_AT,
    records: [
      {
        purpose: "app",
        type: "A",
        name: "app.example.com",
        value: IPV4,
        required: true,
        status,
        found: status === "ok" ? [IPV4] : [],
      },
    ],
  };
}

/** @param {string} name @param {string} conclusion */
function job(name, conclusion) {
  return {
    name,
    status: conclusion === "" ? "in_progress" : "completed",
    conclusion,
  };
}

/**
 * A fake gh, ssh-keygen, and ssh that record every call.
 *
 * @param {{variables: {name: string, value: string}[], secrets: string[], run: {status?: string, conclusion: string, jobs: unknown[]} | null, cloudInit?: string}} state
 */
function toolRunner(state) {
  /** @type {{command: string, args: readonly string[], input?: string}[]} */
  const calls = [];
  /** @type {import("../src/host-tools.js").ToolRunner} */
  const runner = (command, args, options) => {
    calls.push({ command, args, input: options.input });
    const ok = (/** @type {unknown} */ value) => ({
      status: 0,
      stdout: typeof value === "string" ? value : JSON.stringify(value),
      stderr: "",
    });
    if (command === "ssh-keygen") {
      writeKey(path.dirname(String(args[args.indexOf("-f") + 1])));
      return ok("");
    }
    if (command === "ssh") return ok(`${state.cloudInit ?? "status: done"}\n`);
    const [group, action] = args;
    if (group === "repo") {
      return ok({
        nameWithOwner: "owner/app",
        defaultBranchRef: { name: "main" },
      });
    }
    if (group === "secret" && action === "list") {
      return ok(state.secrets.map((name) => ({ name })));
    }
    if (group === "variable" && action === "list") return ok(state.variables);
    if (group === "run" && action === "list") {
      return ok(
        state.run === null
          ? []
          : [
              {
                databaseId: 7,
                headSha: "b".repeat(40),
                status: state.run.status ?? "completed",
                conclusion: state.run.conclusion,
                url: "https://github.com/owner/app/actions/runs/7",
              },
            ],
      );
    }
    if (group === "run" && action === "view")
      return ok({ jobs: state.run?.jobs ?? [] });
    return ok("");
  };
  return { run: runner, calls };
}

/**
 * Answers each "METHOD path" (or full URL for other origins) from its queue,
 * repeating the last response.
 *
 * @param {Record<string, Response[]>} table
 */
function routes(table) {
  /** @type {{method: string, url: string, body: unknown, authorization: string | null}[]} */
  const calls = [];
  /** @type {typeof globalThis.fetch} */
  const fetchFunction = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url: String(url),
      body: init?.body,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    const key =
      url.origin === API_URL
        ? `${method} ${url.pathname}`
        : `${method} ${url.origin}${url.pathname}`;
    const queue = table[key];
    assert(queue && queue.length > 0, `unexpected request ${key}`);
    const response = queue.length > 1 ? queue.shift() : queue[0];
    return /** @type {Response} */ (response).clone();
  };
  return { fetch: fetchFunction, calls };
}

/** @param {unknown} body @param {number} [status] */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** @param {number} status @param {string} code */
function problem(status, code) {
  return new Response(
    JSON.stringify({
      type: "about:blank",
      title: "Problem",
      status,
      code,
      detail: `The Service said ${code}.`,
    }),
    { status, headers: { "Content-Type": "application/problem+json" } },
  );
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
    hostTools: () => assert.fail("No program was expected to run"),
    hostSleep: async () => {},
    ...options,
  });
  return { status, stdout, stderr };
}

/** @param {{status: number, stdout: string, stderr: string}} result @param {string} error @param {number} [status] */
function assertHandledFailure(result, error, status = 1) {
  assert.equal(result.status, status, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(JSON.parse(result.stderr).error, error);
}

/** @param {{stdout: string, stderr: string}} result */
function assertNoSecrets(result) {
  assert.doesNotMatch(result.stdout + result.stderr, /canary/);
}
