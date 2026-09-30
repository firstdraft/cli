import assert from "node:assert/strict";
import * as fs from "node:fs";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { run } from "../src/cli.js";
import { writeCredential } from "../src/credentials.js";

const PRODUCTION = "https://firstdraft.com";
const STAGING = "https://staging.firstdraft.com";
const PRODUCTION_TOKEN = "fd_canary-production-token";
const STAGING_TOKEN = "fd_canary-staging-token";

const LOGOUT_HELP = `First Draft CLI

Usage:
  firstdraft logout

Options:
      --staging  Log out of staging
  -h, --help     Show help

Environment:
  FIRSTDRAFT_API_URL  Log out of a custom API origin

The command asks First Draft to revoke the saved token for the selected origin,
then removes it from the credentials file even if revocation is not confirmed.
Token environment variables are not changed.
`;

test("logout help is printed on stdout", async (context) => {
  const result = await invoke(context, ["logout", "--help"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, LOGOUT_HELP);
  assert.equal(result.stderr, "");
});

test("logout without a saved token says so and makes no request", async (context) => {
  const result = await invoke(context, ["logout"]);
  assert.deepEqual(
    { status: result.status, stdout: result.stdout, stderr: result.stderr },
    {
      status: 0,
      stdout: `Not logged in to ${PRODUCTION}; no saved token was found.\n`,
      stderr: "",
    },
  );
});

test("logout revokes and removes only the selected origin's token", async (context) => {
  const cases = [
    {
      argv: ["logout"],
      origin: PRODUCTION,
      token: PRODUCTION_TOKEN,
      remaining: STAGING,
    },
    {
      argv: ["--staging", "logout"],
      origin: STAGING,
      token: STAGING_TOKEN,
      remaining: PRODUCTION,
    },
    {
      argv: ["logout", "--staging"],
      origin: STAGING,
      token: STAGING_TOKEN,
      remaining: PRODUCTION,
    },
  ];
  for (const { argv, origin, token, remaining } of cases) {
    const configHome = temporaryConfigHome(context);
    writeCredentials(configHome, {
      [PRODUCTION]: entry(PRODUCTION_TOKEN),
      [STAGING]: entry(STAGING_TOKEN),
    });
    let requests = 0;
    const result = await invoke(context, argv, {
      configHome,
      fetchFunction: async (input, init) => {
        requests += 1;
        assert.equal(String(input), `${origin}/oauth/revoke`);
        assert.equal(init?.method, "POST");
        const form = new URLSearchParams(String(init?.body));
        assert.equal(form.get("token"), token);
        assert.equal(form.get("client_id"), "firstdraft-cli");
        return new Response("{}", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    assert.equal(requests, 1);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, `Logged out of ${origin}\n`);
    assert.equal(result.stderr, "");
    assert.deepEqual(Object.keys(storedOrigins(configHome)), [remaining]);
    assertNoSecrets(result);
  }
});

test("logout removes the local token even when revocation is not confirmed", async (context) => {
  for (const fetchFunction of [
    async () => {
      throw new TypeError("canary network failure");
    },
    async () => new Response("canary", { status: 500 }),
  ]) {
    const configHome = temporaryConfigHome(context);
    writeCredentials(configHome, { [PRODUCTION]: entry(PRODUCTION_TOKEN) });
    const result = await invoke(context, ["logout"], {
      configHome,
      fetchFunction,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, `Logged out of ${PRODUCTION}\n`);
    assert.match(
      result.stderr,
      /did not confirm that the token was revoked.*https:\/\/firstdraft\.com\/api-tokens/,
    );
    assert.deepEqual(storedOrigins(configHome), {});
    assertNoSecrets(result);
  }
});

test("logout preserves the revocation outcome when local deletion fails", async (context) => {
  for (const outcome of ["confirmed", "rejected", "network"]) {
    const configHome = temporaryConfigHome(context);
    const origin = "https://custom.example.test";
    const origins = {
      [origin]: entry(PRODUCTION_TOKEN),
      [STAGING]: entry(STAGING_TOKEN),
    };
    writeCredentials(configHome, origins);
    let requests = 0;
    const result = await invoke(context, ["logout"], {
      configHome,
      apiUrl: origin,
      credentialsFileSystem: {
        ...fs,
        renameSync: () => {
          throw Object.assign(new Error(PRODUCTION_TOKEN), { code: "EACCES" });
        },
      },
      fetchFunction: async () => {
        requests += 1;
        if (outcome === "network") throw new TypeError("network failure");
        return new Response("{}", {
          status: outcome === "confirmed" ? 200 : 500,
        });
      },
    });
    assert.equal(requests, 1);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    const envelope = JSON.parse(result.stderr);
    assert.equal(envelope.error, "logout_failed");
    assert.equal(envelope.reason, "credentials_unavailable");
    assert.equal(envelope.phase, "write");
    assert.equal(envelope.revoked, outcome === "confirmed");
    assert.equal(
      envelope.credentials_path,
      path.join(configHome, "firstdraft", "credentials.json"),
    );
    assert.match(envelope.detail, /local credential could not be removed/);
    if (outcome === "confirmed") {
      assert.match(envelope.detail, /confirmed token revocation/);
    } else {
      assert.match(envelope.detail, /did not confirm token revocation/);
      assert(envelope.detail.includes(origin + "/api-tokens"));
    }
    assert.deepEqual(storedOrigins(configHome), origins);
    assert.deepEqual(fs.readdirSync(path.join(configHome, "firstdraft")), [
      "credentials.json",
    ]);
    assertNoSecrets(result);
  }
});

test("logout keeps a newer login saved while revocation was pending", async (context) => {
  const configHome = temporaryConfigHome(context);
  writeCredentials(configHome, {
    [PRODUCTION]: entry(PRODUCTION_TOKEN),
    [STAGING]: entry(STAGING_TOKEN),
  });
  const newerToken = "fd_canary-newer-login-token";
  /** @type {string[]} */
  const revokedTokens = [];
  const result = await invoke(context, ["logout"], {
    configHome,
    fetchFunction: async (_input, init) => {
      revokedTokens.push(
        String(new URLSearchParams(String(init?.body)).get("token")),
      );
      // A concurrent login finishes before the revocation response arrives.
      writeCredential(
        { env: { XDG_CONFIG_HOME: configHome } },
        PRODUCTION,
        entry(newerToken),
      );
      return new Response("{}", { status: 200 });
    },
  });

  assert.deepEqual(revokedTokens, [PRODUCTION_TOKEN]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `Logged out of ${PRODUCTION}\n`);
  assert.match(
    result.stderr,
    /changed while logout was running, so the current saved token was left in place/,
  );
  assert.deepEqual(storedOrigins(configHome), {
    [PRODUCTION]: entry(newerToken),
    [STAGING]: entry(STAGING_TOKEN),
  });
  assertNoSecrets(result);
});

test("logout reports a held credentials lock after revocation and keeps the lock", async (context) => {
  const configHome = temporaryConfigHome(context);
  const origins = {
    [PRODUCTION]: entry(PRODUCTION_TOKEN),
    [STAGING]: entry(STAGING_TOKEN),
  };
  writeCredentials(configHome, origins);
  const lock = path.join(configHome, "firstdraft", "credentials.json.lock");
  writeFileSync(lock, "12345\n");
  const result = await invoke(context, ["logout"], {
    configHome,
    credentialsLockTimeoutMs: 50,
    fetchFunction: async () => new Response("{}", { status: 200 }),
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  const envelope = JSON.parse(result.stderr);
  assert.equal(envelope.error, "logout_failed");
  assert.equal(envelope.reason, "credentials_locked");
  assert.equal(envelope.phase, "write");
  assert.equal(envelope.revoked, true);
  assert.match(
    envelope.detail,
    /if no other firstdraft command is running, delete credentials\.json\.lock next to credentials_path and retry logout/,
  );
  assert.deepEqual(storedOrigins(configHome), origins);
  assert.equal(readFileSync(lock, "utf8"), "12345\n");
  assertNoSecrets(result);
});

test("logout uses a custom API origin and notes a remaining environment token", async (context) => {
  const origin = "http://127.0.0.1:3000";
  const configHome = temporaryConfigHome(context);
  writeCredentials(configHome, { [origin]: entry(PRODUCTION_TOKEN) });
  const result = await invoke(context, ["logout"], {
    configHome,
    apiUrl: `${origin}/`,
    apiToken: "fd_canary-environment-token",
    fetchFunction: async (input) => {
      assert.equal(String(input), `${origin}/oauth/revoke`);
      return new Response("{}", { status: 200 });
    },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `Logged out of ${origin}\n`);
  assert.equal(
    result.stderr,
    `Note: FIRSTDRAFT_API_TOKEN is set and takes precedence over the saved login for ${origin}.\n`,
  );
  assertNoSecrets(result);
});

test("logout reports an unusable credentials file without a request", async (context) => {
  const configHome = temporaryConfigHome(context);
  mkdirSync(path.join(configHome, "firstdraft"));
  const file = path.join(configHome, "firstdraft", "credentials.json");
  writeFileSync(file, `{"canary": "${PRODUCTION_TOKEN}"`);
  const result = await invoke(context, ["logout"], { configHome });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stderr), {
    error: "logout_failed",
    detail:
      "The credentials file could not be read, so no token was revoked or removed. Repair or remove it, then retry.",
    reason: "credentials_invalid",
    phase: "read",
    credentials_path: file,
  });
  assertNoSecrets(result);
});

/**
 * @param {import("node:test").TestContext} context
 * @param {readonly string[]} argv
 * @param {Partial<import("../src/cli.js").RunOptions> & {configHome?: string}} [options]
 */
async function invoke(context, argv, options = {}) {
  const { configHome = temporaryConfigHome(context), ...rest } = options;
  let stdout = "";
  let stderr = "";
  const status = await run({
    argv,
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
    apiToken: "",
    stagingApiToken: "",
    env: { XDG_CONFIG_HOME: configHome },
    homedir: () => assert.fail("The home directory must not be used"),
    fetchFunction: async () => assert.fail("No network request was expected"),
    ...rest,
  });
  return { status, stdout, stderr };
}

/** @param {import("node:test").TestContext} context */
function temporaryConfigHome(context) {
  const directory = mkdtempSync(path.join(tmpdir(), "firstdraft-logout-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** @param {string} token */
function entry(token) {
  return {
    access_token: token,
    token_type: "Bearer",
    created_at: "2026-09-01T00:00:00.000Z",
  };
}

/** @param {string} configHome @param {Record<string, unknown>} origins */
function writeCredentials(configHome, origins) {
  mkdirSync(path.join(configHome, "firstdraft"), { recursive: true });
  writeFileSync(
    path.join(configHome, "firstdraft", "credentials.json"),
    JSON.stringify({ format: "firstdraft.cli-credentials/1", origins }),
  );
}

/** @param {string} configHome */
function storedOrigins(configHome) {
  return JSON.parse(
    readFileSync(
      path.join(configHome, "firstdraft", "credentials.json"),
      "utf8",
    ),
  ).origins;
}

/** @param {{stdout: string, stderr: string}} result */
function assertNoSecrets(result) {
  for (const output of [result.stdout, result.stderr]) {
    assert.doesNotMatch(output, /fd_canary/);
  }
}
