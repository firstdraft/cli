import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { run } from "../src/cli.js";

const PRODUCTION = "https://firstdraft.com";
const STAGING = "https://staging.firstdraft.com";
const TOKEN = "fd_canary-login-token";
const DEVICE_CODE = "canary-device-code";
const CODE = "canary-authorization-code";

const LOGIN_HELP = `First Draft CLI

Usage:
  firstdraft login [--interactive]

Options:
      --staging      Log in to staging
  -i, --interactive  Approve with a code on another device (no local browser)
      --device       Same as --interactive
  -h, --help         Show help

Environment:
  FIRSTDRAFT_API_URL  Log in to a custom API origin
  XDG_CONFIG_HOME     Credentials directory base (default: ~/.config)

By default the command prints a URL to open in a browser on this machine, then
waits up to five minutes for First Draft to redirect to a one-time listener on
127.0.0.1. The token is saved for the selected origin in
firstdraft/credentials.json under the configuration directory and is never
printed. Token environment variables take precedence over a saved login.
`;

test("login help is printed on stdout", async (context) => {
  for (const argv of [
    ["login", "--help"],
    ["login", "-h"],
  ]) {
    const result = await invoke(context, argv);
    assert.deepEqual(
      { status: result.status, stdout: result.stdout, stderr: result.stderr },
      { status: 0, stdout: LOGIN_HELP, stderr: "" },
    );
  }
});

test("login rejects invalid, repeated, and conflicting options", async (context) => {
  for (const argv of [
    ["login", "extra"],
    ["login", "--canary-secret-option"],
    ["login", "-i", "-i"],
    ["login", "--interactive", "--interactive"],
    ["login", "-i", "--device"],
    ["login", "--interactive", "--device"],
    ["login", "--staging", "--staging"],
    ["logout", "extra"],
    ["logout", "--interactive"],
  ]) {
    const result = await invoke(context, argv, {
      startLoopbackServer: async () => assert.fail("No server was expected"),
    });
    assert.equal(result.status, 2, argv.join(" "));
    assert.equal(result.stdout, "");
    assert.equal(errorEnvelope(result.stderr).error, "invalid_arguments");
    assert.doesNotMatch(result.stderr, /canary/);
  }
});

test("browser login exchanges a PKCE code from the loopback callback and saves the token", async (context) => {
  /** @type {URL | undefined} */
  let authorization;
  /** @type {ReturnType<typeof callback> | undefined} */
  let callbackResponse;
  /** @type {string[]} */
  const events = [];
  const configHome = temporaryConfigHome(context);
  const result = await invoke(context, ["login"], {
    configHome,
    hostname: () => "canary-laptop\u001b[31m",
    onStderr: (text) => {
      const url = authorizationUrlIn(text);
      if (!url) return;
      authorization = url;
      callbackResponse = callback(url, { code: CODE }).then((page) => {
        events.push(
          `page:${existsSync(path.join(configHome, "firstdraft", "credentials.json")) ? "saved" : "unsaved"}`,
        );
        return page;
      });
    },
    fetchFunction: async (input, init) => {
      events.push("exchange");
      const endpoint = new URL(String(input));
      assert.equal(endpoint.href, `${PRODUCTION}/oauth/token`);
      assert.equal(init?.method, "POST");
      assert.equal(
        new Headers(init?.headers).get("content-type"),
        "application/x-www-form-urlencoded",
      );
      assert(authorization);
      const form = new URLSearchParams(String(init?.body));
      assert.equal(form.get("grant_type"), "authorization_code");
      assert.equal(form.get("code"), CODE);
      assert.equal(form.get("client_id"), "firstdraft-cli");
      assert.equal(
        form.get("redirect_uri"),
        authorization.searchParams.get("redirect_uri"),
      );
      const verifier = form.get("code_verifier");
      assert.match(String(verifier), /^[A-Za-z0-9_-]{43}$/);
      assert.equal(
        createHash("sha256").update(String(verifier)).digest("base64url"),
        authorization.searchParams.get("code_challenge"),
      );
      return tokenResponse();
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `Logged in to ${PRODUCTION}\n`);
  assertNoSecrets(result);

  assert(authorization);
  assert.equal(authorization.origin, PRODUCTION);
  assert.equal(authorization.pathname, "/oauth/authorize");
  const params = authorization.searchParams;
  assert.equal(params.get("response_type"), "code");
  assert.equal(params.get("client_id"), "firstdraft-cli");
  assert.equal(params.get("code_challenge_method"), "S256");
  assert.match(String(params.get("code_challenge")), /^[A-Za-z0-9_-]{43}$/);
  assert.match(String(params.get("state")), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(params.get("device_name"), "canary-laptop[31m");
  assert.match(
    String(params.get("redirect_uri")),
    /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
  );

  const page = await callbackResponse;
  assert(page);
  assert.equal(page.status, 200);
  assert.match(page.body, /<h1>Login complete<\/h1>/);
  assert.match(page.body, /close this tab/);
  assert.match(page.contentType, /^text\/html/);
  assertStyledUnderCsp(page);
  assert.deepEqual(
    events,
    ["exchange", "page:saved"],
    "the browser is answered only after the exchange and credential write",
  );

  await assert.rejects(
    fetch(
      `${params.get("redirect_uri")}?code=late&state=${params.get("state")}`,
    ),
    "the loopback server must be closed after login",
  );

  const credentialsFile = path.join(
    result.configHome,
    "firstdraft",
    "credentials.json",
  );
  if (process.platform !== "win32") {
    assert.equal(statSync(credentialsFile).mode & 0o777, 0o600);
    assert.equal(statSync(path.dirname(credentialsFile)).mode & 0o777, 0o700);
  }
  assert.deepEqual(JSON.parse(readFileSync(credentialsFile, "utf8")), {
    format: "firstdraft.cli-credentials/1",
    origins: {
      [PRODUCTION]: {
        access_token: TOKEN,
        token_type: "Bearer",
        created_at: "2026-09-29T12:00:00.000Z",
      },
    },
  });
  assert.deepEqual(readdirSync(path.dirname(credentialsFile)), [
    "credentials.json",
  ]);
});

test("the loopback listener rejects stray requests and a wrong state without ending the wait", async (context) => {
  /** @type {number[]} */
  const strayStatuses = [];
  const result = await invoke(context, ["login"], {
    onStderr: (text) => {
      const url = authorizationUrlIn(text);
      if (!url) return;
      const redirect = String(url.searchParams.get("redirect_uri"));
      const state = String(url.searchParams.get("state"));
      void (async () => {
        const origin = new URL(redirect).origin;
        for (const target of [
          `${origin}/favicon.ico`,
          `${redirect}?code=canary-injected-code`,
          `${redirect}?code=canary-injected-code&state=wrong`,
          `${redirect}?code=canary-injected-code&state=${state}&state=${state}`,
          `${redirect}?error=access_denied&state=wrong`,
        ]) {
          const response = await fetch(target);
          await response.text();
          strayStatuses.push(response.status);
        }
        const accepted = await callback(url, { code: CODE });
        assert.equal(accepted.status, 200);
      })();
    },
    fetchFunction: async (_input, init) => {
      const form = new URLSearchParams(String(init?.body));
      assert.equal(form.get("code"), CODE);
      return tokenResponse();
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(strayStatuses, [404, 400, 400, 400, 400]);
  assertNoSecrets(result);
});

test("the loopback listener rejects a request with a foreign Host header", async (context) => {
  const { startLoopbackServer } = await import("../src/oauth.js");
  const listener = await startLoopbackServer({ state: "expected-state" });
  context.after(() => listener.close());
  const { request } = await import("node:http");
  const redirect = new URL(listener.redirectUri);
  const status = await new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: redirect.hostname,
        port: redirect.port,
        path: "/callback?code=x&state=expected-state",
        headers: { Host: "attacker.example" },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
  assert.equal(status, 400);
  const settled = await Promise.race([
    listener.result.then(() => true),
    new Promise((resolve) => {
      setTimeout(resolve, 50, false);
    }),
  ]);
  assert.equal(settled, false);
});

test("browser login times out after five minutes and closes the listener", async (context) => {
  /** @type {number[]} */
  const delays = [];
  let redirect = "";
  const result = await invoke(context, ["login"], {
    loginSleep: async (delayMs) => {
      delays.push(delayMs);
    },
    onStderr: (text) => {
      const url = authorizationUrlIn(text);
      if (url) redirect = String(url.searchParams.get("redirect_uri"));
    },
  });

  assert.equal(result.status, 1);
  assert.deepEqual(delays, [5 * 60 * 1000]);
  assert.equal(errorEnvelope(result.stderr).error, "authorization_expired");
  assert.equal(result.stdout, "");
  assert.notEqual(redirect, "");
  await assert.rejects(fetch(`${redirect}?code=late&state=late`));
  assertNoCredentialsFile(result.configHome);
});

test("browser login reports a denied authorization", async (context) => {
  /** @type {ReturnType<typeof callback> | undefined} */
  let callbackResponse;
  const result = await invoke(context, ["login"], {
    onStderr: (text) => {
      const url = authorizationUrlIn(text);
      if (url) callbackResponse = callback(url, { error: "access_denied" });
    },
  });

  const page = await callbackResponse;
  assert(page);
  assert.match(page.body, /<h1>Login cancelled<\/h1>/);
  assertStyledUnderCsp(page);

  assert.equal(result.status, 1);
  assert.deepEqual(errorEnvelope(result.stderr), {
    error: "authorization_denied",
    detail:
      "The login was denied in the browser. No credential was saved. Run 'firstdraft login' again to retry.",
  });
  assertNoCredentialsFile(result.configHome);
});

test("browser login reports token endpoint failures without printing responses", async (context) => {
  /** @type {{response: Response, reason?: string, status: number}[]} */
  const cases = [
    {
      response: jsonResponse(400, {
        error: "invalid_grant",
        error_description: "canary description",
      }),
      reason: "invalid_grant",
      status: 400,
    },
    { response: jsonResponse(200, { token_type: "Bearer" }), status: 200 },
    {
      response: jsonResponse(200, { access_token: TOKEN, token_type: "mac" }),
      status: 200,
    },
    {
      response: new Response("<html>canary</html>", { status: 500 }),
      status: 500,
    },
  ];
  for (const { response, ...expected } of cases) {
    /** @type {ReturnType<typeof callback> | undefined} */
    let callbackResponse;
    const result = await invoke(context, ["login"], {
      onStderr: (text) => {
        const url = authorizationUrlIn(text);
        if (url) callbackResponse = callback(url, { code: CODE });
      },
      fetchFunction: async () => response,
    });
    const page = await callbackResponse;
    assert(page);
    assert.match(
      page.body,
      /<h1>Login failed<\/h1>/,
      "the browser must not report success when the exchange fails",
    );
    assert.doesNotMatch(page.body, /canary/);
    assert.equal(result.status, 1);
    const envelope = errorEnvelope(result.stderr);
    assert.equal(envelope.error, "login_failed");
    assert.equal(envelope.reason, expected.reason);
    assert.equal(envelope.status, expected.status);
    assertNoSecrets(result);
    assertNoCredentialsFile(result.configHome);
  }
});

test("browser login reports a network failure as login_failed", async (context) => {
  const result = await invoke(context, ["login"], {
    onStderr: (text) => {
      const url = authorizationUrlIn(text);
      if (url) void callback(url, { code: CODE });
    },
    fetchFunction: async () => {
      throw new TypeError("canary network failure");
    },
  });
  assert.equal(result.status, 1);
  assert.equal(errorEnvelope(result.stderr).error, "login_failed");
  assertNoSecrets(result);
});

test("login selects staging, a custom origin, or production like other commands", async (context) => {
  /** @type {{argv: string[], apiUrl?: string, origin: string}[]} */
  const cases = [
    { argv: ["--staging", "login"], origin: STAGING },
    { argv: ["login", "--staging"], apiUrl: `${STAGING}/`, origin: STAGING },
    {
      argv: ["login"],
      apiUrl: "http://127.0.0.1:3000/",
      origin: "http://127.0.0.1:3000",
    },
    { argv: ["login"], origin: PRODUCTION },
  ];
  for (const { argv, apiUrl, origin } of cases) {
    /** @type {string[]} */
    const origins = [];
    const result = await invoke(context, argv, {
      apiUrl,
      onStderr: (text) => {
        const url = authorizationUrlIn(text);
        if (!url) return;
        origins.push(url.origin);
        void callback(url, { code: CODE });
      },
      fetchFunction: async (input) => {
        origins.push(new URL(String(input)).origin);
        return tokenResponse();
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(origins, [origin, origin]);
    assert.equal(result.stdout, `Logged in to ${origin}\n`);
    assert.deepEqual(Object.keys(storedCredentials(result.configHome)), [
      origin,
    ]);
  }
});

test("login rejects a staging conflict or invalid URL before any request", async (context) => {
  /** @type {[string[], string][]} */
  const cases = [
    [["--staging", "login"], "https://canary-conflict.test"],
    [["login", "--staging"], PRODUCTION],
    [["login"], "ftp://canary.test"],
    [["logout", "--staging"], PRODUCTION],
  ];
  for (const [argv, apiUrl] of cases) {
    const result = await invoke(context, argv, {
      apiUrl,
      startLoopbackServer: async () => assert.fail("No server was expected"),
    });
    assert.equal(result.status, 2);
    assert.equal(errorEnvelope(result.stderr).error, "invalid_configuration");
    assert.doesNotMatch(result.stderr, /canary/);
  }
});

test("login keeps credentials for other origins", async (context) => {
  const configHome = temporaryConfigHome(context);
  writeCredentials(configHome, {
    [STAGING]: entry("fd_canary-staging-token"),
    [PRODUCTION]: entry("fd_canary-old-token"),
  });
  const result = await invoke(context, ["login"], {
    configHome,
    onStderr: (text) => {
      const url = authorizationUrlIn(text);
      if (url) void callback(url, { code: CODE });
    },
    fetchFunction: async () => tokenResponse(),
  });
  assert.equal(result.status, 0, result.stderr);
  const stored = storedCredentials(configHome);
  assert.equal(stored[STAGING]?.access_token, "fd_canary-staging-token");
  assert.equal(stored[PRODUCTION]?.access_token, TOKEN);
});

test("login refuses an unusable credentials file before contacting First Draft", async (context) => {
  const configHome = temporaryConfigHome(context);
  mkdirSync(path.join(configHome, "firstdraft"), { recursive: true });
  const file = path.join(configHome, "firstdraft", "credentials.json");
  for (const source of ["{canary", '{"format":"other","origins":{}}']) {
    writeFileSync(file, source);
    const result = await invoke(context, ["login"], {
      configHome,
      startLoopbackServer: async () => assert.fail("No server was expected"),
    });
    assert.equal(result.status, 1);
    assert.deepEqual(errorEnvelope(result.stderr), {
      error: "login_failed",
      detail:
        "The credentials file could not be read. No network request was made. Repair or remove it, then run 'firstdraft login' again.",
      reason: "credentials_invalid",
      phase: "read",
      credentials_path: file,
    });
    assert.equal(readFileSync(file, "utf8"), source);
  }
});

test("login reports an issued but unsaved token for browser and device flows", async (context) => {
  for (const device of [false, true]) {
    const configHome = temporaryConfigHome(context);
    const origins = {
      [PRODUCTION]: entry("fd_canary-old-token"),
      [STAGING]: entry("fd_canary-staging-token"),
    };
    writeCredentials(configHome, origins);
    const clock = fakeClock();
    let exchanges = 0;
    /** @type {ReturnType<typeof callback> | undefined} */
    let callbackResponse;
    const result = await invoke(context, device ? ["login", "-i"] : ["login"], {
      configHome,
      ...(device ? { loginSleep: clock.sleep, loginNow: clock.now } : {}),
      onStderr: (text) => {
        const url = authorizationUrlIn(text);
        if (url) callbackResponse = callback(url, { code: CODE });
      },
      credentialsFileSystem: {
        ...fs,
        renameSync: () => {
          throw Object.assign(new Error(TOKEN), { code: "EACCES" });
        },
      },
      fetchFunction: async (input) => {
        if (new URL(String(input)).pathname === "/oauth/device_authorization")
          return deviceAuthorizationResponse();
        exchanges += 1;
        return tokenResponse();
      },
    });
    if (!device) {
      const page = await callbackResponse;
      assert(page);
      assert.match(page.body, /<h1>Login failed<\/h1>/);
    }
    assert.equal(exchanges, 1);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    const envelope = errorEnvelope(result.stderr);
    assert.equal(envelope.error, "login_failed");
    assert.equal(envelope.reason, "credentials_unavailable");
    assert.equal(envelope.phase, "write");
    assert.equal(
      envelope.credentials_path,
      path.join(configHome, "firstdraft", "credentials.json"),
    );
    assert.match(envelope.detail, /issued a token, but it could not be saved/);
    assert.match(envelope.detail, /https:\/\/firstdraft\.com\/api-tokens/);
    assert.deepEqual(storedCredentials(configHome), origins);
    assert.deepEqual(readdirSync(path.join(configHome, "firstdraft")), [
      "credentials.json",
    ]);
    assertNoSecrets(result);
  }
});

test("login notes when an environment token overrides the saved login", async (context) => {
  const result = await invoke(context, ["login"], {
    apiToken: "fd_canary-environment-token",
    onStderr: (text) => {
      const url = authorizationUrlIn(text);
      if (url) void callback(url, { code: CODE });
    },
    fetchFunction: async () => tokenResponse(),
  });
  assert.equal(result.status, 0);
  assert.match(
    result.stderr,
    /Note: FIRSTDRAFT_API_TOKEN is set and takes precedence over the saved login for https:\/\/firstdraft\.com\.\n$/,
  );
  assertNoSecrets(result);
});

test("device login prints the code, honors interval and slow_down, and saves the token", async (context) => {
  for (const flag of ["-i", "--interactive", "--device"]) {
    const clock = fakeClock();
    /** @type {string[]} */
    const polls = [];
    const outcomes = ["authorization_pending", "slow_down", null];
    const result = await invoke(context, ["login", flag], {
      hostname: () => "canary-host",
      loginSleep: clock.sleep,
      loginNow: clock.now,
      startLoopbackServer: async () => assert.fail("No server was expected"),
      fetchFunction: async (input, init) => {
        const endpoint = new URL(String(input));
        const form = new URLSearchParams(String(init?.body));
        assert.equal(form.get("client_id"), "firstdraft-cli");
        if (endpoint.pathname === "/oauth/device_authorization") {
          assert.equal(form.get("device_name"), "canary-host");
          return deviceAuthorizationResponse();
        }
        assert.equal(endpoint.href, `${PRODUCTION}/oauth/token`);
        assert.equal(
          form.get("grant_type"),
          "urn:ietf:params:oauth:grant-type:device_code",
        );
        assert.equal(form.get("device_code"), DEVICE_CODE);
        polls.push(String(clock.now()));
        const outcome = outcomes.shift();
        return outcome
          ? jsonResponse(400, { error: outcome })
          : tokenResponse();
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `Logged in to ${PRODUCTION}\n`);
    assert.deepEqual(clock.delays, [5000, 5000, 10000]);
    assert.equal(polls.length, 3);
    assert.match(result.stderr, /https:\/\/firstdraft\.com\/device\n/);
    assert.match(result.stderr, /enter the code: BCDF-GHJK\n/);
    assert.match(
      result.stderr,
      /https:\/\/firstdraft\.com\/device\?user_code=BCDF-GHJK\n/,
    );
    assertNoSecrets(result);
    assert.doesNotMatch(result.stderr, /canary-device-code/);
    assert.equal(
      storedCredentials(result.configHome)[PRODUCTION]?.access_token,
      TOKEN,
    );
  }
});

test("device login reports denial and server-side expiry", async (context) => {
  for (const [code, error] of [
    ["access_denied", "authorization_denied"],
    ["expired_token", "authorization_expired"],
    ["invalid_grant", "login_failed"],
  ]) {
    const clock = fakeClock();
    const result = await invoke(context, ["login", "-i"], {
      loginSleep: clock.sleep,
      loginNow: clock.now,
      fetchFunction: async (input) =>
        new URL(String(input)).pathname === "/oauth/device_authorization"
          ? deviceAuthorizationResponse()
          : jsonResponse(400, { error: code }),
    });
    assert.equal(result.status, 1);
    assert.equal(errorEnvelope(result.stderr).error, error);
    assert.equal(result.stdout, "");
    assertNoCredentialsFile(result.configHome);
  }
});

test("device login stops polling at expires_in", async (context) => {
  const clock = fakeClock();
  let polls = 0;
  const result = await invoke(context, ["login", "-i"], {
    loginSleep: clock.sleep,
    loginNow: clock.now,
    fetchFunction: async (input) => {
      if (new URL(String(input)).pathname === "/oauth/device_authorization") {
        return deviceAuthorizationResponse({ expires_in: 12, interval: 5 });
      }
      polls += 1;
      return jsonResponse(400, { error: "authorization_pending" });
    },
  });
  assert.equal(result.status, 1);
  assert.equal(errorEnvelope(result.stderr).error, "authorization_expired");
  assert.equal(polls, 2);
  assert.deepEqual(clock.delays, [5000, 5000, 5000]);
});

test("device login rejects an invalid device authorization response", async (context) => {
  for (const body of [
    { ...deviceAuthorizationBody(), user_code: "BCDF\u001b[31m" },
    { ...deviceAuthorizationBody(), verification_uri: "javascript:alert(1)" },
    { ...deviceAuthorizationBody(), expires_in: 0 },
    { error: "invalid_client" },
  ]) {
    const result = await invoke(context, ["login", "-i"], {
      fetchFunction: async () =>
        jsonResponse("error" in body ? 400 : 200, body),
      loginSleep: async () => assert.fail("No polling was expected"),
    });
    assert.equal(result.status, 1);
    assert.equal(errorEnvelope(result.stderr).error, "login_failed");
    assert.equal(result.stderr.includes("\u001b"), false);
    assert.doesNotMatch(result.stderr, /javascript/);
  }
});

/**
 * @param {import("node:test").TestContext} context
 * @param {readonly string[]} argv
 * @param {Partial<import("../src/cli.js").RunOptions> & {configHome?: string, onStderr?: (text: string) => void}} [options]
 */
async function invoke(context, argv, options = {}) {
  const {
    configHome = temporaryConfigHome(context),
    onStderr,
    ...rest
  } = options;
  let stdout = "";
  let stderr = "";
  const status = await run({
    argv,
    stdout: { write: (text) => (stdout += text) },
    stderr: {
      write: (text) => {
        stderr += text;
        onStderr?.(text);
      },
    },
    apiToken: "",
    stagingApiToken: "",
    env: { XDG_CONFIG_HOME: configHome },
    homedir: () => assert.fail("The home directory must not be used"),
    hostname: () => "test-host",
    loginNow: () => Date.parse("2026-09-29T12:00:00.000Z"),
    fetchFunction: async () => assert.fail("No network request was expected"),
    ...rest,
  });
  return { status, stdout, stderr, configHome };
}

/** @param {import("node:test").TestContext} context */
function temporaryConfigHome(context) {
  const directory = mkdtempSync(path.join(tmpdir(), "firstdraft-login-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** @param {string} text */
function authorizationUrlIn(text) {
  const match = /https?:\/\/\S+\/oauth\/authorize\?\S+/.exec(text);
  return match ? new URL(match[0]) : undefined;
}

/**
 * @param {URL} authorization
 * @param {Record<string, string>} params
 */
async function callback(authorization, params) {
  const redirect = new URL(
    String(authorization.searchParams.get("redirect_uri")),
  );
  redirect.search = new URLSearchParams({
    ...params,
    state: String(authorization.searchParams.get("state")),
  }).toString();
  const response = await fetch(redirect);
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    csp: response.headers.get("content-security-policy") ?? "",
    body: await response.text(),
  };
}

/**
 * The page's only stylesheet must be allowed by its CSP hash, because
 * `default-src 'none'` blocks inline styles otherwise.
 *
 * @param {{csp: string, body: string}} page
 */
function assertStyledUnderCsp(page) {
  const style = /<style>([^<]*)<\/style>/.exec(page.body)?.[1];
  assert(style, "the callback page carries a stylesheet");
  const hash = createHash("sha256").update(style).digest("base64");
  assert.equal(page.csp, `default-src 'none'; style-src 'sha256-${hash}'`);
  assert.doesNotMatch(page.body, /\sstyle=/);
}

function tokenResponse() {
  return jsonResponse(200, { access_token: TOKEN, token_type: "Bearer" });
}

function deviceAuthorizationBody() {
  return {
    device_code: DEVICE_CODE,
    user_code: "BCDF-GHJK",
    verification_uri: `${PRODUCTION}/device`,
    verification_uri_complete: `${PRODUCTION}/device?user_code=BCDF-GHJK`,
    expires_in: 900,
    interval: 5,
  };
}

/** @param {Record<string, unknown>} [overrides] */
function deviceAuthorizationResponse(overrides = {}) {
  return jsonResponse(200, { ...deviceAuthorizationBody(), ...overrides });
}

/** @param {number} status @param {unknown} body */
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function fakeClock() {
  let current = Date.parse("2026-09-29T12:00:00.000Z");
  /** @type {number[]} */
  const delays = [];
  return {
    delays,
    now: () => current,
    /** @param {number} delayMs */
    sleep: async (delayMs) => {
      delays.push(delayMs);
      current += delayMs;
    },
  };
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

/**
 * @param {string} configHome
 * @returns {Record<string, {access_token: string}>}
 */
function storedCredentials(configHome) {
  return JSON.parse(
    readFileSync(
      path.join(configHome, "firstdraft", "credentials.json"),
      "utf8",
    ),
  ).origins;
}

/** @param {string} configHome */
function assertNoCredentialsFile(configHome) {
  assert.deepEqual(readdirSync(configHome), []);
}

/** @param {{stdout: string, stderr: string}} result */
function assertNoSecrets(result) {
  for (const output of [result.stdout, result.stderr]) {
    assert.doesNotMatch(
      output,
      /fd_canary|canary-login-token|canary-authorization-code/,
    );
  }
}

/** @param {string} stderr */
function errorEnvelope(stderr) {
  const start = stderr.lastIndexOf("\n{\n");
  return JSON.parse(stderr.startsWith("{") ? stderr : stderr.slice(start + 1));
}
