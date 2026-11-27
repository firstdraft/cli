import { readPlanState } from "../plan-state.js";
import { reviewedSources } from "./sketches.js";
import { compileAndDownload } from "./compilation.js";
import {
  prepareCompilationOutputTarget,
  releaseCompilationOutputTarget,
} from "../compilation-artifact.js";
import {
  PlanPushNetworkError,
  PlanPushProtocolError,
  pushPlan,
  resolveApiUrl,
} from "./plan-push.js";
import { PlanStatusChangedError, readPlanStatus } from "./plan-status.js";

export class PlanCompilePushRejectedError extends Error {
  /**
   * @param {{status: number, responseKind: "diagnostics" | "problem" | null, body: Record<string, unknown> | null}} result
   */
  constructor(result) {
    super("First Draft rejected the current Foundation Plan.");
    this.result = result;
  }
}

export class PlanCompileAnalysisRejectedError extends Error {
  /**
   * @param {{status: number, responseKind: "problem" | null, body: Record<string, unknown> | null}} result
   */
  constructor(result) {
    super("First Draft rejected the analysis status request.");
    this.result = result;
  }
}

export class PlanCompileAnalysisNotValidError extends Error {
  /** @param {import("./plan-status.js").AnalysisResponse} current */
  constructor(current) {
    super("The current Foundation Plan analysis is not valid.");
    this.current = current;
  }
}

export class PlanCompileAnalysisUnavailableError extends Error {
  /** @param {number | undefined} status */
  constructor(status) {
    super("The current analysis status is unavailable.");
    this.status = status;
  }
}

export class PlanCompileAnalysisInvalidError extends Error {
  /** @param {number} status */
  constructor(status) {
    super("The current analysis status response is invalid.");
    this.status = status;
  }
}

/**
 * @typedef {object} CompilePlanOptions
 * @property {string} cwd
 * @property {string} [reviewedDigest]
 * @property {string} [apiUrl]
 * @property {typeof globalThis.fetch} [fetchFunction]
 * @property {import("./plan-push.js").PlanPushFileSystem} [fileSystem]
 * @property {() => string} [createTemporaryId]
 * @property {(timeoutMs?: number) => AbortSignal} [createRequestSignal]
 * @property {(delayMs: number) => Promise<void>} [analysisSleep]
 * @property {() => number} [analysisNow]
 * @property {(progress: import("../plan-compile-progress.js").PlanCompileProgress) => void} [onProgress]
 * @property {typeof pushPlan} [push]
 * @property {typeof readPlanStatus} [readStatus]
 */

/**
 * @typedef {CompilePlanOptions & {
 *   output: string,
 *   revision?: string,
 *   compilationSleep?: (delayMs: number) => Promise<void>,
 *   compilationNow?: () => number,
 *   compile?: typeof compileAndDownload
 * }} CompilePlanToDirectoryOptions
 */

/**
 * Submit and analyze the exact current local Plan, then start one direct
 * Compilation and materialize its verified artifact into an absent directory
 * or the eligible current directory.
 *
 * @param {CompilePlanToDirectoryOptions} options
 */
export async function compilePlanToDirectory({
  cwd,
  output,
  revision,
  apiUrl,
  fetchFunction,
  fileSystem,
  createTemporaryId,
  createRequestSignal,
  analysisSleep,
  analysisNow,
  compilationSleep,
  compilationNow,
  onProgress = () => {},
  push = pushPlan,
  readStatus = readPlanStatus,
  compile = compileAndDownload,
}) {
  const reviewed = reviewedSources(cwd, revision);
  if (reviewed)
    resolveApiUrl(apiUrl, readPlanState({ cwd, fileSystem }).api_url);
  const outputTarget = prepareCompilationOutputTarget({ cwd, output });
  try {
    const prepared = await preparePlan({
      cwd,
      reviewedDigest: reviewed?.planSha256,
      apiUrl,
      fetchFunction,
      fileSystem,
      createTemporaryId,
      createRequestSignal,
      analysisSleep,
      analysisNow,
      onProgress,
      push,
      readStatus,
    });
    const body = prepared.status.body;

    return await compile({
      cwd,
      ...(reviewed ? { revision, sketchFiles: reviewed.files } : {}),
      expectedEtag: prepared.etag,
      expected: {
        projectId: body.project.id,
        graphVersion: body.project.graph_version,
        headSourceSha256: body.analysis.head_source_sha256,
        analysisRunId: body.analysis.id,
        compilerRelease: body.analysis.compiler_release,
        target: body.analysis.target,
      },
      output,
      outputTarget,
      fetchFunction,
      fileSystem,
      createRequestSignal,
      sleep: compilationSleep,
      now: compilationNow,
      onProgress,
    });
  } finally {
    releaseCompilationOutputTarget(outputTarget);
  }
}

/**
 * @param {CompilePlanOptions} options
 */
async function preparePlan({
  cwd,
  reviewedDigest,
  apiUrl,
  fetchFunction,
  fileSystem,
  createTemporaryId,
  createRequestSignal,
  analysisSleep,
  analysisNow,
  onProgress = () => {},
  push = pushPlan,
  readStatus = readPlanStatus,
}) {
  let acceptedGraphVersion;
  let acceptedHeadSourceSha256 = reviewedDigest;
  let etag;
  if (reviewedDigest) {
    etag = '"sha256:' + reviewedDigest + '"';
  } else {
    const pushed = await push({
      cwd,
      apiUrl,
      fetchFunction,
      fileSystem,
      createTemporaryId,
      createRequestSignal,
    });
    if (!("outcome" in pushed)) {
      throw new PlanCompilePushRejectedError(pushed);
    }
    acceptedGraphVersion = /** @type {{graph_version: number}} */ (
      pushed.body.project
    ).graph_version;
    acceptedHeadSourceSha256 = /** @type {{source_sha256: string}} */ (
      pushed.body.foundation_plan
    ).source_sha256;

    etag = pushed.etag;
  }
  let status;
  onProgress({ phase: "analysis", status: "waiting" });
  try {
    status = await readStatus({
      cwd,
      wait: true,
      expectedGraphVersion: acceptedGraphVersion,
      fetchFunction,
      fileSystem,
      createRequestSignal,
      sleep: analysisSleep,
      now: analysisNow,
    });
  } catch (error) {
    if (error instanceof PlanPushNetworkError) {
      throw new PlanCompileAnalysisUnavailableError(error.status);
    }
    if (error instanceof PlanPushProtocolError) {
      throw new PlanCompileAnalysisInvalidError(error.status);
    }
    throw error;
  }
  if ("responseKind" in status) {
    throw new PlanCompileAnalysisRejectedError(status);
  }
  if (
    (acceptedGraphVersion !== undefined &&
      (status.body.project.graph_version !== acceptedGraphVersion ||
        status.body.analysis.graph_version !== acceptedGraphVersion)) ||
    status.body.analysis.head_source_sha256 !== acceptedHeadSourceSha256
  ) {
    throw new PlanStatusChangedError(status.body);
  }
  if (status.body.analysis.status !== "valid") {
    throw new PlanCompileAnalysisNotValidError(status.body);
  }
  onProgress({ phase: "analysis", status: "valid" });

  return { etag, status };
}
