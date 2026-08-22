import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const npmCli = requiredEnvironmentVariable("npm_execpath");
const apiToken = `fd_${"a".repeat(43)}`;

/** @type {{name: string, version: string}} */
const packageMetadata = JSON.parse(readFileSync("package.json", "utf8"));
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "firstdraft-cli-"));
const installationDirectory = path.join(temporaryDirectory, "installation");
const packedExecutable = path.join(
  installationDirectory,
  "node_modules",
  ...packageMetadata.name.split("/"),
  "bin",
  "firstdraft.js",
);

try {
  const packResult = runNpm([
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    temporaryDirectory,
  ]);
  /** @type {{filename: string}[]} */
  const packedManifests = JSON.parse(packResult.stdout);
  const [packed] = packedManifests;
  assert(packed, "npm pack did not return a manifest");
  const tarball = path.join(temporaryDirectory, packed.filename);

  mkdirSync(installationDirectory);
  writeFileSync(
    path.join(installationDirectory, "package.json"),
    '{"name":"firstdraft-smoke","private":true}\n',
  );

  runNpm(
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--offline",
      "--no-save",
      tarball,
    ],
    installationDirectory,
  );
  const execution = runNpm(
    ["exec", "--offline", "--", "firstdraft", "--version"],
    installationDirectory,
  );

  assert.equal(execution.stdout, `${packageMetadata.version}\n`);
  assert.equal(execution.stderr, "");

  const generatedUuids = runNpm(
    [
      "exec",
      "--offline",
      "--",
      "firstdraft",
      "generate",
      "uuid",
      "--count",
      "2",
    ],
    installationDirectory,
  );

  assert.match(
    generatedUuids.stdout,
    /^(?:[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\n){2}$/,
  );
  assert.equal(generatedUuids.stderr, "");

  const applicationKey = spawnPackedCli(
    ["generate", "application-key", "--name", "Café Planner"],
    installationDirectory,
  );

  assert.equal(applicationKey.stdout, "cafe_planner\n");
  assert.equal(applicationKey.stderr, "");

  const invalidGeneratedUuid = spawnPackedCli(
    ["generate", "uuid", "--count", "0"],
    installationDirectory,
  );
  assertHandledFailure(invalidGeneratedUuid, 2, {
    error: "invalid_arguments",
    detail:
      "Invalid arguments. Run 'firstdraft generate uuid --help' for usage.",
  });

  const invalidInit = spawnPackedCli(
    ["plan", "init", "--canary-secret-option"],
    installationDirectory,
  );
  assertHandledFailure(invalidInit, 2, {
    error: "invalid_arguments",
    detail: "Invalid arguments. Run 'firstdraft plan init --help' for usage.",
  });

  const projectDirectory = path.join(temporaryDirectory, "project");
  mkdirSync(projectDirectory);
  const initialized = spawnPackedCli(
    ["plan", "init", "--name", "Oscar Party"],
    projectDirectory,
  );
  assert.deepEqual(
    {
      status: initialized.status,
      stdout: initialized.stdout,
      stderr: initialized.stderr,
    },
    {
      status: 0,
      stdout: "Initialized .firstdraft/foundation-plan.json.\n",
      stderr: "",
    },
  );
  const initializedPlan = JSON.parse(
    readFileSync(
      path.join(projectDirectory, ".firstdraft", "foundation-plan.json"),
      "utf8",
    ),
  );
  assert.deepEqual(
    {
      key: initializedPlan.application.key,
      name: initializedPlan.application.name,
    },
    { key: "oscar_party", name: "Oscar Party" },
  );

  const keyOnlyProjectDirectory = path.join(
    temporaryDirectory,
    "key-only-project",
  );
  mkdirSync(keyOnlyProjectDirectory);
  const keyOnlyInitialization = spawnPackedCli(
    ["plan", "init", "--application-key", "movie___catalog___"],
    keyOnlyProjectDirectory,
  );
  assert.equal(keyOnlyInitialization.status, 0);
  assert.equal(keyOnlyInitialization.stderr, "");
  const keyOnlyPlan = JSON.parse(
    readFileSync(
      path.join(keyOnlyProjectDirectory, ".firstdraft", "foundation-plan.json"),
      "utf8",
    ),
  );
  assert.equal(keyOnlyPlan.application.key, "movie___catalog___");
  assert.equal(keyOnlyPlan.application.name, "Movie Catalog");

  const repeatedInit = spawnPackedCli(
    [
      "plan",
      "init",
      "--application-key",
      "other_application",
      "--name",
      "canary-secret-name",
    ],
    projectDirectory,
  );
  assertHandledFailure(repeatedInit, 1, {
    error: "local_initialization_failed",
    detail:
      "Could not initialize .firstdraft. The directory may be incomplete; no existing files were overwritten.",
  });

  const invalidPush = spawnPackedCli(
    ["plan", "push", "--canary-secret-option"],
    installationDirectory,
  );
  assertHandledFailure(invalidPush, 2, {
    error: "invalid_arguments",
    detail: "Invalid arguments. Run 'firstdraft plan push --help' for usage.",
  });

  const localPush = spawnPackedCli(["plan", "push"], installationDirectory);
  assertHandledFailure(localPush, 1, {
    error: "local_input_unreadable",
    detail:
      "Could not read the local First Draft Plan or state. No network request was made. Preserve the local files for manual recovery.",
  });

  const invalidStatus = spawnPackedCli(
    ["plan", "status", "--canary-secret-option"],
    installationDirectory,
  );
  assertHandledFailure(invalidStatus, 2, {
    error: "invalid_arguments",
    detail: "Invalid arguments. Run 'firstdraft plan status --help' for usage.",
  });

  const localStatus = spawnPackedCli(["plan", "status"], installationDirectory);
  assertHandledFailure(localStatus, 1, {
    error: "local_input_unreadable",
    detail:
      "Could not read valid local First Draft state. No network request was made. Run 'firstdraft plan init' if this directory is not initialized; otherwise repair the private state before retrying.",
  });

  const invalidCompile = spawnPackedCli(
    ["plan", "compile", "--canary-secret-option"],
    installationDirectory,
  );
  assertHandledFailure(invalidCompile, 2, {
    error: "invalid_arguments",
    detail:
      "Invalid arguments. Run 'firstdraft plan compile --help' for usage.",
  });

  const removedPublish = spawnPackedCli(
    ["plan", "publish"],
    installationDirectory,
  );
  assert.equal(removedPublish.status, 2);
  assert.equal(removedPublish.stdout, "");
  assert.equal(
    removedPublish.stderr,
    "Unknown command.\nRun 'firstdraft plan --help' for usage.\n",
  );

  const invalidCompilation = spawnPackedCli(
    ["compilation", "status", "not-a-uuid"],
    installationDirectory,
  );
  assertHandledFailure(invalidCompilation, 2, {
    error: "invalid_arguments",
    detail:
      "Invalid arguments. Run 'firstdraft compilation status --help' for usage.",
  });

  await exercisePackedCompilation(projectDirectory);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

/**
 * @param {string[]} arguments_
 * @param {string} [cwd]
 */
function runNpm(arguments_, cwd = process.cwd()) {
  const result = spawnNpm(arguments_, cwd);

  assert.equal(
    result.status,
    0,
    `npm ${arguments_.join(" ")} failed\n${result.stdout}${result.stderr}`,
  );

  return result;
}

/**
 * @param {string[]} arguments_
 * @param {string} [cwd]
 */
function spawnNpm(arguments_, cwd = process.cwd()) {
  return spawnSync(process.execPath, [npmCli, ...arguments_], {
    cwd,
    encoding: "utf8",
  });
}

/**
 * @param {string[]} arguments_
 * @param {string} [cwd]
 */
function spawnPackedCli(arguments_, cwd = process.cwd()) {
  return spawnSync(process.execPath, [packedExecutable, ...arguments_], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, FIRSTDRAFT_API_TOKEN: apiToken },
  });
}

/**
 * @param {string[]} arguments_
 * @param {string} cwd
 */
async function spawnPackedCliAsync(arguments_, cwd) {
  const child = spawn(process.execPath, [packedExecutable, ...arguments_], {
    cwd,
    env: { ...process.env, FIRSTDRAFT_API_TOKEN: apiToken },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const [status, signal] = await once(child, "close");
  assert.equal(signal, null);
  return { status, stdout, stderr };
}

/** @param {string} projectDirectory */
async function exercisePackedCompilation(projectDirectory) {
  const projectId = "01900000-0000-7000-8000-000000000901";
  const compilationId = "01900000-0000-7000-8000-000000000902";
  const analysisId = "01900000-0000-7000-8000-000000000903";
  const publicationId = "01900000-0000-7000-8000-000000000904";
  const plan = readFileSync(
    path.join(projectDirectory, ".firstdraft", "foundation-plan.json"),
  );
  const headSha256 = sha256(plan);
  const foundationPlanSha256 = sha256(
    Buffer.from("canonical Foundation Plan snapshot"),
  );
  const statusPath = `/v1/projects/${projectId}/compilations/${compilationId}`;
  const artifactPath = `${statusPath}/artifact`;
  const analyzerRelease = "foundation-plan-rails/application-2026-08";
  const compilerRelease = "foundation-plan-rails/compiler-scalar-2026-08";
  const target = { id: "rails", profile: "rails-sketch/2026-08" };
  const contents = Buffer.from("class Movie < ApplicationRecord\nend\n");
  const file = {
    path: "app/models/movie.rb",
    sha256: sha256(contents),
    mode: 0o644,
    owner: "renderer:model",
    source_subject_uuids: [],
    contents_base64: contents.toString("base64"),
  };
  const metadata = {
    path: file.path,
    sha256: file.sha256,
    mode: file.mode,
    owner: file.owner,
    source_subject_uuids: file.source_subject_uuids,
  };
  const manifestSha256 = sha256(
    Buffer.from(JSON.stringify({ files: [metadata] })),
  );
  const artifact = Buffer.from(
    JSON.stringify({
      format: "firstdraft.compilation-artifact/1",
      provenance: {
        compilation_id: compilationId,
        project_id: projectId,
        graph_version: 1,
        head_source_sha256: headSha256,
        foundation_plan: {
          format: "firstdraft.foundation-plan.sketch/0.19",
          sha256: foundationPlanSha256,
        },
        analysis: {
          id: analysisId,
          release: "foundation-plan-rails/scalar-2026-08",
        },
        compiler_release: compilerRelease,
        target,
        core: {
          repository: "firstdraft/foundation-rails-core",
          revision: "3".repeat(40),
          sha256: "4".repeat(64),
        },
      },
      manifest_sha256: manifestSha256,
      files: [file],
    }),
  );
  const artifactSha256 = sha256(artifact);
  const compilation = {
    project: { id: projectId, graph_version: 1 },
    compilation: {
      id: compilationId,
      analysis_run_id: analysisId,
      graph_version: 1,
      head_source_sha256: headSha256,
      status: "succeeded",
      compiler_release: compilerRelease,
      target,
      status_path: statusPath,
      cancel_path: `${statusPath}/cancel`,
      artifact: {
        path: artifactPath,
        sha256: artifactSha256,
        media_type: "application/vnd.firstdraft.compilation-artifact+json",
        byte_size: artifact.byteLength,
      },
      failure: null,
      created_at: "2026-07-30T12:00:00.000000Z",
      started_at: "2026-07-30T12:00:01.000000Z",
      completed_at: "2026-07-30T12:00:02.000000Z",
    },
  };
  const gapSet = {
    format: "firstdraft.foundation-gaps/2",
    source: { sha256: headSha256 },
    project: { id: projectId, graph_version: 1 },
    analysis: { release: analyzerRelease },
    compiler_release: compilerRelease,
    target,
    gaps: [],
  };
  const analysis = {
    project: { id: projectId, graph_version: 1 },
    analysis: {
      id: analysisId,
      graph_version: 1,
      head_source_sha256: headSha256,
      analyzer_release: analyzerRelease,
      compiler_release: compilerRelease,
      target,
      status: "valid",
      diagnostics: [],
      gap_set: gapSet,
      gap_set_sha256: sha256(
        Buffer.from(`${JSON.stringify(gapSet, null, 2)}\n`),
      ),
      started_at: "2026-07-30T12:00:00.000Z",
      completed_at: "2026-07-30T12:00:01.000Z",
    },
  };
  const publication = {
    project: {
      id: projectId,
      graph_version: 1,
      head_source_sha256: headSha256,
    },
    compilation: {
      id: compilationId,
      analysis_run_id: analysisId,
      graph_version: 1,
      head_source_sha256: headSha256,
      status: "succeeded",
      compiler_release: compilerRelease,
      target,
      artifact: {
        sha256: artifactSha256,
        manifest_sha256: manifestSha256,
        file_count: 1,
      },
    },
    publication: {
      id: publicationId,
      status: "succeeded",
      repository: {
        id: 1_234_567,
        private: true,
        owner: { id: 7_654_321, login: "octocat", type: "User" },
        full_name: "octocat/oscar-party",
        default_branch: "main",
        html_url: "https://github.com/octocat/oscar-party",
        tree_sha: "5".repeat(40),
        commit_sha: "6".repeat(40),
      },
      failure: null,
      progress: {
        phase: "completed",
        retry_at: null,
        retry_count: 0,
        reason_code: null,
      },
      created_at: "2026-07-30T12:00:00.000Z",
      started_at: "2026-07-30T12:00:01.000Z",
      completed_at: "2026-07-30T12:00:02.000Z",
    },
  };
  const seen = {
    plan: false,
    analysis: false,
    publication: false,
    status: false,
    artifact: false,
    post: false,
  };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const requestBody = Buffer.concat(chunks);
    assert.equal(request.headers.authorization, `Bearer ${apiToken}`);
    if (request.method === "POST") seen.post = true;

    if (
      request.method === "PUT" &&
      request.url === `/v1/projects/${projectId}/foundation-plan`
    ) {
      assert.deepEqual(requestBody, plan);
      assert.equal(request.headers["if-match"], `"sha256:${headSha256}"`);
      seen.plan = true;
      respondJson(
        response,
        200,
        {
          project: { id: projectId, graph_version: 1 },
          foundation_plan: {
            format: "firstdraft.foundation-plan.sketch/0.19",
            source_sha256: headSha256,
          },
          diagnostics: [],
        },
        { ETag: `"sha256:${headSha256}"` },
      );
      return;
    }
    if (
      request.method === "GET" &&
      request.url === `/v1/projects/${projectId}/analysis`
    ) {
      seen.analysis = true;
      respondJson(response, 200, analysis);
      return;
    }
    if (
      request.method === "PUT" &&
      request.url === `/v1/projects/${projectId}/github-publication`
    ) {
      assert.equal(request.headers["if-match"], `"sha256:${headSha256}"`);
      assert.equal(requestBody.byteLength, 0);
      seen.publication = true;
      respondJson(response, 201, publication);
      return;
    }
    if (request.method === "GET" && request.url === statusPath) {
      seen.status = true;
      respondJson(response, 200, compilation);
      return;
    }
    if (request.method === "GET" && request.url === artifactPath) {
      seen.artifact = true;
      response.writeHead(200, {
        "Content-Type": "application/vnd.firstdraft.compilation-artifact+json",
        "Content-Length": artifact.byteLength,
        "Cache-Control": "no-store, no-transform",
        ETag: `"sha256:${artifactSha256}"`,
      });
      response.end(artifact);
      return;
    }

    response.writeHead(404).end();
  });

  try {
    await new Promise((/** @type {(value?: void) => void} */ resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert(address && typeof address === "object");
    const apiUrl = `http://127.0.0.1:${address.port}`;
    writeFileSync(
      path.join(projectDirectory, ".firstdraft", "state.json"),
      `${JSON.stringify(
        {
          format: "firstdraft.cli-state/1",
          project_id: projectId,
          api_url: apiUrl,
          foundation_plan_etag: `"sha256:${headSha256}"`,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );

    const compiled = await spawnPackedCliAsync(
      ["plan", "compile"],
      projectDirectory,
    );
    assert.deepEqual(compiled, {
      status: 0,
      stdout: `${publication.publication.repository.html_url}\n`,
      stderr: `First Draft: Analyzing Foundation Plan...
First Draft: Foundation Plan analysis valid.
First Draft: Compiling application...
First Draft: Application compiled.
First Draft: GitHub publication complete.
`,
    });

    const status = await spawnPackedCliAsync(
      ["compilation", "status", compilationId],
      projectDirectory,
    );
    assert.deepEqual(status, {
      status: 0,
      stdout: `${JSON.stringify(compilation, null, 2)}\n`,
      stderr: "",
    });

    const output = path.join(projectDirectory, "generated");
    const downloaded = await spawnPackedCliAsync(
      ["compilation", "download", compilationId, "--output", output],
      projectDirectory,
    );
    assert.equal(downloaded.status, 0);
    assert.equal(downloaded.stderr, "");
    assert.equal(JSON.parse(downloaded.stdout).output.path, output);
    assert.equal(
      readFileSync(path.join(output, "app/models/movie.rb"), "utf8"),
      contents.toString("utf8"),
    );
    if (process.platform !== "win32") {
      assert.equal(
        lstatSync(path.join(output, "app/models/movie.rb")).mode & 0o777,
        0o644,
      );
    }
    assert.deepEqual(seen, {
      plan: true,
      analysis: true,
      publication: true,
      status: true,
      artifact: true,
      post: false,
    });
  } finally {
    await new Promise(
      (
        /** @type {(value?: void) => void} */ resolve,
        /** @type {(error: Error) => void} */ reject,
      ) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      },
    );
  }
}

/** @param {import("node:http").ServerResponse} response @param {number} status @param {unknown} body @param {Record<string, string>} [headers] */
function respondJson(response, status, body, headers = {}) {
  const source = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": source.byteLength,
    ...headers,
  });
  response.end(source);
}

/** @param {Buffer} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * @param {ReturnType<typeof spawnPackedCli>} execution
 * @param {number} status
 * @param {Record<string, unknown>} error
 */
function assertHandledFailure(execution, status, error) {
  assert.equal(execution.status, status);
  assert.equal(execution.stdout, "");
  assert.equal(execution.stderr, `${JSON.stringify(error, null, 2)}\n`);
  assert.doesNotMatch(execution.stderr, /canary-secret/);
}

/** @param {string} name */
function requiredEnvironmentVariable(name) {
  const value = process.env[name];
  assert(value, `${name} is required; run this check through npm`);
  return value;
}
