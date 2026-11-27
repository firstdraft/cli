import { ApiAuthenticationRequiredError } from "../api-authentication.js";
import { isUtf8 } from "node:buffer";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  mkdtempSync,
  rmSync,
  linkSync,
} from "node:fs";
import { isFileSystemError } from "../file-system.js";
import path from "node:path";
import {
  SERVICE_ROUTES,
  serviceEndpoint,
  sendRequest,
  readResponseBody,
  isProblemBody,
  reviewConflict,
  problemProjection,
  responseMediaType,
  isDiagnostic,
} from "../api-response.js";
import { generateUuidV7 } from "../uuid-v7.js";
import {
  withPlanStateLock,
  PlanStateLocalError,
  readPlanState,
  isUuidV7,
  readLocalFile,
} from "../plan-state.js";
import { resolveApiUrl } from "./plan-push.js";
import {
  digest,
  captureBoard,
  loadSources,
  SketchError,
} from "../sketch-capture.js";
export { SketchError };
const privateWrite = { flag: "wx", mode: 0o600, flush: true };
/** @param {string} file @param {unknown} data @param {boolean} [exclusive] */
function save(file, data, exclusive = false) {
  const temp = file + "." + generateUuidV7() + ".tmp";
  writeFileSync(temp, JSON.stringify(data) + "\n", privateWrite);
  try {
    if (exclusive) linkSync(temp, file);
    else renameSync(temp, file);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}
/** @typedef {{cwd:string,apiUrl?:string,fetchFunction:typeof globalThis.fetch,hasTokenFor?:(origin:string)=>boolean}} Options */
/** @param {Options} options */
export async function startProject({
  cwd,
  apiUrl,
  fetchFunction,
  hasTokenFor,
}) {
  const dir = path.join(cwd, ".firstdraft");
  const existing = existsSync(dir) ? readPlanState({ cwd }) : null;
  const origin = resolveApiUrl(apiUrl, existing?.api_url);
  if (hasTokenFor && !hasTokenFor(origin))
    throw new ApiAuthenticationRequiredError();
  if (!existing) {
    const temp = mkdtempSync(path.join(cwd, ".firstdraft-start-"));
    try {
      writeFileSync(path.join(temp, ".gitignore"), "*\n", privateWrite);
      save(path.join(temp, "state.json"), {
        format: "firstdraft.cli-state/1",
        project_id: generateUuidV7(),
        reserved: true,
        api_url: origin,
      });
      renameSync(temp, dir);
    } finally {
      rmSync(temp, { force: true, recursive: true });
    }
  }
  const state = existing ?? readPlanState({ cwd });
  if (!state.reserved)
    throw new SketchError(
      "This planning directory already has a Plan. Resume its existing workflow.",
    );
  const response = await sendRequest(
    fetchFunction,
    serviceEndpoint(SERVICE_ROUTES.startProject, origin, {
      project_id: state.project_id,
    }),
    {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    },
  );
  const body = await readResponseBody(response);
  if (![200, 201].includes(response.status))
    throw new SketchError(
      "First Draft could not open the Project. Check the hosted Sketches endpoint and retry in this directory.",
      response.status,
      problem(response, body),
    );
  const url = new URL("/projects/" + state.project_id, origin).href;
  if (
    responseMediaType(response) !== "application/json" ||
    body?.project?.id !== state.project_id ||
    ![url, "/projects/" + state.project_id].includes(body.project.url)
  )
    throw new SketchError("Unexpected Project identity in the response.");
  return { project: { id: state.project_id, url } };
}

/** @param {string} cwd @param {string} [revision] */
function readReview(cwd, revision) {
  const file = revision
    ? path.join(cwd, ".firstdraft", "sketch-reviews", revision + ".json")
    : path.join(cwd, ".firstdraft", "sketch-review.json");
  if (!existsSync(file)) return null;
  /** @type {{id:string,plan_sha256:string,files:Record<string,string>}} */
  const receipt = JSON.parse(readLocalFile(file, 1024 * 1024).toString());
  if (
    !receipt ||
    !isUuidV7(receipt.id) ||
    !receipt.files ||
    !/^[a-f0-9]{64}$/.test(receipt.plan_sha256)
  )
    throw new SketchError("Invalid local sketch review receipt.");
  return receipt;
}
/** @typedef {Options & {capture?:typeof captureBoard, after?:string, head?:string}} PublishOptions */
/** @param {PublishOptions} options */
export async function publishSketches(options) {
  return withPlanStateLock(path.join(options.cwd, ".firstdraft"), () =>
    publishCurrentSketches(options),
  );
}

/** @param {PublishOptions} options */
async function publishCurrentSketches({
  cwd,
  apiUrl,
  fetchFunction,
  hasTokenFor,
  capture = captureBoard,
  after,
  head,
}) {
  const dir = path.join(cwd, ".firstdraft");
  const state = readPlanState({ cwd });
  if (!state.reserved)
    throw new SketchError(
      "Use firstdraft project start in the hosted interview directory.",
    );
  const origin = resolveApiUrl(apiUrl, state.api_url);
  if (hasTokenFor && !hasTokenFor(origin))
    throw new ApiAuthenticationRequiredError();
  const pendingFile = path.join(dir, "sketch-pending.json");
  const replay = existsSync(pendingFile);
  if (!replay) {
    const previous = after === "none" ? null : (after ?? readReview(cwd)?.id);
    const planBytes = readLocalFile(
      path.join(dir, "foundation-plan.json"),
      1024 * 1024,
    );
    if (!isUtf8(planBytes))
      throw new SketchError("The Foundation Plan must contain valid UTF-8.");
    const plan_source = planBytes.toString("utf8");
    const sources = loadSources(cwd);
    const manifest = await capture(sources, plan_source);
    const body = JSON.stringify({
      previous_revision_id: previous ?? null,
      expected_plan_sha256:
        head === "none"
          ? null
          : (head ?? state.foundation_plan_etag?.slice(8, -1) ?? null),
      plan_source,
      manifest,
    });
    if (Buffer.byteLength(body) > 24 * 1024 * 1024)
      throw new SketchError("The review bundle exceeds 24 MiB.");
    save(
      pendingFile,
      {
        id: generateUuidV7(),
        local_etag: state.foundation_plan_etag,
        body,
        files: Object.fromEntries(
          [...sources.files].map(([name, bytes]) => [name, digest(bytes)]),
        ),
      },
      true,
    );
  }
  const pending = JSON.parse(
    readLocalFile(pendingFile, 52 * 1024 * 1024).toString(),
  );
  if (!isUuidV7(pending.id))
    throw new SketchError("The pending review ID is invalid.");
  const request = JSON.parse(pending.body);
  if (
    after &&
    (request.previous_revision_id !== (after === "none" ? null : after) ||
      request.expected_plan_sha256 !== (head === "none" ? null : head))
  )
    throw new SketchError(
      "The pending publication has different preconditions. Run sketches publish without options to replay it.",
    );
  const response = await sendRequest(
    fetchFunction,
    serviceEndpoint(SERVICE_ROUTES.publishSketches, origin, {
      project_id: state.project_id,
      revision_id: pending.id,
    }),
    {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/vnd.firstdraft.sketch-review+json",
      },
      body: pending.body,
      redirect: "error",
      signal: AbortSignal.timeout(120000),
    },
  );
  const body = await readResponseBody(response);
  if (![200, 201].includes(response.status)) {
    const rejection = problem(response, body);
    const refusedThisRequest =
      response.status >= 400 &&
      response.status < 500 &&
      response.status !== 408;
    // A refused retry resolves the original ambiguity only after the Service
    // has looked up its revision ID. Authorization and quotas on the endpoint
    // itself run before that lookup.
    const resolvedRevision =
      rejection &&
      (("code" in rejection &&
        ((rejection.code === "invalid_sketch_review" &&
          response.status === 422) ||
          (rejection.code === "sketch_review_conflict" &&
            response.status === 409) ||
          (rejection.code === "compilation_active" &&
            response.status === 409) ||
          (rejection.code === "invalid_sketch_review" &&
            response.status === 422) ||
          (rejection.code === "sketch_quota_reached" &&
            response.status === 413))) ||
        ("diagnostics" in rejection && response.status === 422));
    if (refusedThisRequest && (!replay || resolvedRevision))
      unlinkSync(pendingFile);
    throw new SketchError(
      "First Draft declined the sketch review. Inspect the current review and repair the draft.",
      response.status,
      rejection,
    );
  }
  const sha = request.manifest.plan_sha256;
  const etag = response.headers.get("etag");
  if (
    responseMediaType(response) !== "application/json" ||
    etag !== '"sha256:' + sha + '"' ||
    body?.project?.id !== state.project_id ||
    body?.review?.id !== pending.id ||
    body?.review?.plan_sha256 !== sha ||
    body?.foundation_plan?.source_sha256 !== sha
  )
    throw new SketchError(
      "Unexpected review identity. Retry the same publication.",
    );
  const latest = readPlanState({ cwd });
  const knownHead = latest.foundation_plan_etag?.slice(8, -1) ?? null;
  if (
    knownHead === request.expected_plan_sha256 ||
    latest.foundation_plan_etag === pending.local_etag
  ) {
    save(path.join(dir, "state.json"), {
      ...latest,
      foundation_plan_etag: etag,
    });
  }
  const receipt = { id: pending.id, plan_sha256: sha, files: pending.files };
  const archive = path.join(dir, "sketch-reviews");
  mkdirSync(archive, { recursive: true, mode: 0o700 });
  const previous = readReview(cwd);
  if (previous) {
    const oldFile = path.join(archive, previous.id + ".json");
    if (!existsSync(oldFile)) save(oldFile, previous);
  }
  save(path.join(archive, pending.id + ".json"), receipt);
  save(path.join(dir, "sketch-review.json"), receipt);
  unlinkSync(pendingFile);
  let nextStep;
  if (replay) {
    try {
      reviewedSources(cwd, pending.id);
    } catch (error) {
      if (!(
        error instanceof SketchError || error instanceof PlanStateLocalError
      ))
        throw error;
      nextStep =
        "Recovered the saved publication. The current planning files do not match this review. Run firstdraft sketches publish again to capture and publish the current draft.";
    }
  }
  return {
    project: {
      id: state.project_id,
      url: new URL("/projects/" + state.project_id, origin).href,
    },
    review: { id: pending.id, plan_sha256: sha },
    ...(nextStep ? { next_step: nextStep } : {}),
    foundation_plan: { source_sha256: sha },
  };
}

/** @param {string} cwd @param {string|undefined} revision @param {boolean} [retained] */
export function reviewedSources(cwd, revision, retained = false) {
  try {
    return loadReviewedSources(cwd, revision, retained);
  } catch (error) {
    if (!isFileSystemError(error) && !(error instanceof SyntaxError))
      throw error;
    throw new SketchError(
      "Restore the approved board, source files and local review receipt before Compile.",
    );
  }
}

/** @param {string} cwd @param {string|undefined} revision @param {boolean} [retained] */
function loadReviewedSources(cwd, revision, retained) {
  const receipt =
    (retained && isUuidV7(revision) ? readReview(cwd, revision) : null) ??
    readReview(cwd);
  if (!receipt && !revision) return;
  if (!receipt || receipt.id !== revision)
    throw new SketchError(
      retained
        ? "Restore the local receipt for this Compilation’s sketch revision in the planning folder before downloading."
        : "Compile with --revision followed by the approved sketch revision ID.",
    );
  const sources = loadSources(cwd);
  if (
    digest(
      readFileSync(path.join(cwd, ".firstdraft", "foundation-plan.json")),
    ) !== receipt.plan_sha256 ||
    sources.files.size !== Object.keys(receipt.files).length ||
    [...sources.files].some(
      ([name, bytes]) => digest(bytes) !== receipt.files[name],
    )
  )
    throw new SketchError(
      "The Plan or sketch sources changed since review. Publish and review the changes before Compile.",
    );
  return { files: sources.files, planSha256: receipt.plan_sha256 };
}

/** @param {Response} response @param {Record<string,any>|null} body */
function problem(response, body) {
  if (!body) return;
  const conflict = reviewConflict(response, body);
  if (conflict) return conflict;
  if (isProblemBody(response, body)) return problemProjection(body);
  if (
    response.status === 422 &&
    Array.isArray(body.diagnostics) &&
    body.diagnostics.every(isDiagnostic)
  )
    return {
      diagnostics: body.diagnostics.map(({ code, message, severity }) => ({
        code,
        message,
        severity,
      })),
    };
  return undefined;
}
