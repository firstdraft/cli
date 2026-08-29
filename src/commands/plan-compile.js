import { publishPlan } from "./plan-publish.js";
import { compileAndDownload } from "./compilation.js";
import {
  prepareCompilationOutputTarget,
  releaseCompilationOutputTarget,
} from "../compilation-artifact.js";
import {
  PlanPushNetworkError,
  PlanPushProtocolError,
  pushPlan,
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
 * @property {string} [apiUrl]
 * @property {typeof globalThis.fetch} [fetchFunction]
 * @property {import("./plan-push.js").PlanPushFileSystem} [fileSystem]
 * @property {() => string} [createTemporaryId]
 * @property {(timeoutMs?: number) => AbortSignal} [createRequestSignal]
 * @property {(delayMs: number) => Promise<void>} [analysisSleep]
 * @property {() => number} [analysisNow]
 * @property {(delayMs: number) => Promise<void>} [publicationSleep]
 * @property {() => number} [publicationNow]
 * @property {(progress: import("../plan-compile-progress.js").PlanCompileProgress) => void} [onProgress]
 * @property {typeof pushPlan} [push]
 * @property {typeof readPlanStatus} [readStatus]
 * @property {typeof publishPlan} [publish]
 */

/**
 * Submit and analyze the exact current local Plan before invoking the internal
 * GitHub Publication lifecycle. The Publication function performs the final
 * local-byte check immediately before its conditional mutation.
 *
 * @param {CompilePlanOptions} options
 */
export async function compilePlan({
  cwd,
  apiUrl,
  fetchFunction,
  fileSystem,
  createTemporaryId,
  createRequestSignal,
  analysisSleep,
  analysisNow,
  publicationSleep,
  publicationNow,
  onProgress = () => {},
  push = pushPlan,
  readStatus = readPlanStatus,
  publish = publishPlan,
}) {
  const prepared = await preparePlan({
    cwd,
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

  return publish({
    cwd,
    fetchFunction,
    fileSystem,
    createRequestSignal,
    sleep: publicationSleep,
    now: publicationNow,
    expectedEtag: prepared.pushed.etag,
    onProgress,
  });
}

/**
 * @typedef {CompilePlanOptions & {
 *   output: string,
 *   compilationSleep?: (delayMs: number) => Promise<void>,
 *   compilationNow?: () => number,
 *   compile?: typeof compileAndDownload
 * }} CompilePlanToDirectoryOptions
 */

/**
 * Submit and analyze the exact current local Plan, then start one direct
 * Compilation and materialize its verified artifact into an absent directory
 * or the eligible current directory. GitHub Publication remains the no-output
 * mode owned by compilePlan.
 *
 * @param {CompilePlanToDirectoryOptions} options
 */
export async function compilePlanToDirectory({
  cwd,
  output,
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
  const outputTarget = prepareCompilationOutputTarget({ cwd, output });
  try {
    const prepared = await preparePlan({
      cwd,
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
      expectedEtag: prepared.pushed.etag,
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
 * @param {Omit<CompilePlanOptions, "publicationSleep" | "publicationNow" | "publish">} options
 */
async function preparePlan({
  cwd,
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
  const acceptedGraphVersion = /** @type {{graph_version: number}} */ (
    pushed.body.project
  ).graph_version;
  const acceptedHeadSourceSha256 = /** @type {{source_sha256: string}} */ (
    pushed.body.foundation_plan
  ).source_sha256;

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
    status.body.project.graph_version !== acceptedGraphVersion ||
    status.body.analysis.graph_version !== acceptedGraphVersion ||
    status.body.analysis.head_source_sha256 !== acceptedHeadSourceSha256
  ) {
    throw new PlanStatusChangedError(status.body);
  }
  if (status.body.analysis.status !== "valid") {
    throw new PlanCompileAnalysisNotValidError(status.body);
  }
  onProgress({ phase: "analysis", status: "valid" });

  return { pushed, status };
}
