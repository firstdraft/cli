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
import { failureReportBody, redact } from "../src/commands/report.js";

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
  "--rerun",
  "bin/rails runner 1",
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

test("report progress prints the exact report, then sends those bytes once", async (context) => {
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
  assert.equal(requests.length, 1);
  const [request] = requests;
  assert(request);
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

test("reports_off is a handled message with exit status 0", async (context) => {
  const cwd = projectDirectory(context, PRODUCTION);
  for (const argv of [PROGRESS, FAILURE]) {
    const result = await invoke(argv, {
      cwd,
      fetchFunction: async () =>
        problem(403, "reports_off", "This account has not agreed to reports."),
    });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.ok(result.stdout.endsWith(REPORTS_OFF), result.stdout);
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
      fetchFunction: async () => response(),
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
      fetchFunction: async () => {
        requests += 1;
        return /** @type {() => Response} */ (response)();
      },
    });
    assert.equal(requests, 1);
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stderr), expected);
    assert.doesNotMatch(result.stderr, /canary/);
  }

  const unauthenticated = await invoke(PROGRESS, {
    cwd,
    fetchFunction: async () =>
      problem(401, "authentication_required", "A valid token is required."),
  });
  assert.equal(unauthenticated.status, 1);
  assert.equal(
    JSON.parse(unauthenticated.stderr).error,
    "authentication_required",
  );
});

test("report failure validates its arguments before any request", async () => {
  const [, , , ...required] = FAILURE;
  for (const argv of [
    ["report", "failure", COMPILATION_ID, ...required.slice(2)],
    [
      "report",
      "failure",
      COMPILATION_ID,
      ...required.slice(0, 2),
      ...required.slice(4),
    ],
    ["report", "failure", COMPILATION_ID, ...required.slice(0, 4)],
    [...FAILURE, "--kind", "lint_failure"],
    [
      "report",
      "failure",
      COMPILATION_ID,
      "--kind",
      "lint",
      ...required.slice(2),
    ],
    [
      "report",
      "failure",
      COMPILATION_ID,
      ...required.slice(0, 2),
      "--rerun",
      " ",
      ...required.slice(4),
    ],
    [...FAILURE.slice(0, -1), " "],
    [...FAILURE, "--ruby-version", "three"],
    [...FAILURE, "--rails-version", "8 1"],
    [...FAILURE, "--fix-summary", "a", "--fix-summary", "b"],
    ["report", "failure", "canary", ...required],
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

test("report failure redacts, cuts, and prints exactly what it sends", async (context) => {
  const cwd = projectDirectory(context, PRODUCTION);
  /** @type {string | undefined} */
  let sent;
  const frames = [
    "/usr/lib/ruby/3.4.0/forwardable.rb:238:in 'Forwardable#delegate'",
    ...Array.from(
      { length: 22 },
      (_, index) => `${cwd}/app/models/movie.rb:${index + 1}:in 'Movie#rate'`,
    ),
  ];
  const result = await invoke(
    [
      "report",
      "failure",
      COMPILATION_ID,
      "--kind",
      "spec_failure",
      "--rerun",
      `bundle exec rspec ${cwd}/spec/models/movie_spec.rb:42`,
      "--error-class",
      "NoMethodError",
      "--message",
      `undefined method 'stars' for nil\u001b[31m in /home/sam/.gem/x.rb mail sam@example.com token fd_${"a1".repeat(20)} ${"m".repeat(400)}`,
      ...frames.flatMap((frame) => ["--frame", frame]),
      "--fix-summary",
      `Guarded nil ratings. ${"s".repeat(300)}`,
      "--ruby-version",
      "3.4.7",
      "--rails-version",
      "8.1.4",
    ],
    {
      cwd,
      fetchFunction: async (input, init) => {
        assert.equal(
          String(input),
          `${PRODUCTION}/v1/projects/${PROJECT_ID}/compilations/${COMPILATION_ID}/failure-reports`,
        );
        sent = String(init?.body);
        return acknowledgment("failure_report");
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert(sent);
  assert.equal(
    result.stdout,
    `Sending this failure report for Compilation ${COMPILATION_ID} to ${PRODUCTION}:\n${sent}Sent.\n`,
  );
  const report = JSON.parse(sent).failure_report;
  assert.deepEqual(Object.keys(report), [
    "kind",
    "rerun",
    "error_class",
    "message",
    "frames",
    "fix_summary",
    "versions",
  ]);
  assert.equal(report.rerun, "bundle exec rspec spec/models/movie_spec.rb:42");
  assert.equal(
    report.message,
    `undefined method 'stars' for nil in [path] mail [email] token [token] ${"m".repeat(400)}`.slice(
      0,
      300,
    ),
  );
  assert.equal(report.frames.length, 20);
  assert.equal(report.frames[0], "app/models/movie.rb:1:in 'Movie#rate'");
  assert.equal(Array.from(report.fix_summary).length, 200);
  assert.ok(report.fix_summary.startsWith("Guarded nil ratings. "));
  assert.deepEqual(report.versions, { ruby: "3.4.7", rails: "8.1.4" });
  assert.doesNotMatch(sent, /\/home|\/usr|sam@|fd_|\\u001b|\/private|\/var/);
});

test("a failure report carries only the optional fields that were given", async (context) => {
  /** @type {unknown} */
  let sent;
  const result = await invoke(FAILURE, {
    cwd: projectDirectory(context, PRODUCTION),
    fetchFunction: async (_input, init) => {
      sent = JSON.parse(String(init?.body));
      return acknowledgment("failure_report");
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(sent, {
    failure_report: {
      kind: "boot_error",
      rerun: "bin/rails runner 1",
      error_class: "NameError",
    },
  });
});

test("a rerun command's assignments and frames outside the application stay home", () => {
  const { failure_report: report } = failureReportBody(
    {
      kind: "lint_failure",
      rerun:
        "npm_config_registry=https://registry.example.test PASS=a\\ b bin/rubocop --format=progress",
      errorClass: "Rails/Delegate",
      frames: ["/boot.rb:3", "C:\\x.rb:2", "app/x.rb:1", "../lib/y.rb:4"],
    },
    CWD,
  );
  assert.equal(
    report.rerun,
    "npm_config_registry=[value] PASS=[value] bin/rubocop --format=progress",
  );
  assert.deepEqual(report.frames, ["app/x.rb:1"]);

  const windows = failureReportBody(
    {
      kind: "spec_failure",
      rerun: 'label=North" West" ruby -I /gems -I/Shared\\ Gems x.rb',
      errorClass: "NoMethodError",
      frames: ["app\\models\\movie.rb:12:in 'Movie#rate'"],
    },
    CWD,
  ).failure_report;
  assert.equal(windows.rerun, "label=[value] ruby -I [path] -I[path] x.rb");
  assert.deepEqual(windows.frames, ["app/models/movie.rb:12:in 'Movie#rate'"]);
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

test("a current directory with spaces still makes its paths relative", () => {
  for (const [
    text,
    cwd,
    expected,
  ] of /** @type {[string, string, string][]} */ ([
    [
      "Error in /Users/Jane Doe/movie_catalog/app/models/movie.rb:12 here",
      "/Users/Jane Doe/movie_catalog",
      "Error in app/models/movie.rb:12 here",
    ],
    [
      "C:\\Users\\Jane Doe\\movie_catalog\\app\\x.rb:3",
      "C:\\Users\\Jane Doe\\movie_catalog",
      "app\\x.rb:3",
    ],
  ])) {
    assert.equal(redact(text, cwd), expected);
  }
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
      fetchFunction: async (input, init) => {
        requests.push({ url: String(input), body: String(init?.body) });
        return acknowledgment("failure_report");
      },
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
    ["app/models/movie.rb:12:in 'Movie#rate'"],
  );
});

test("redaction keeps relative paths and URLs and replaces what identifies a computer", () => {
  for (const [text, expected] of /** @type {[string, string][]} */ ([
    ["app/models/post.rb:12", "app/models/post.rb:12"],
    ["./spec/models/post_spec.rb:3", "./spec/models/post_spec.rb:3"],
    ["Rails/Delegate", "Rails/Delegate"],
    [
      "see https://firstdraft.com/update now",
      "see https://firstdraft.com/update now",
    ],
    [`${CWD}/config/database.yml:3: bad`, "config/database.yml:3: bad"],
    [`${CWD}-other/secret.rb`, "[path]"],
    ["/Users/sam/code/app/x.rb", "[path]"],
    ["~/code/app/x.rb", "[path]"],
    ["C:\\Users\\sam\\app\\x.rb", "[path]"],
    ["\\\\fileserver\\share\\Board\\x.md:3", "[path]"],
    ["//fileserver/share/x.md", "[path]"],
    ["~/notes.txt", "[path]"],
    ["file:///Users/sam/x.rb", "[path]"],
    ['open "/Users/sam/Work/Board Minutes.md" failed', 'open "[path]" failed'],
    [`'${CWD}/app/My File.rb'`, "'app/My File.rb'"],
    ["'rspec' and \"/ two\"", "'rspec' and \"/ two\""],
    ["LABEL=internal-only bin/rspec", "LABEL=[value] bin/rspec"],
    ["SECRET=a\\ b rest", "SECRET=[value] rest"],
    ["ruby -I/gems bin/test", "ruby -I[path] bin/test"],
    ["token fd_abcdefghijklmnopqrstuv here", "token [token] here"],
    [
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc",
      "Authorization: Bearer [token]",
    ],
    ["found /.dockerenv here", "found [path] here"],
    ['ruby "-I/Team Notes/lib" x.rb', 'ruby "-I[path]" x.rb'],
    [
      `env "BUILD_LABEL=O'Brien West" bin/rspec`,
      `env "BUILD_LABEL=[value]" bin/rspec`,
    ],
    [`env 'LABEL=say "hi" now' x`, "env 'LABEL=[value]' x"],
    ['ruby "-IC:\\My Work\\lib" -e 1', 'ruby "-I[path]" -e 1'],
    ["ruby /Program\\ Files/setup.rb", "ruby [path]"],
    [
      "env 'BUILD_LABEL=North West' bin/rspec",
      "env 'BUILD_LABEL=[value]' bin/rspec",
    ],
    [
      "undefined method `/' for nil and/or",
      "undefined method `/' for nil and/or",
    ],
    [
      'RAILS_ENV=test SECRET="a b" bin/rails',
      "RAILS_ENV=[value] SECRET=[value] bin/rails",
    ],
    [
      "expected count=3 with --format=progress",
      "expected count=3 with --format=progress",
    ],
    ["ruby -I/Users/example/local-gems/lib x.rb", "ruby -I[path] x.rb"],
    ["rspec --require=/Users/x/spec_helper.rb", "rspec --require=[path]"],
    [
      'open "file:///Users/sam/My Secret/a.txt" and "/Users/sam/My Secret.txt"',
      'open "[path]" and "[path]"',
    ],
    ["(file:///Users/sam/a.rb)", "([path])"],
    ["a / b and 3/4", "a / b and 3/4"],
    ["user.name+tag@mail.example.org", "[email]"],
    ["id 0190f3a2-7c1d-7e00-8b1a-3f9e2d4c5b6a", "id [token]"],
    [
      "sha 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "sha [token]",
    ],
    [
      "Compilation 01900000-0000-7000-8000-000000009101",
      "Compilation 01900000-0000-7000-8000-000000009101",
    ],
    [
      "movie_reviews_controller_index_action_name",
      "movie_reviews_controller_index_action_name",
    ],
    ["line\r\nnext\tcolumn\u0007", "line\nnext\tcolumn"],
  ])) {
    assert.equal(redact(text, CWD), expected, text);
  }
});

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
