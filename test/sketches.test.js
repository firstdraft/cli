import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  startProject,
  publishSketches,
  reviewedSources,
} from "../src/commands/sketches.js";
import {
  SketchError,
  bindPlanValues,
  captureBoard,
  digest,
  loadSources,
} from "../src/sketch-capture.js";
import { initializePlan } from "../src/commands/plan-init.js";
import { pushPlan } from "../src/commands/plan-push.js";
import { ApiAuthenticationRequiredError } from "../src/api-authentication.js";
import { reviewConflict } from "../src/api-response.js";
import { generateUuidV7 } from "../src/uuid-v7.js";

const chromeTest = {
  skip:
    !process.env.FIRSTDRAFT_CHROME_PATH &&
    ![
      "/Applications/Google Chrome.app",
      "/opt/google/chrome/chrome",
      ...[
        process.env.LOCALAPPDATA,
        process.env.PROGRAMFILES,
        process.env["PROGRAMFILES(X86)"],
      ]
        .filter((root) => root !== undefined)
        .map((root) =>
          path.join(root, "Google", "Chrome", "Application", "chrome.exe"),
        ),
    ].some((file) => existsSync(file)),
};
const apiUrl = "https://firstdraft.test";
/** @param {import("node:test").TestContext} t */
function directory(t) {
  const cwd = mkdtempSync(path.join(tmpdir(), "firstdraft-sketches-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}
/** @param {string} cwd */
function draw(cwd) {
  const sketches = path.join(cwd, "sketches");
  mkdirSync(sketches);
  writeFileSync(
    path.join(sketches, "board.json"),
    JSON.stringify({
      assets: ["theme.css"],
      screens: [
        {
          id: "ballot",
          name: "Guest ballot",
          source: "ballot.html",
          sample_keys: [],
          plan_subjects: [],
        },
      ],
    }),
  );
  writeFileSync(
    path.join(sketches, "theme.css"),
    "button{margin-top:900px} @media(max-width:500px){button{margin-top:1100px}}",
  );
  writeFileSync(
    path.join(sketches, "ballot.html"),
    '<!DOCTYPE html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="theme.css"><button data-sketch-key="submit" data-plan-pointer="/application/name">Submit</button><img alt="avatar"><span data-sketch-key="cafe">Café — Mira’s pick</span>',
  );
}

test("a reserved Project survives a lost start, Plan init and an ambiguous review publication", async (t) => {
  const cwd = directory(t);
  const opts = { cwd, apiUrl };
  await assert.rejects(
    startProject({
      ...opts,
      hasTokenFor: () => false,
      fetchFunction: async () => assert.fail("wrong origin requested"),
    }),
    ApiAuthenticationRequiredError,
  );
  assert(!existsSync(path.join(cwd, ".firstdraft")));
  await assert.rejects(
    startProject({
      ...opts,
      fetchFunction: async () => {
        throw Error("disconnect");
      },
    }),
  );
  const stateFile = path.join(cwd, ".firstdraft", "state.json");
  const original = JSON.parse(readFileSync(stateFile, "utf8"));
  assert(!existsSync(path.join(cwd, ".firstdraft", "foundation-plan.json")));
  const result = await startProject({
    ...opts,
    fetchFunction: async (input) => {
      assert.equal(
        String(input),
        apiUrl + "/v1/projects/" + original.project_id,
      );
      return Response.json({
        project: {
          id: original.project_id,
          url: "/projects/" + original.project_id,
        },
      });
    },
  });
  assert.equal(result.project.url, apiUrl + "/projects/" + original.project_id);
  const init = {
    cwd,
    applicationKey: "award_pool",
    name: "Awards",
    projectId: generateUuidV7(),
  };
  initializePlan(init);
  assert.throws(() => initializePlan(init));
  assert.equal(
    JSON.parse(readFileSync(stateFile, "utf8")).project_id,
    original.project_id,
  );
  draw(cwd);
  for (const status of [400, 401, 403, 404, 410, 415, 429]) {
    let captures = 0;
    const screen = path.join(cwd, "sketches", "ballot.html");
    const sourceBefore = readFileSync(screen, "utf8");
    for (const expectedSource of [sourceBefore, sourceBefore + "\n"]) {
      writeFileSync(screen, expectedSource);
      await assert.rejects(
        publishSketches({
          ...opts,
          capture: async (sources, plan) => {
            captures++;
            assert.equal(
              sources.files.get("ballot.html")?.toString(),
              expectedSource,
            );
            return { version: 1, plan_sha256: digest(plan), screens: [] };
          },
          fetchFunction: async () => new Response(null, { status }),
        }),
        /declined/,
      );
    }
    assert.equal(captures, 2);
  }
  await assert.rejects(
    publishSketches({
      ...opts,
      hasTokenFor: () => false,
      capture: async () => assert.fail("wrong origin captured"),
      fetchFunction: async () => assert.fail("wrong origin requested"),
    }),
    ApiAuthenticationRequiredError,
  );
  assert(!existsSync(path.join(cwd, ".firstdraft", "sketch-pending.json")));
  await assert.rejects(
    publishSketches({
      ...opts,
      capture: async (_sources, plan) => ({
        version: 1,
        plan_sha256: digest(plan),
        screens: [],
      }),
      fetchFunction: async () => {
        throw Error("invalid review response lost");
      },
    }),
  );
  await assert.rejects(
    publishSketches({
      ...opts,
      capture: async () => assert.fail("retry recaptured"),
      fetchFunction: async () =>
        Response.json(
          {
            title: "Invalid sketch review",
            status: 422,
            code: "invalid_sketch_review",
            detail: "Unknown Plan reference",
          },
          {
            status: 422,
            headers: { "Content-Type": "application/problem+json" },
          },
        ),
    }),
    /declined/,
  );
  assert(!existsSync(path.join(cwd, ".firstdraft", "sketch-pending.json")));
  let sent = "";
  /** @type {typeof captureBoard} */
  const capture = async (_sources, plan) => ({
    version: 1,
    plan_sha256: digest(plan),
    screens: [],
  });
  await assert.rejects(
    publishSketches({
      ...opts,
      capture,
      fetchFunction: async (_input, request) => {
        sent = String(request?.body);
        throw Error("response lost");
      },
    }),
  );
  for (const status of [401, 403, 404, 429]) {
    await assert.rejects(
      publishSketches({
        ...opts,
        capture: async () => assert.fail("retry recaptured"),
        fetchFunction: async (_input, request) => {
          assert.equal(request?.body, sent);
          return new Response(null, { status });
        },
      }),
      /declined/,
    );
    assert(existsSync(path.join(cwd, ".firstdraft", "sketch-pending.json")));
  }
  /** @type {typeof fetch} */
  const accepted = async (input, request) => {
    assert.equal(String(request?.body), sent);
    const { manifest, previous_revision_id, expected_plan_sha256 } =
      JSON.parse(sent);
    assert.equal(previous_revision_id, null);
    assert.equal(expected_plan_sha256, null);
    return Response.json(
      {
        project: { id: original.project_id },
        review: {
          id: String(input).split("/").at(-1),
          plan_sha256: manifest.plan_sha256,
        },
        foundation_plan: { source_sha256: manifest.plan_sha256 },
      },
      {
        status: 201,
        headers: { etag: '"sha256:' + manifest.plan_sha256 + '"' },
      },
    );
  };
  let releaseDelayedResponse = () => {};
  const delayedResponse = new Promise((resolve) => {
    releaseDelayedResponse = () => resolve(undefined);
  });
  let markInFlight = () => {};
  const inFlight = new Promise((resolve) => {
    markInFlight = () => resolve(undefined);
  });
  const delayed = publishSketches({
    ...opts,
    capture,
    fetchFunction: async (input, request) => {
      const response = await accepted(input, request);
      markInFlight();
      await delayedResponse;
      return response;
    },
  });
  await inFlight;
  await assert.rejects(
    publishSketches({
      ...opts,
      capture: async () => assert.fail("busy retry recaptured"),
      fetchFunction: async () => assert.fail("busy retry sent a request"),
    }),
    /Another command is updating/,
  );
  releaseDelayedResponse();
  const review = await delayed;
  const files = reviewedSources(cwd, review.review.id);
  // Pilot checkouts have only the current receipt when upgraded.
  rmSync(
    path.join(cwd, ".firstdraft", "sketch-reviews", review.review.id + ".json"),
  );
  assert(files?.files.has("theme.css"));
  assert.throws(() => reviewedSources(cwd, generateUuidV7()));
  assert.throws(
    () => reviewedSources(cwd, generateUuidV7(), true),
    /Restore the local receipt/,
  );
  writeFileSync(
    path.join(cwd, "sketches", "theme.css"),
    "body{color:darkgreen}",
  );
  assert.throws(() => reviewedSources(cwd, review.review.id), /changed/);
  await assert.rejects(
    publishSketches({
      ...opts,
      capture,
      fetchFunction: async (_input, request) => {
        const draft = JSON.parse(String(request?.body));
        assert.equal(draft.previous_revision_id, review.review.id);
        assert.equal(draft.expected_plan_sha256, review.review.plan_sha256);
        return Response.json(
          { code: "sketch_review_conflict" },
          { status: 409 },
        );
      },
    }),
    /declined/,
  );
  const latestId = generateUuidV7();
  const latestHead = "1".repeat(64);
  const rebase = { ...opts, capture, after: latestId, head: latestHead };
  await assert.rejects(
    publishSketches({
      ...rebase,
      fetchFunction: async () => {
        throw Error("lost rebase response");
      },
    }),
  );
  await assert.rejects(
    publishSketches({
      ...rebase,
      after: generateUuidV7(),
      fetchFunction: accepted,
    }),
    /different preconditions/,
  );
  const theme = path.join(cwd, "sketches", "theme.css");
  const currentTheme = readFileSync(theme);
  writeFileSync(theme, "button{color:blue}");
  const replacement = await publishSketches({
    ...opts,
    capture,
    after: latestId,
    head: latestHead,
    fetchFunction: async (input, request) => {
      const draft = JSON.parse(String(request?.body));
      assert.equal(draft.previous_revision_id, latestId);
      assert.equal(draft.expected_plan_sha256, latestHead);
      const id = String(input).split("/").at(-1);
      return Response.json(
        {
          project: { id: original.project_id },
          review: { id, plan_sha256: draft.manifest.plan_sha256 },
          foundation_plan: { source_sha256: draft.manifest.plan_sha256 },
        },
        { headers: { etag: '"sha256:' + draft.manifest.plan_sha256 + '"' } },
      );
    },
  });
  assert.match(
    replacement.next_step ?? "",
    /Run firstdraft sketches publish again/,
  );
  const approvedTheme = files?.files.get("theme.css");
  assert(approvedTheme);
  writeFileSync(theme, approvedTheme);
  assert(reviewedSources(cwd, review.review.id, true));
  assert.throws(() => reviewedSources(cwd, review.review.id));
  writeFileSync(theme, currentTheme);
  assert(reviewedSources(cwd, replacement.review.id));
  const planPath = path.join(cwd, ".firstdraft", "foundation-plan.json");
  const source = readFileSync(planPath);
  const nextSource = Buffer.concat([source, Buffer.from(" ")]);
  const newHead = digest(nextSource);
  await publishSketches({
    ...opts,
    capture,
    fetchFunction: async (input) => {
      writeFileSync(planPath, nextSource);
      await assert.rejects(
        pushPlan({
          ...opts,
          fetchFunction: async () => assert.fail("busy push sent a request"),
        }),
        /Another command is updating/,
      );
      return Response.json(
        {
          project: { id: original.project_id },
          review: {
            id: String(input).split("/").at(-1),
            plan_sha256: digest(source),
          },
          foundation_plan: { source_sha256: digest(source) },
        },
        { headers: { etag: '"sha256:' + digest(source) + '"' } },
      );
    },
  });
  assert.equal(
    JSON.parse(readFileSync(stateFile, "utf8")).foundation_plan_etag,
    '"sha256:' + digest(source) + '"',
  );
  await pushPlan({
    ...opts,
    fetchFunction: async () => {
      await assert.rejects(
        publishSketches({
          ...opts,
          capture,
          fetchFunction: async () =>
            assert.fail("busy publication sent a request"),
          after: replacement.review.id,
          head: newHead,
        }),
        /Another command is updating/,
      );
      return Response.json(
        {
          project: { id: original.project_id, graph_version: 2 },
          foundation_plan: { format: "test", source_sha256: newHead },
          diagnostics: [],
        },
        { headers: { etag: '"sha256:' + newHead + '"' } },
      );
    },
  });
  assert.equal(
    JSON.parse(readFileSync(stateFile, "utf8")).foundation_plan_etag,
    '"sha256:' + newHead + '"',
  );
  writeFileSync(planPath, Buffer.from([0x22, 0xff, 0x22]));
  await assert.rejects(
    publishSketches({
      ...opts,
      capture: async () => assert.fail("invalid Plan reached capture"),
      fetchFunction: accepted,
    }),
    /UTF-8/,
  );
  assert(!existsSync(path.join(cwd, ".firstdraft", "sketch-pending.json")));
});

test("malformed Plan JSON produces a handled error without exposing source text", async (t) => {
  const cwd = directory(t);
  draw(cwd);
  await assert.rejects(
    captureBoard(loadSources(cwd), "private-example-record"),
    (error) => {
      assert(error instanceof SketchError);
      assert.equal(
        error.message,
        "The working Foundation Plan must contain valid JSON.",
      );
      assert.doesNotMatch(error.stack ?? "", /private-example-record/);
      return true;
    },
  );
});

test(
  "Chrome resolves only JSON object members and canonical array indices in Plan bindings",
  chromeTest,
  async (t) => {
    const cwd = directory(t);
    draw(cwd);
    const html = path.join(cwd, "sketches", "ballot.html");
    const plan = JSON.stringify({
      "a/b": { "~": [{ "": "Escaped label" }] },
      ["__proto__"]: "Own key",
      "~2": "bad escape",
      "~": "trailing escape",
      rows: [],
      name: "Mira",
    });
    writeFileSync(
      html,
      '<button data-sketch-key="valid" data-plan-pointer="/a~1b/~0/0/">Fallback</button><button data-sketch-key="own" data-plan-pointer="/__proto__">Fallback</button>',
    );
    const { screens } = await captureBoard(loadSources(cwd), plan);
    assert.deepEqual(
      screens[0]?.desktop.elements.map((e) => e.label),
      ["Escaped label", "Own key"],
    );
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({
      channel: "chrome",
      executablePath: process.env.FIRSTDRAFT_CHROME_PATH,
    });
    t.after(() => browser.close());
    const page = await browser.newPage();
    for (const pointer of [
      "/~2",
      "/~",
      "/rows/length",
      "/name/length",
      "/name/0",
      "/a~1b/~0/00",
      "/rows/toString/name",
      "/toString/name",
    ]) {
      await page.setContent(
        `<button data-plan-pointer="${pointer}">Fallback</button>`,
      );
      assert.match(
        (await page.evaluate(bindPlanValues, plan)) ?? "",
        /data-plan-pointer/,
        pointer,
      );
    }
  },
);

test(
  "Chrome captures responsive long screens, matching Plan values and a readable thumbnail",
  chromeTest,
  async (t) => {
    const cwd = directory(t);
    draw(cwd);
    const board = await captureBoard(
      loadSources(cwd),
      JSON.stringify({ application: { name: "Mira’s ballot" } }),
    );
    const screen = board.screens[0];
    assert(screen);
    const { desktop, mobile } = screen;
    for (const [capture, width, height] of /** @type {const} */ ([
      [desktop, 1280, 800],
      [mobile, 390, 844],
    ])) {
      assert.equal(capture.width, width);
      assert.equal(capture.height, height);
      const png = Buffer.from(capture.png_base64, "base64");
      assert.equal(png.readUInt32BE(16), width);
      assert.equal(png.readUInt32BE(20), capture.content_height);
      assert(capture.elements[0]);
      assert(capture.content_height > height);
      assert(capture.elements[0].y > height);
      assert.equal(capture.elements[0].label, "Mira’s ballot");
      assert.equal(capture.elements[0].id, "submit");
      assert.equal(
        capture.elements.find((element) => element.id === "cafe")?.label,
        "Café — Mira’s pick",
      );
      assert.equal(
        Buffer.from(capture.thumbnail_base64, "base64").readUInt32BE(16),
        Math.min(480, width),
      );
    }
    assert(mobile.elements[0] && desktop.elements[0]);
    assert(mobile.elements[0].y > desktop.elements[0].y);
  },
);

test("review conflicts preserve both service preconditions, including an empty Head", () => {
  for (const [status, code] of /** @type {const} */ ([
    [409, "sketch_review_conflict"],
    [412, "sketch_review_changed"],
  ])) {
    for (const current_review of [
      null,
      { id: generateUuidV7(), plan_sha256: "2".repeat(64) },
    ]) {
      const body = {
        status,
        code,
        detail: "Reopen the Project.",
        current_review,
        head_sha256: current_review?.plan_sha256 ?? null,
      };
      const response = Response.json(body, {
        status,
        headers: { "Content-Type": "application/problem+json" },
      });
      assert.deepEqual(reviewConflict(response, body), body);
      const versioned = {
        ...body,
        head_graph_version: current_review ? 4 : 0,
        current_review: current_review && {
          ...current_review,
          graph_version: 2,
        },
      };
      assert.deepEqual(reviewConflict(response, versioned), versioned);
      assert.deepEqual(
        reviewConflict(response, {
          ...versioned,
          head_graph_version: -1,
          current_review: current_review && {
            ...current_review,
            graph_version: "bad",
          },
        }),
        body,
      );
      assert.equal(
        reviewConflict(response, { ...body, head_sha256: "invalid" }),
        null,
      );
    }
  }
});

test(
  "Chrome captures lazy images and hit targets in the same settled, clipped layout as the PNG",
  chromeTest,
  async (t) => {
    const cwd = directory(t);
    draw(cwd);
    const root = path.join(cwd, "sketches");
    const html = `<!doctype html><style>
    *{box-sizing:border-box} body{margin:0;background:white}
    #move{height:20px;width:40px;background:red;transform:translateX(168px)}
    .animated{animation:slide 30s backwards}
    @keyframes slide{from{transform:translateX(0)}to{transform:translateX(168px)}}
    .panel{height:40px;overflow:auto;border:5px solid black}
    .partial{height:60px;background:blue}
  </style><div id="move" class="ANIMATION" data-sketch-key="move" aria-label="Move"></div>
  <div class="panel"><div class="partial" data-sketch-key="partial" aria-label="Partial"></div>
  <button data-sketch-key="hidden">Outside panel</button></div>
  <img src="sample.png" loading="lazy" style="display:block;margin-top:5000px" alt="Example"><button data-sketch-key="below">Save</button>`;
    writeFileSync(
      path.join(root, "ballot.html"),
      html
        .replace("ANIMATION", "animated")
        .replace("<style>", "<style>html,body{height:100%;overflow-x:hidden}"),
    );
    writeFileSync(
      path.join(root, "settled.html"),
      html.replace("ANIMATION", ""),
    );
    writeFileSync(
      path.join(root, "sample.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+k8AAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const sources = JSON.parse(
      readFileSync(path.join(root, "board.json"), "utf8"),
    );
    sources.assets.push("sample.png");
    sources.screens.push({
      ...sources.screens[0],
      id: "settled",
      source: "settled.html",
    });
    writeFileSync(path.join(root, "board.json"), JSON.stringify(sources));
    const { screens } = await captureBoard(loadSources(cwd), "{}");
    const [animated, settled] = screens;
    assert(animated && settled);
    for (const [actual, reference] of /** @type {const} */ ([
      [animated.desktop, settled.desktop],
      [animated.mobile, settled.mobile],
    ])) {
      assert(actual.content_height > 5000);
      assert.equal(actual.png_base64, reference.png_base64);
      assert.equal(
        actual.content_height,
        Buffer.from(actual.png_base64, "base64").readUInt32BE(20),
      );
      assert.equal(
        Buffer.from(actual.thumbnail_base64, "base64").readUInt32BE(20),
        Math.ceil(
          (actual.content_height * Math.min(480, actual.width)) / actual.width,
        ),
      );
      assert((actual.elements.find((e) => e.id === "below")?.y ?? 0) > 5000);
      assert.deepEqual(
        actual.elements.slice(0, 2).map((e) => [e.id, e.x, e.y, e.height]),
        [
          ["move", 168, 0, 20],
          ["partial", 5, 25, 30],
        ],
      );
    }
  },
);

test(
  "Chrome reports assets that CSP blocks before routing",
  chromeTest,
  async (t) => {
    const cwd = directory(t);
    draw(cwd);
    const page = path.join(cwd, "sketches", "ballot.html");
    for (const head of [
      '<link rel="stylesheet" href="https://unavailable.invalid/stylesheet.css">',
      '<script src="https://unavailable.invalid/framework.js"></script>',
      '<script src="app.js"></script>',
      '<img src="unlisted.png">',
      '<img src="https://unavailable.invalid/asset.png">',
      "<style>body{background-image:url(https://unavailable.invalid/image.png)}</style>",
      "<style>@font-face{font-family:External;src:url(https://unavailable.invalid/font.woff2)}body{font-family:External}</style>",
    ]) {
      writeFileSync(
        page,
        `<!doctype html>${head}<button data-sketch-key="submit">Submit</button>`,
      );
      await assert.rejects(
        captureBoard(loadSources(cwd), "{}"),
        /undeclared or external asset/,
      );
    }
  },
);

test(
  "Chrome attributes malformed paths and invalid visible images to the failing screen and device",
  chromeTest,
  async (t) => {
    const cwd = directory(t);
    draw(cwd);
    const root = path.join(cwd, "sketches");
    const html = path.join(root, "ballot.html");
    writeFileSync(html, '<!doctype html><img src="chart-50%.png">');
    await assert.rejects(
      captureBoard(loadSources(cwd), "{}"),
      /ballot \(1280 × 800\): .*invalid percent encoding/,
    );
    const board = JSON.parse(
      readFileSync(path.join(root, "board.json"), "utf8"),
    );
    board.assets.push("invalid.png");
    writeFileSync(path.join(root, "board.json"), JSON.stringify(board));
    writeFileSync(path.join(root, "invalid.png"), "not an image");
    writeFileSync(
      html,
      '<!doctype html><meta name="viewport" content="width=device-width"><style>@media(min-width:500px){img{display:none}}</style><img src="invalid.png">',
    );
    await assert.rejects(
      captureBoard(loadSources(cwd), "{}"),
      /ballot \(390 × 844\): Chrome could not decode a visible image/,
    );
  },
);
