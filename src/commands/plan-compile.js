import { publishPlan } from "./plan-publish.js";
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
  push = pushPlan,
  readStatus = readPlanStatus,
  publish = publishPlan,
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

  let status;
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
    status.body.analysis.graph_version !== acceptedGraphVersion
  ) {
    throw new PlanStatusChangedError(status.body);
  }
  if (status.body.analysis.status !== "valid") {
    throw new PlanCompileAnalysisNotValidError(status.body);
  }

  return publish({
    cwd,
    fetchFunction,
    fileSystem,
    createRequestSignal,
    sleep: publicationSleep,
    now: publicationNow,
    expectedEtag: pushed.etag,
  });
}
