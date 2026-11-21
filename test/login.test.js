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
import { VERSION } from "../src/version.js";

const PRODUCTION = "https://firstdraft.com";
const STAGING = "https://staging.firstdraft.com";
const TOKEN = "fd_canary-login-token";
const DEVICE_CODE = "canary-device-code";
const CODE = "canary-authorization-code";

const LOGIN_HELP = `First Draft CLI

Usage:
  firstdraft login [--interactive]
  firstdraft login --no-wait
  firstdraft login --finish

Options:
      --staging      Log in to staging
  -i, --interactive  Approve with a code on another device (no local browser)
      --device       Same as --interactive
      --no-wait      Start a device login, print its link and code, and exit
      --finish       Finish the device login that --no-wait started
  -h, --help         Show help

Environment:
  FIRSTDRAFT_API_URL  Log in to a custom API origin
  XDG_CONFIG_HOME     Credentials directory base (default: ~/.config)

By default the command prints a URL to open in a browser on this machine, then
waits up to five minutes for First Draft to redirect to a one-time listener on
127.0.0.1. The token is saved for the selected origin in
firstdraft/credentials.json under the configuration directory and is never
printed. Token environment variables take precedence over a saved login.

An agent logs in with two short commands. --no-wait saves the waiting login in
firstdraft/device-login.json and exits; once the person approves, --finish
waits at most 15 seconds, saves the token, and removes that file.
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
    ["login", "--no-wait", "--finish"],
    ["login", "--no-wait", "--no-wait"],
    ["login", "--finish", "--finish"],
    ["login", "--finish", "extra"],
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
      assert.equal(
        new Headers(init?.headers).get("firstdraft-client"),
        `cli/${VERSION}; os/${process.platform}`,
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
  // The computer's hostname is no longer sent as a device name.
  assert.equal(params.get("device_name"), null);
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
      loginSleep: clock.sleep,
      loginNow: clock.now,
      startLoopbackServer: async () => assert.fail("No server was expected"),
      fetchFunction: async (input, init) => {
        const endpoint = new URL(String(input));
        const form = new URLSearchParams(String(init?.body));
        assert.equal(form.get("client_id"), "firstdraft-cli");
        if (endpoint.pathname === "/oauth/device_authorization") {
          assert.equal(form.get("device_name"), null);
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

const STARTED_LINES = [
  `To log in to ${PRODUCTION}, ask the person to open this link in a browser, check that the page shows the code BCDF-GHJK, and approve:`,
  `${PRODUCTION}/device?user_code=BCDF-GHJK`,
  "The link and the code expire in 15 minutes, at 2026-09-29T12:15:00Z.",
  "When the person says they approved, run 'firstdraft login --finish'.",
];

test("login --no-wait prints the link and the code, saves the waiting login privately, and exits", async (context) => {
  for (const argv of [
    ["login", "--no-wait"],
    ["login", "--no-wait", "-i"],
    ["login", "--device", "--no-wait"],
  ]) {
    /** @type {string[]} */
    const requests = [];
    const result = await invoke(context, argv, {
      loginSleep: async () => assert.fail("--no-wait must not wait"),
      startLoopbackServer: async () => assert.fail("No server was expected"),
      fetchFunction: async (input, init) => {
        requests.push(String(input));
        assert.equal(
          new URLSearchParams(String(init?.body)).get("client_id"),
          "firstdraft-cli",
        );
        return deviceAuthorizationResponse();
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(requests, [`${PRODUCTION}/oauth/device_authorization`]);
    assert.equal(result.stdout, lines(...STARTED_LINES));
    assert.equal(result.stderr, "");
    assert.doesNotMatch(result.stdout + result.stderr, /canary-device-code/);

    const directory = path.join(result.configHome, "firstdraft");
    assert.deepEqual(readdirSync(directory), ["device-login.json"]);
    if (process.platform !== "win32") {
      assert.equal(statSync(directory).mode & 0o777, 0o700);
      assert.equal(
        statSync(path.join(directory, "device-login.json")).mode & 0o777,
        0o600,
      );
    }
    assert.deepEqual(waitingLogin(result.configHome), {
      format: "firstdraft.cli-device-login/1",
      origin: PRODUCTION,
      device_code: DEVICE_CODE,
      user_code: "BCDF-GHJK",
      verification_uri: `${PRODUCTION}/device`,
      verification_uri_complete: `${PRODUCTION}/device?user_code=BCDF-GHJK`,
      interval: 5,
      expires_at: "2026-09-29T12:15:00.000Z",
      next_poll_at: "2026-09-29T12:00:00.000Z",
    });
  }
});

test("login --no-wait asks for the code when First Draft sends no prefilled link", async (context) => {
  /** @type {Record<string, unknown>} */
  const body = {
    ...deviceAuthorizationBody(),
    verification_uri: `${STAGING}/device`,
    expires_in: 60,
  };
  delete body.verification_uri_complete;
  const result = await invoke(context, ["--staging", "login", "--no-wait"], {
    fetchFunction: async (input) => {
      assert.equal(new URL(String(input)).origin, STAGING);
      return jsonResponse(200, body);
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    lines(
      `To log in to ${STAGING}, ask the person to open this link in a browser, enter the code BCDF-GHJK, and approve:`,
      `${STAGING}/device`,
      "The link and the code expire in 1 minute, at 2026-09-29T12:01:00Z.",
      "When the person says they approved, run 'firstdraft login --finish --staging'.",
    ),
  );
  assert.equal(waitingLogin(result.configHome).origin, STAGING);
});

test("login --no-wait stops before the link when the login cannot be kept", async (context) => {
  const configHome = temporaryConfigHome(context);
  mkdirSync(path.join(configHome, "firstdraft"), { recursive: true });
  const credentialsFile = path.join(
    configHome,
    "firstdraft",
    "credentials.json",
  );
  writeFileSync(credentialsFile, "{canary");
  const unreadable = await invoke(context, ["login", "--no-wait"], {
    configHome,
  });
  assert.equal(unreadable.status, 1);
  assert.equal(unreadable.stdout, "");
  assert.deepEqual(errorEnvelope(unreadable.stderr), {
    error: "login_failed",
    detail:
      "The credentials file could not be read. No network request was made. Repair or remove it, then run 'firstdraft login' again.",
    reason: "credentials_invalid",
    phase: "read",
    credentials_path: credentialsFile,
  });

  const unsaved = await invoke(context, ["login", "--no-wait"], {
    credentialsFileSystem: {
      ...fs,
      renameSync: () => {
        throw Object.assign(new Error("canary"), { code: "EACCES" });
      },
    },
    fetchFunction: async () => deviceAuthorizationResponse(),
  });
  assert.equal(unsaved.status, 1);
  assert.equal(unsaved.stdout, "");
  assert.deepEqual(errorEnvelope(unsaved.stderr), {
    error: "login_failed",
    detail:
      "The device login file at credentials_path could not be used. Remove it, then run 'firstdraft start' to see whether this computer is logged in.",
    reason: "device_login_unavailable",
    credentials_path: path.join(
      unsaved.configHome,
      "firstdraft",
      "device-login.json",
    ),
  });
  assert.deepEqual(
    readdirSync(path.join(unsaved.configHome, "firstdraft")),
    [],
  );

  const limited = await invoke(context, ["login", "--no-wait"], {
    fetchFunction: async () =>
      jsonResponse(429, { error: "temporarily_unavailable" }),
  });
  assert.equal(limited.status, 1);
  assert.equal(errorEnvelope(limited.stderr).error, "rate_limited");
  assert.deepEqual(readdirSync(limited.configHome), []);
});

test("login --finish saves the token once the person approved and removes the waiting login", async (context) => {
  const clock = fakeClock();
  const configHome = await startedLogin(context, clock);
  /** @type {string[]} */
  const polls = [];
  const result = await invoke(context, ["login", "--finish"], {
    configHome,
    loginSleep: clock.sleep,
    loginNow: clock.now,
    startLoopbackServer: async () => assert.fail("No server was expected"),
    fetchFunction: async (input, init) => {
      assert.equal(String(input), `${PRODUCTION}/oauth/token`);
      const form = new URLSearchParams(String(init?.body));
      assert.equal(
        form.get("grant_type"),
        "urn:ietf:params:oauth:grant-type:device_code",
      );
      polls.push(String(form.get("device_code")));
      return tokenResponse();
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(polls, [DEVICE_CODE]);
  assert.deepEqual(clock.delays, [], "the first poll is answered at once");
  assert.equal(
    result.stdout,
    lines(
      `Logged in: this computer is now logged in to ${PRODUCTION}.`,
      "Run 'firstdraft start' again.",
    ),
  );
  assert.equal(result.stderr, "");
  assertNoSecrets(result);
  assert.doesNotMatch(result.stdout, /canary-device-code/);
  assert.equal(storedCredentials(configHome)[PRODUCTION]?.access_token, TOKEN);
  assert.deepEqual(readdirSync(path.join(configHome, "firstdraft")), [
    "credentials.json",
  ]);
});

test("login --finish waits briefly, then says it is still waiting and when to poll next", async (context) => {
  const clock = fakeClock();
  const configHome = await startedLogin(context, clock);
  let polls = 0;
  const pending = await invoke(context, ["login", "--finish"], {
    configHome,
    loginSleep: clock.sleep,
    loginNow: clock.now,
    fetchFunction: async () => {
      polls += 1;
      return jsonResponse(400, { error: "authorization_pending" });
    },
  });

  assert.equal(pending.status, 1);
  assert.equal(polls, 4);
  assert.deepEqual(clock.delays, [5000, 5000, 5000]);
  assert.equal(
    pending.stdout,
    lines(
      "Still waiting: the person has not approved the login yet.",
      STARTED_LINES[0] ?? "",
      STARTED_LINES[1] ?? "",
      "The link and the code expire at 2026-09-29T12:15:00Z. When the person says they approved, run 'firstdraft login --finish' again.",
    ),
  );
  assert.deepEqual(errorEnvelope(pending.stderr), {
    error: "authorization_pending",
    detail:
      "The person has not approved the login yet, and the CLI stopped waiting. When the person says they approved, run 'firstdraft login --finish' again.",
  });
  assert.equal(
    waitingLogin(configHome).next_poll_at,
    "2026-09-29T12:00:20.000Z",
  );

  clock.delays.length = 0;
  const finished = await invoke(context, ["login", "--finish"], {
    configHome,
    loginSleep: clock.sleep,
    loginNow: clock.now,
    fetchFunction: async () => tokenResponse(),
  });
  assert.equal(finished.status, 0, finished.stderr);
  assert.deepEqual(
    clock.delays,
    [5000],
    "a later --finish keeps to the interval since the last poll",
  );
});

test("login --finish slows down when First Draft asks and keeps the longer interval", async (context) => {
  const clock = fakeClock();
  const configHome = await startedLogin(context, clock);
  const outcomes = ["slow_down", "authorization_pending"];
  const pending = await invoke(context, ["login", "--finish"], {
    configHome,
    loginSleep: clock.sleep,
    loginNow: clock.now,
    fetchFunction: async () =>
      jsonResponse(400, { error: outcomes.shift() ?? "authorization_pending" }),
  });
  assert.equal(pending.status, 1);
  assert.equal(errorEnvelope(pending.stderr).error, "authorization_pending");
  assert.deepEqual(clock.delays, [10000]);
  assert.equal(waitingLogin(configHome).interval, 10);
  assert.equal(
    waitingLogin(configHome).next_poll_at,
    "2026-09-29T12:00:20.000Z",
  );
});

test("login --finish says plainly when the login was refused or expired, and removes it", async (context) => {
  /** @type {[string, string, string[] | null, string][]} */
  const cases = [
    [
      "access_denied",
      "authorization_denied",
      [
        `Refused: the person denied the login, so this computer is not logged in to ${PRODUCTION}.`,
        "Ask the person before you start another login with 'firstdraft login --no-wait'.",
      ],
      "The login was denied in the browser. No credential was saved. Ask the person before you start another login with 'firstdraft login --no-wait'.",
    ],
    [
      "expired_token",
      "authorization_expired",
      [
        `Expired: the link and the code expired before the person approved, so this computer is not logged in to ${PRODUCTION}.`,
        "To try again, run 'firstdraft login --no-wait'.",
      ],
      "The login expired before the person approved it. No credential was saved. Run 'firstdraft login --no-wait' to start again.",
    ],
    [
      "invalid_grant",
      "login_failed",
      null,
      "The login could not be finished, and no credential was saved. Start again with 'firstdraft login --no-wait'.",
    ],
  ];
  for (const [code, error, stdout, detail] of cases) {
    const clock = fakeClock();
    const configHome = await startedLogin(context, clock);
    const result = await invoke(context, ["login", "--finish"], {
      configHome,
      loginSleep: clock.sleep,
      loginNow: clock.now,
      fetchFunction: async () => jsonResponse(400, { error: code }),
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, stdout === null ? "" : lines(...stdout));
    const envelope = errorEnvelope(result.stderr);
    assert.equal(envelope.error, error);
    assert.equal(envelope.detail, detail);
    assert.deepEqual(readdirSync(path.join(configHome, "firstdraft")), []);
  }

  const clock = fakeClock();
  const configHome = await startedLogin(context, clock);
  await clock.sleep(15 * 60 * 1000);
  const expired = await invoke(context, ["login", "--finish"], {
    configHome,
    loginSleep: clock.sleep,
    loginNow: clock.now,
  });
  assert.equal(expired.status, 1);
  assert.equal(errorEnvelope(expired.stderr).error, "authorization_expired");
  assert.match(expired.stdout, /^Expired: /);
  assert.deepEqual(readdirSync(path.join(configHome, "firstdraft")), []);
});

test("login --finish keeps the waiting login after a failure it can retry", async (context) => {
  for (const response of [
    () => {
      throw new TypeError("canary network failure");
    },
    () => new Response("<html>canary</html>", { status: 500 }),
  ]) {
    const clock = fakeClock();
    const configHome = await startedLogin(context, clock);
    const result = await invoke(context, ["login", "--finish"], {
      configHome,
      loginSleep: clock.sleep,
      loginNow: clock.now,
      fetchFunction: async () => response(),
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    const envelope = errorEnvelope(result.stderr);
    assert.equal(envelope.error, "login_failed");
    assert.equal(
      envelope.detail,
      "The login could not be finished, and no credential was saved. Run 'firstdraft login --finish' again; if it fails again, start over with 'firstdraft login --no-wait'.",
    );
    assert.doesNotMatch(result.stderr, /canary/);
    assert.equal(
      waitingLogin(configHome).next_poll_at,
      "2026-09-29T12:00:05.000Z",
    );
  }
});

test("login --finish without a waiting login for the origin says so", async (context) => {
  const none = await invoke(context, ["login", "--finish"]);
  assert.equal(none.status, 1);
  assert.equal(
    none.stdout,
    lines(
      `No login is waiting: this computer has no device login for ${PRODUCTION} that has not ended.`,
      "Run 'firstdraft start' to see whether this computer is logged in.",
    ),
  );
  assert.deepEqual(errorEnvelope(none.stderr), {
    error: "login_not_started",
    detail: `No device login is waiting for ${PRODUCTION}: none was started with 'firstdraft login --no-wait', or it already ended. Run 'firstdraft start' to see whether this computer is logged in.`,
  });

  const clock = fakeClock();
  const configHome = await startedLogin(context, clock);
  const before = waitingLogin(configHome);
  const other = await invoke(context, ["login", "--finish", "--staging"], {
    configHome,
  });
  assert.equal(other.status, 1);
  assert.equal(errorEnvelope(other.stderr).error, "login_not_started");
  assert.match(other.stdout, /'firstdraft start --staging'/);
  assert.deepEqual(waitingLogin(configHome), before);
});

test("login --finish refuses a malformed waiting login before any request", async (context) => {
  const configHome = temporaryConfigHome(context);
  mkdirSync(path.join(configHome, "firstdraft"));
  const file = path.join(configHome, "firstdraft", "device-login.json");
  for (const source of [
    "{canary",
    JSON.stringify({ format: "firstdraft.cli-device-login/1" }),
  ]) {
    writeFileSync(file, source);
    const result = await invoke(context, ["login", "--finish"], { configHome });
    assert.equal(result.status, 1);
    assert.deepEqual(errorEnvelope(result.stderr), {
      error: "login_failed",
      detail:
        "The device login file at credentials_path could not be used. Remove it, then run 'firstdraft start' to see whether this computer is logged in.",
      reason: "device_login_invalid",
      credentials_path: file,
    });
    assert.equal(readFileSync(file, "utf8"), source);
  }
});

test("login --finish reports an issued token it could not save", async (context) => {
  const clock = fakeClock();
  const configHome = await startedLogin(context, clock);
  const result = await invoke(context, ["login", "--finish"], {
    configHome,
    loginSleep: clock.sleep,
    loginNow: clock.now,
    credentialsFileSystem: {
      ...fs,
      renameSync: (source, target) => {
        if (String(target).endsWith("credentials.json")) {
          throw Object.assign(new Error(TOKEN), { code: "EACCES" });
        }
        fs.renameSync(source, target);
      },
    },
    fetchFunction: async () => tokenResponse(),
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  const envelope = errorEnvelope(result.stderr);
  assert.equal(envelope.error, "login_failed");
  assert.equal(envelope.phase, "write");
  assert.equal(envelope.reason, "credentials_unavailable");
  assert.match(envelope.detail, /issued a token, but it could not be saved/);
  assertNoSecrets(result);
});

/**
 * Runs `login --no-wait` and returns its configuration directory.
 *
 * @param {import("node:test").TestContext} context
 * @param {ReturnType<typeof fakeClock>} clock
 */
async function startedLogin(context, clock) {
  const started = await invoke(context, ["login", "--no-wait"], {
    loginNow: clock.now,
    fetchFunction: async () => deviceAuthorizationResponse(),
  });
  assert.equal(started.status, 0, started.stderr);
  return started.configHome;
}

/** @param {string} configHome */
function waitingLogin(configHome) {
  return JSON.parse(
    readFileSync(
      path.join(configHome, "firstdraft", "device-login.json"),
      "utf8",
    ),
  );
}

/** @param {...string} values */
function lines(...values) {
  return values.map((value) => `${value}\n`).join("");
}

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
