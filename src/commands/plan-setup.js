import {
  FirstDraftProtocolError,
  SERVICE_ROUTES,
  isProblemBody,
  problemProjection,
  readResponseBody,
  responseMediaType,
  sendRequest,
  serviceEndpoint,
} from "../api-response.js";
import { isUuidV7 } from "../plan-state.js";

const STEP_TEXT_FIELDS = [
  "provider",
  "title",
  "purpose",
  "needed",
  "timing",
  "destination",
  "action",
];
const STEP_FIELDS = new Set([
  "source",
  ...STEP_TEXT_FIELDS,
  "environment_variable",
]);

export class PlanSetupUnavailableError extends Error {
  /**
   * @param {number} status
   * @param {Record<string, unknown> | null} problem
   */
  constructor(status, problem) {
    super("First Draft could not return this Project's setup steps.");
    this.status = status;
    this.problem = problem;
  }
}

/**
 * @param {{apiUrl: string, projectId: string, revision?: string,
 *   context: "general" | "workshop", fetchFunction: typeof globalThis.fetch,
 *   createRequestSignal?: (timeoutMs: number) => AbortSignal}} options
 */
export async function readPlanSetup({
  apiUrl,
  projectId,
  revision,
  context,
  fetchFunction,
  createRequestSignal = (timeoutMs) => AbortSignal.timeout(timeoutMs),
}) {
  const endpoint = serviceEndpoint(SERVICE_ROUTES.readPlanSetup, apiUrl, {
    project_id: projectId,
  });
  if (revision) endpoint.url.searchParams.set("review", revision);
  if (context === "workshop") endpoint.url.searchParams.set("context", context);

  const response = await sendRequest(fetchFunction, endpoint, {
    headers: { Accept: "application/json, application/problem+json" },
    redirect: "error",
    signal: createRequestSignal(30_000),
  });
  const body = await readResponseBody(response);
  if (!response.ok) {
    throw new PlanSetupUnavailableError(
      response.status,
      isProblemBody(response, body) ? problemProjection(body) : null,
    );
  }
  if (
    response.status !== 200 ||
    responseMediaType(response) !== "application/json" ||
    body?.context !== context ||
    !(body.analysis === "valid" || body.analysis === "preliminary") ||
    !body.review ||
    !(body.review.id === null || isUuidV7(body.review.id)) ||
    (revision && body.review.id !== revision) ||
    typeof body.review.plan_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(body.review.plan_sha256) ||
    !Array.isArray(body.steps) ||
    !body.steps.every(isSetupStep)
  ) {
    throw new FirstDraftProtocolError(
      "First Draft returned an invalid setup list for this review.",
      { status: response.status },
    );
  }
  return {
    review: { id: body.review.id, plan_sha256: body.review.plan_sha256 },
    context,
    analysis: body.analysis,
    steps: body.steps,
  };
}

/** @param {Record<string, unknown> | null} step */
function isSetupStep(step) {
  return (
    step !== null &&
    typeof step === "object" &&
    (step.source === "plan" || step.source === "interview") &&
    Object.keys(step).every((key) => STEP_FIELDS.has(key)) &&
    STEP_TEXT_FIELDS.every((key) => typeof step[key] === "string") &&
    (step.environment_variable === undefined ||
      (typeof step.environment_variable === "string" &&
        /^[A-Z][A-Z0-9_]*$/.test(step.environment_variable)))
  );
}
