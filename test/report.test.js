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
import {
  failureReportBody,
  plainWords,
  rspecRun,
} from "../src/commands/report.js";

const PRODUCTION = "https://firstdraft.com";
const STAGING = "https://staging.firstdraft.com";
const PROJECT_ID = "01900000-0000-7000-8000-000000009100";
const COMPILATION_ID = "01900000-0000-7000-8000-000000009101";
const STORED_ID = "0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e";
const TOKEN = "canary-report-token";
const STAGING_TOKEN = "canary-staging-report-token";
const CWD = path.resolve("/work/movie_catalog");
const REPORTS_OFF =
  "Not kept: this account has reports off, so First Draft kept nothing. Continue without sending reports.\n";
const PROGRESS = ["report", "progress", COMPILATION_ID, "--step", "setup"];
const FAILURE = [
  "report",
  "failure",
  COMPILATION_ID,
  "--kind",
  "boot_error",
  "--error-class",
  "NameError",
];

test("report help lists both reports and each report's options", async () => {
  for (const argv of [["report"], ["report", "--help"], ["report", "-h"]]) {
    const result = await invoke(argv);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /firstdraft report <command>/);
    assert.match(result.stdout, /progress {2}Report how far/);
    assert.match(result.stdout, /failure {3}Report an unexpected failure/);
  }

  const progress = await invoke(["report", "progress", "--help"]);
  assert.equal(progress.status, 0);
  for (const option of [
    "--step <step>",
    "--examples <n>",
    "--failures <n>",
    "--behavior-to-write-failures <n>",
    "--items-remaining <n>",
  ]) {
    assert.match(progress.stdout, new RegExp(option));
  }

  const failure = await invoke(["report", "failure", "-h"]);
  assert.equal(failure.status, 0);
  for (const option of [
    "--kind <kind>",
    "--rerun <command>",
    "--error-class <name>",
    "--message <text>",
    "--frame <path:line>",
    "--fix-summary <text>",
    "--ruby-version <v>",
    "--rails-version <v>",
  ]) {
    assert.match(failure.stdout, new RegExp(option));
  }

  for (const argv of [
    ["report", "canary"],
    ["report", "--canary"],
  ]) {
    const result = await invoke(argv);
    assert.equal(result.status, 2);
    assert.match(
      result.stderr,
      /Run 'firstdraft report --help' for usage\.\n$/,
    );
    assert.doesNotMatch(result.stderr, /canary/);
  }
});

test("report progress validates its arguments before any request", async () => {
  for (const argv of [
    ["report", "progress", "--step", "setup"],
    ["report", "progress", "not-a-uuid", "--step", "setup"],
    ["report", "progress", COMPILATION_ID],
    ["report", "progress", COMPILATION_ID, "--step", "canary"],
    [...PROGRESS, "--step", "setup"],
    [...PROGRESS, "--examples", "-1"],
    [...PROGRESS, "--failures=01"],
    [...PROGRESS, "--items-remaining=1.5"],
    [...PROGRESS, "--examples", "1000001"],
    [...PROGRESS, "--canary"],
    [...PROGRESS, COMPILATION_ID],
  ]) {
    const result = await invoke(argv);
    assert.equal(result.status, 2, argv.join(" "));
    assert.equal(result.stdout, "");
    assert.deepEqual(JSON.parse(result.stderr), {
      error: "invalid_arguments",
      detail:
        "Invalid arguments. Run 'firstdraft report progress --help' for usage.",
    });
  }
});

test("report progress reads the account, prints the exact report, then sends those bytes once", async (context) => {
  const cwd = projectDirectory(context, PRODUCTION);
  /** @type {{url: string, init: RequestInit | undefined}[]} */
  const requests = [];
  const result = await invoke(
    [
      "report",
      "progress",
      COMPILATION_ID,
      "--step",
      "specs_first_run",
      "--examples",
      "120",
      "--failures",
      "14",
      "--behavior-to-write-failures",
      "12",
      "--items-remaining",
      "0",
    ],
    {
      cwd,
      fetchFunction: async (input, init) => {
        requests.push({ url: String(input), init });
        if (requests.length === 1) return account("on");
        return new Response(
          `{"progress_report":{"id":"${STORED_ID}","compilation_id":"${COMPILATION_ID}"}}`,
          {
            status: 201,
            headers: { "Content-Type": "application/json" },
          },
        );
      },
    },
  );

  const body = `${JSON.stringify(
    {
      progress_report: {
        step: "specs_first_run",
        counts: {
          examples: 120,
          failures: 14,
          behavior_to_write_failures: 12,
          items_remaining: 0,
        },
      },
    },
    null,
    2,
  )}\n`;
  assert.deepEqual(result, {
    status: 0,
    stdout: `Sending this progress report for Compilation ${COMPILATION_ID} to ${PRODUCTION}:\n${body}Sent.\n`,
    stderr: "",
  });
  assert.equal(requests.length, 2);
  const [read, request] = requests;
  assert(read && request);
  assert.equal(read.url, `${PRODUCTION}/v1/account`);
  assert.equal(read.init?.method ?? "GET", "GET");
  assert.equal(read.init?.body, undefined);
  assert.equal(
    new Headers(read.init?.headers).get("authorization"),
    `Bearer ${TOKEN}`,
  );
  assert.equal(
    request.url,
    `${PRODUCTION}/v1/projects/${PROJECT_ID}/compilations/${COMPILATION_ID}/progress-reports`,
  );
  assert.equal(request.init?.method, "POST");
  assert.equal(request.init?.body, body);
  const headers = new Headers(request.init?.headers);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("authorization"), `Bearer ${TOKEN}`);
  assert.match(String(headers.get("firstdraft-client")), /^cli\//);
});

test("a progress report without counts sends only its step, to the pinned origin", async (context) => {
  /** @type {unknown} */
  let sent;
  const result = await invoke(["--staging", ...PROGRESS], {
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
      return acknowledgment("progress_report");
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(sent, { progress_report: { step: "setup" } });
});

test("reports stop on local problems before printing anything", async (context) => {
  for (const [cwd, error] of [
    [projectDirectory(context), "project_not_pushed"],
    [temporaryDirectory(context), "local_input_unreadable"],
  ]) {
    for (const argv of [PROGRESS, FAILURE]) {
      const result = await invoke(argv, { cwd });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.equal(JSON.parse(result.stderr).error, error);
    }
  }

  const mismatch = await invoke([...PROGRESS, "--staging"], {
    cwd: projectDirectory(context, PRODUCTION),
  });
  assert.equal(mismatch.status, 2);
  assert.equal(mismatch.stdout, "");
  assert.equal(JSON.parse(mismatch.stderr).error, "invalid_configuration");

  const noToken = await invoke(PROGRESS, {
    cwd: projectDirectory(context, STAGING),
    stagingApiToken: "",
  });
  assert.equal(noToken.status, 1);
  assert.equal(noToken.stdout, "");
  assert.equal(JSON.parse(noToken.stderr).error, "authentication_required");
});

test("with reports off, a report command sends nothing but the account read", async (context) => {
  const cwd = projectDirectory(context, PRODUCTION);
  for (const argv of [PROGRESS, FAILURE]) {
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
    assert.equal(requests[0]?.init?.method ?? "GET", "GET");
    assert.equal(requests[0]?.init?.body, undefined);
  }
});

test("reports turned off after the account read are a handled message with exit status 0", async (context) => {
  const cwd = projectDirectory(context, PRODUCTION);
  for (const argv of [PROGRESS, FAILURE]) {
    const result = await invoke(argv, {
      cwd,
      fetchFunction: reportsOn(async () =>
        problem(403, "reports_off", "This account has not agreed to reports."),
      ),
    });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /^Sending this /);
    assert.ok(result.stdout.endsWith(REPORTS_OFF), result.stdout);
  }
});

test("a stop on the account read prints and sends no report", async (context) => {
  const cwd = projectDirectory(context, PRODUCTION);
  for (const [response, error] of [
    [
      () =>
        new Response('{"reports":"on"}', {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "FirstDraft-Latest-CLI": "99.0.0",
            "FirstDraft-Minimum-CLI": "99.0.0",
          },
        }),
      "update_required",
    ],
    [
      () =>
        new Response(null, { status: 429, headers: { "Retry-After": "60" } }),
      "rate_limited",
    ],
  ]) {
    /** @type {string[]} */
    const requests = [];
    const result = await invoke(PROGRESS, {
      cwd,
      fetchFunction: async (input) => {
        requests.push(String(input));
        return /** @type {() => Response} */ (response)();
      },
    });
    assert.deepEqual(requests, [`${PRODUCTION}/v1/account`]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error, error);
  }
});

test("a report is not sent when the account cannot be read", async (context) => {
  const cwd = projectDirectory(context, PRODUCTION);
  const unavailable =
    "Could not read whether this account sends reports, so no report was sent. Continue without it.";
  const invalid =
    "First Draft returned an invalid account response, so no report was sent. Continue without it.";
  for (const [response, expected] of [
    [
      () => {
        throw new TypeError("canary socket hang up");
      },
      { error: "account_unavailable", detail: unavailable },
    ],
    [
      () => new Response("<html>canary</html>", { status: 503 }),
      { error: "account_unavailable", detail: unavailable, status: 503 },
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
        problem(401, "authentication_required", "A valid token is required."),
      { error: "authentication_required", status: 401 },
    ],
  ]) {
    for (const argv of [PROGRESS, FAILURE]) {
      /** @type {string[]} */
      const requests = [];
      const result = await invoke(argv, {
        cwd,
        fetchFunction: async (input, init) => {
          requests.push(String(input));
          assert.equal(init?.body, undefined);
          return /** @type {() => Response} */ (response)();
        },
      });
      assert.deepEqual(requests, [`${PRODUCTION}/v1/account`]);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      const error = JSON.parse(result.stderr);
      for (const [key, value] of Object.entries(
        /** @type {Record<string, unknown>} */ (expected),
      )) {
        assert.deepEqual(error[key], value, key);
      }
      assert.doesNotMatch(result.stderr, /canary/);
    }
  }
});

test("a success without First Draft's acknowledgment is not reported as sent", async (context) => {
  const cwd = projectDirectory(context, PRODUCTION);
  for (const response of [
    () => new Response("<html>canary</html>", { status: 200 }),
    () => new Response(null, { status: 204 }),
    () => acknowledgment("failure_report"),
    () =>
      new Response(
        JSON.stringify({
          progress_report: { id: STORED_ID, compilation_id: PROJECT_ID },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    () =>
      new Response(
        JSON.stringify({
          progress_report: { id: "   ", compilation_id: COMPILATION_ID },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    () =>
      new Response('{"progress_report":{}}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  ]) {
    const result = await invoke(PROGRESS, {
      cwd,
      fetchFunction: reportsOn(async () => response()),
    });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /Sent\./);
    assert.equal(JSON.parse(result.stderr).error, "report_unavailable");
  }
});

test("report failures are handled without retrying", async (context) => {
  const cwd = projectDirectory(context, PRODUCTION);
  const rejected =
    "First Draft rejected the report, so it was not kept; response.code says why. Continue without it.";
  const unavailable =
    "Could not confirm that First Draft received the report, and First Draft may hold it already. Continue without it rather than sending it again.";
  for (const [response, expected] of [
    [
      () => problem(404, "compilation_not_found", "No such Compilation."),
      {
        error: "report_rejected",
        detail: rejected,
        status: 404,
        response: {
          type: "about:blank",
          title: "Not Found",
          status: 404,
          code: "compilation_not_found",
          detail: "No such Compilation.",
        },
      },
    ],
    [
      () => problem(400, "invalid_report", "frames item 1 is not a path."),
      {
        error: "report_rejected",
        detail: rejected,
        status: 400,
        response: {
          type: "about:blank",
          title: "Bad Request",
          status: 400,
          code: "invalid_report",
          detail: "frames item 1 is not a path.",
        },
      },
    ],
    [
      () => new Response("<html>canary</html>", { status: 502 }),
      { error: "report_unavailable", detail: unavailable, status: 502 },
    ],
    [
      () => {
        throw new TypeError("canary socket hang up");
      },
      { error: "report_unavailable", detail: unavailable },
    ],
  ]) {
    let requests = 0;
    const result = await invoke(PROGRESS, {
      cwd,
      fetchFunction: reportsOn(async () => {
        requests += 1;
        return /** @type {() => Response} */ (response)();
      }),
    });
    assert.equal(requests, 1);
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stderr), expected);
    assert.doesNotMatch(result.stderr, /canary/);
  }

  const unauthenticated = await invoke(PROGRESS, {
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

test("report failure validates its arguments before any request", async () => {
  for (const argv of [
    ["report", "failure", COMPILATION_ID],
    ["report", "failure", COMPILATION_ID, "--kind", "lint"],
    [...FAILURE, "--kind", "lint_failure"],
    [...FAILURE, "--fix-summary", "a", "--fix-summary", "b"],
    [...FAILURE, "--canary"],
    ["report", "failure", "canary", "--kind", "boot_error"],
  ]) {
    const result = await invoke(argv);
    assert.equal(result.status, 2, argv.join(" "));
    assert.deepEqual(JSON.parse(result.stderr), {
      error: "invalid_arguments",
      detail:
        "Invalid arguments. Run 'firstdraft report failure --help' for usage.",
    });
  }
});

test("report failure prints exactly the shaped report and what it left out", async (context) => {
  const cwd = projectDirectory(context, PRODUCTION);
  /** @type {string | undefined} */
  let sent;
  const result = await invoke(
    [
      "report",
      "failure",
      COMPILATION_ID,
      "--kind",
      "spec_failure",
      "--rerun",
      "RAILS_ENV=test bundle exec rspec ./spec/models/movie_spec.rb:42",
      "--error-class",
      "NoMethodError",
      "--message",
      "undefined method 'stars' for nil in /home/sam/x.rb\nsecond line",
      "--frame",
      `${cwd}/app/models/movie.rb:12:in 'Movie#rate'`,
      "--frame",
      "/usr/lib/ruby/3.4.0/forwardable.rb:238",
      "--fix-summary",
      "Guarded nil ratings in Movie#rate.",
      "--ruby-version",
      "3.4.7",
      "--rails-version",
      "8.1.4-canary",
    ],
    {
      cwd,
      fetchFunction: reportsOn(async (input, init) => {
        assert.equal(
          String(input),
          `${PRODUCTION}/v1/projects/${PROJECT_ID}/compilations/${COMPILATION_ID}/failure-reports`,
        );
        sent = String(init?.body);
        return acknowledgment("failure_report");
      }),
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert(sent);
  assert.deepEqual(JSON.parse(sent), {
    failure_report: {
      kind: "spec_failure",
      rerun: "bundle exec rspec ./spec/models/movie_spec.rb:42",
      error_class: "NoMethodError",
      message: "undefined method […]",
      frames: ["app/models/movie.rb:12"],
      fix_summary: "Guarded nil ratings in Movie#rate.",
      versions: { ruby: "3.4.7" },
    },
  });
  assert.equal(
    result.stdout,
    `Sending this failure report for Compilation ${COMPILATION_ID} to ${PRODUCTION}:\n${sent}` +
      "Left out: 1 frame not in the application's files with a line number; the rails version, which is not a version number.\n" +
      "Sent.\n",
  );
});

test("a failure report carries only the fields that fit their shapes", async (context) => {
  /** @type {unknown} */
  let sent;
  const result = await invoke(
    [
      ...FAILURE.slice(0, 5),
      "--rerun",
      "bin/rubocop",
      "--error-class",
      "Rails/Delegate",
    ],
    {
      cwd: projectDirectory(context, PRODUCTION),
      fetchFunction: reportsOn(async (_input, init) => {
        sent = JSON.parse(String(init?.body));
        return acknowledgment("failure_report");
      }),
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(sent, { failure_report: { kind: "boot_error" } });
  assert.match(
    result.stdout,
    /\nLeft out: rerun, which is not an RSpec run of the application's specs; error_class, which is not a Ruby constant\.\n/,
  );
});

test("rerun keeps only an RSpec run of the application's specs", () => {
  for (const [
    command,
    expected,
  ] of /** @type {[string, string | undefined][]} */ ([
    [
      "bundle exec rspec ./spec/models/post_spec.rb:42",
      "bundle exec rspec ./spec/models/post_spec.rb:42",
    ],
    ["rspec spec/requests/posts_spec.rb", "rspec spec/requests/posts_spec.rb"],
    [
      "bin/rspec spec/a_spec.rb:1:2 spec/b_spec.rb",
      "bin/rspec spec/a_spec.rb:1:2 spec/b_spec.rb",
    ],
    // Leading assignments are dropped, and the RSpec run after them survives.
    [
      "RAILS_ENV=test bin/rspec spec/models/movie_spec.rb:42",
      "bin/rspec spec/models/movie_spec.rb:42",
    ],
    [
      "env 'RAILS_ENV=test' bundle exec rspec spec/models/movie_spec.rb",
      "bundle exec rspec spec/models/movie_spec.rb",
    ],
    [
      "npm_config_registry=https://r.example.test PASS=a\\ b rspec spec/x_spec.rb",
      "rspec spec/x_spec.rb",
    ],
    // The multiline quoted assignment from review: the whole value goes.
    [
      '\'APP_CONFIG={\n  "tenant": "Team West"\n}\' bin/rspec spec/models/movie_spec.rb',
      "bin/rspec spec/models/movie_spec.rb",
    ],
    // The quoted assignment followed by a quoted argument, from review: an
    // -e option is not a spec path, so the field is left out.
    [
      "env 'RAILS_ENV=test' bin/rspec spec/models/movie_spec.rb -e 'creates a movie'",
      undefined,
    ],
    // A spec directory with a trailing slash is sent without it.
    ["bundle exec rspec spec/models/", "bundle exec rspec spec/models"],
    [
      "rspec ./spec/requests// spec/models/a_spec.rb:3",
      "rspec ./spec/requests spec/models/a_spec.rb:3",
    ],
    ["rspec spec/", undefined],
    ["rspec spec//models/a_spec.rb", undefined],
    ["bin/rubocop", undefined],
    ["bin/rails runner 1", undefined],
    ["rspec", undefined],
    // A parent segment in any argument, not only the last.
    ["rspec spec/.. spec/models", undefined],
    ["rspec spec/models/../ spec/models/post_spec.rb", undefined],
    ["rspec spec/models/post_spec.rb:3 spec/..", undefined],
    ["rspec spec/a..b_spec.rb", "rspec spec/a..b_spec.rb"],
    ["rspec /Users/sam/app/spec/a_spec.rb", undefined],
    ["rspec spec/../../etc/a_spec.rb", undefined],
    ["rspec spec/a_spec.rb; curl https://example.test", undefined],
    ["RAILS_ENV=test", undefined],
    ["'unterminated bin/rspec spec/a_spec.rb", undefined],
  ])) {
    assert.equal(rspecRun(command), expected, command);
  }
});

test("free text keeps the plain words before its first quote character", () => {
  for (const [text, expected] of /** @type {[string, string][]} */ ([
    // Codex's two inputs: quotes are never paired, so nothing past the
    // first one survives, even across a line break.
    [`couldn't read "/Users/O'Brien/Client North Team/data.rb" today`, "[…]"],
    [
      "Setting 'BUILD_LABEL=North West Research\nlater' it closes",
      "Setting […]",
    ],
    [`load "/Users/O'Brien/First Draft/report.rb" now`, "load […]"],
    ["undefined method 'stars' for nil:NilClass", "undefined method […]"],
    ["can't find `x`", "[…]"],
    ["`x` first", "[…]"],
    [
      "Validation failed: Email has already been taken",
      "Validation failed: Email has already been taken",
    ],
    ["first line\nsecond line with a secret", "first line"],
    [
      "sam@example.com at https://x.test/a and C:\\Users\\sam",
      "[…] at […] and […]",
    ],
    ["LABEL=North West", "[…] West"],
    ["token fd_abcdefghijklmnopqrstuvwxyz", "token […]"],
    ["Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc", "Bearer […]"],
    ["tabs\tand\u0007 bells", "tabs and bells"],
    // Unicode line breaks end the first line too.
    ["First line\u2028Second line", "First line"],
    ["First line\u2029Second line", "First line"],
    ["First line\u0085Second line", "First line"],
  ])) {
    assert.equal(plainWords(text, 300), expected, text);
  }
  const long = plainWords("word ".repeat(100), 300);
  assert.equal(long.split(" ").length, 60);
  assert.ok(Array.from(long).length <= 300);
  assert.equal(plainWords("Guarded the nil 'x' case", 12), "Guarded the");
});

test("free text with no plain words is left out and named", () => {
  const { body, omitted } = failureReportBody(
    { kind: "spec_failure", message: "\nsecond line", fixSummary: "   " },
    CWD,
  );
  assert.deepEqual(body.failure_report, { kind: "spec_failure" });
  assert.deepEqual(omitted, [
    "message, which has no plain words on its first line",
    "fix_summary, which has no plain words on its first line",
  ]);
});

test("a progress count of the service's maximum is sent", async (context) => {
  /** @type {unknown} */
  let sent;
  const result = await invoke([...PROGRESS, "--examples", "1000000"], {
    cwd: projectDirectory(context, PRODUCTION),
    fetchFunction: reportsOn(async (_input, init) => {
      sent = JSON.parse(String(init?.body));
      return acknowledgment("progress_report");
    }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(sent, {
    progress_report: { step: "setup", counts: { examples: 1000000 } },
  });
});

test("frames, error classes, and versions keep only their shapes", () => {
  const { body, omitted } = failureReportBody(
    {
      kind: "spec_failure",
      errorClass: "ActiveRecord::RecordInvalid",
      frames: [
        "app/models/movie.rb:12:in 'Movie#rate'",
        "./spec/models/movie_spec.rb:3",
        `${CWD}/lib/tasks/import.rb:7`,
        "app\\controllers\\movies_controller.rb:9",
        "/usr/lib/ruby/3.4.0/forwardable.rb:238",
        "../other/lib/x.rb:1",
        "app/models/movie.rb",
        "vendor/bundle/x.rb:1",
        "app/models/my movie.rb:1",
      ],
      rubyVersion: "3.4.7",
      railsVersion: "8.1",
    },
    CWD,
  );
  assert.deepEqual(body.failure_report, {
    kind: "spec_failure",
    error_class: "ActiveRecord::RecordInvalid",
    frames: [
      "app/models/movie.rb:12",
      "spec/models/movie_spec.rb:3",
      "lib/tasks/import.rb:7",
      "app/controllers/movies_controller.rb:9",
    ],
    versions: { ruby: "3.4.7", rails: "8.1" },
  });
  assert.deepEqual(omitted, [
    "5 frames not in the application's files with a line number",
  ]);

  for (const errorClass of [
    "Rails/Delegate",
    "no_method_error",
    "Foo::",
    "A::b",
  ]) {
    const shaped = failureReportBody({ kind: "lint_failure", errorClass }, CWD);
    assert.equal(shaped.body.failure_report.error_class, undefined, errorClass);
  }
});

test("a malformed Project state is reported, not replaced by an archived one", async (context) => {
  const cwd = projectDirectory(context, PRODUCTION);
  writeFileSync(path.join(cwd, ".firstdraft", "state.json"), "{canary\n");
  const design = path.join(cwd, ".firstdraft", "design", ".firstdraft");
  mkdirSync(design, { recursive: true });
  writeFileSync(
    path.join(design, "state.json"),
    `${JSON.stringify({
      format: "firstdraft.cli-state/1",
      project_id: "01900000-0000-7000-8000-000000009199",
      api_url: PRODUCTION,
      foundation_plan_etag: '"sha256:' + "1".repeat(64) + '"',
    })}\n`,
  );
  const result = await invoke(PROGRESS, { cwd });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(JSON.parse(result.stderr).error, "local_input_unreadable");
});

test("reports run from an adopted application root find the archived Project", async (context) => {
  const root = temporaryDirectory(context);
  const design = path.join(root, ".firstdraft", "design");
  mkdirSync(design, { recursive: true });
  writeFileSync(path.join(root, ".firstdraft", "gaps.json"), "{}\n");
  mkdirSync(path.join(design, ".firstdraft"));
  writeFileSync(
    path.join(design, ".firstdraft", "state.json"),
    `${JSON.stringify({
      format: "firstdraft.cli-state/1",
      project_id: PROJECT_ID,
      api_url: PRODUCTION,
      foundation_plan_etag: '"sha256:' + "1".repeat(64) + '"',
    })}\n`,
  );
  /** @type {{url: string, body: string}[]} */
  const requests = [];
  const result = await invoke(
    [
      ...FAILURE,
      "--frame",
      `${root}/app/models/movie.rb:12:in 'Movie#rate'`,
      "--frame",
      "../other_project/lib/work.rb:10",
      "--frame",
      "app/../../outside.rb:1",
    ],
    {
      cwd: root,
      fetchFunction: reportsOn(async (input, init) => {
        requests.push({ url: String(input), body: String(init?.body) });
        return acknowledgment("failure_report");
      }),
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0]?.url,
    `${PRODUCTION}/v1/projects/${PROJECT_ID}/compilations/${COMPILATION_ID}/failure-reports`,
  );
  assert.deepEqual(
    JSON.parse(String(requests[0]?.body)).failure_report.frames,
    ["app/models/movie.rb:12"],
  );
});

/**
 * Answers the account read at the pinned production origin with reports on,
 * and hands every other request to `report`.
 *
 * @param {(input: string | URL | Request, init?: RequestInit) => Promise<Response>} report
 * @returns {typeof globalThis.fetch}
 */
function reportsOn(report) {
  return async (input, init) => {
    if (new URL(String(input)).pathname !== "/v1/account") {
      return report(input, init);
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

/** @param {string} wrapper the report's key in First Draft's acknowledgment */
function acknowledgment(wrapper) {
  const report = { id: STORED_ID, compilation_id: COMPILATION_ID };
  return new Response(JSON.stringify({ [wrapper]: report }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
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
  return cwd;
}

/** @param {import("node:test").TestContext} context */
function temporaryDirectory(context) {
  const cwd = realpathSync(
    mkdtempSync(path.join(tmpdir(), "firstdraft-report-")),
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
