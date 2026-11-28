import { ApiAuthenticationRequiredError } from "./api-authentication.js";
import { isUuidV7, PlanStateConfigurationError } from "./plan-state.js";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class FirstDraftNetworkError extends Error {
  /**
   * @param {string} message
   * @param {{cause?: Error, status?: number}} [options]
   */
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.status = options.status;
  }
}

export class FirstDraftProtocolError extends Error {
  /** @param {string} message @param {{status: number}} options */
  constructor(message, options) {
    super(message);
    this.status = options.status;
  }
}

/**
 * Every Service API route the CLI requests. docs/commands.md#service-endpoints
 * has one row for each, and test/service-endpoints.test.js compares the two.
 */
export const SERVICE_ROUTES = {
  startProject: { method: "PUT", path: "/v1/projects/{project_id}" },
  publishSketches: {
    method: "PUT",
    path: "/v1/projects/{project_id}/sketch-reviews/{revision_id}",
  },
  pushPlan: {
    method: "PUT",
    path: "/v1/projects/{project_id}/foundation-plan",
  },
  readAnalysis: {
    method: "GET",
    path: "/v1/projects/{project_id}/analysis",
  },
  readPlanSetup: {
    method: "GET",
    path: "/v1/projects/{project_id}/setup",
  },
  startCompilation: {
    method: "POST",
    path: "/v1/projects/{project_id}/compilations",
  },
  readCompilation: {
    method: "GET",
    path: "/v1/projects/{project_id}/compilations/{compilation_id}",
  },
  cancelCompilation: {
    method: "POST",
    path: "/v1/projects/{project_id}/compilations/{compilation_id}/cancel",
  },
  downloadArtifact: {
    method: "GET",
    path: "/v1/projects/{project_id}/compilations/{compilation_id}/artifact",
  },
  readAccount: {
    method: "GET",
    path: "/v1/account",
  },
  sendProgressReport: {
    method: "POST",
    path: "/v1/projects/{project_id}/compilations/{compilation_id}/progress-reports",
  },
  sendFailureReport: {
    method: "POST",
    path: "/v1/projects/{project_id}/compilations/{compilation_id}/failure-reports",
  },
  sendNote: {
    method: "POST",
    path: "/v1/projects/{project_id}/notes",
  },
  listMaintenanceItems: {
    method: "GET",
    path: "/v1/projects/{project_id}/environments/{environment_name}/items",
  },
  readMaintenanceItem: {
    method: "GET",
    path: "/v1/projects/{project_id}/environments/{environment_name}/items/{item_id}",
  },
  resolveMaintenanceItem: {
    method: "POST",
    path: "/v1/projects/{project_id}/environments/{environment_name}/items/{item_id}/resolution",
  },
  deferMaintenanceItem: {
    method: "POST",
    path: "/v1/projects/{project_id}/environments/{environment_name}/items/{item_id}/deferral",
  },
  askMaintenanceOwner: {
    method: "POST",
    path: "/v1/projects/{project_id}/environments/{environment_name}/items/{item_id}/owner-question",
  },
  requestOAuthToken: {
    method: "POST",
    path: "/oauth/token",
  },
  requestDeviceAuthorization: {
    method: "POST",
    path: "/oauth/device_authorization",
  },
  revokeOAuthToken: {
    method: "POST",
    path: "/oauth/revoke",
  },
};

/** @typedef {{method: string, url: URL}} ServiceEndpoint */

/**
 * @param {{method: string, path: string}} route
 * @param {string} apiUrl
 * @param {Record<string, string>} parameters
 * @returns {ServiceEndpoint}
 */
export function serviceEndpoint(route, apiUrl, parameters) {
  const endpointPath = route.path.replace(/\{(\w+)\}/g, (_, name) => {
    const value = parameters[name];
    if (value === undefined) {
      throw new Error(`${route.path} needs a ${name} value.`);
    }
    return value;
  });

  return { method: route.method, url: new URL(endpointPath, apiUrl) };
}

/**
 * @param {typeof globalThis.fetch} fetchFunction
 * @param {ServiceEndpoint} endpoint
 * @param {Omit<RequestInit, "method">} request
 */
export async function sendRequest(fetchFunction, endpoint, request) {
  try {
    return await fetchFunction(endpoint.url, {
      ...request,
      method: endpoint.method,
    });
  } catch (error) {
    if (
      error instanceof PlanStateConfigurationError ||
      error instanceof ApiAuthenticationRequiredError
    )
      throw error;
    if (!(error instanceof Error)) throw error;

    throw new FirstDraftNetworkError("The First Draft request failed.", {
      cause: error,
    });
  }
}

/** @param {Response} response @param {number} [maximumBytes] */
export async function readResponseBody(response, maximumBytes) {
  const bytes = await readResponseBytes(response, maximumBytes);

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;

    return null;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;

    return null;
  }
}

/** @param {Response} response */
export function responseMediaType(response) {
  return (
    response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() ?? ""
  );
}

/** @param {Response} response @param {unknown} body */
export function isProblemBody(response, body) {
  return (
    responseMediaType(response) === "application/problem+json" &&
    isRecord(body) &&
    (body.type === undefined || body.type === "about:blank") &&
    typeof body.title === "string" &&
    body.status === response.status &&
    typeof body.code === "string" &&
    typeof body.detail === "string"
  );
}

/** @param {Response} response @param {unknown} body */
export function reviewConflict(response, body) {
  if (
    responseMediaType(response) !== "application/problem+json" ||
    !isRecord(body) ||
    body.status !== response.status ||
    typeof body.detail !== "string"
  )
    return null;
  if (!(
    (body.code === "sketch_review_changed" && body.status === 412) ||
    (body.code === "sketch_review_conflict" && body.status === 409)
  ))
    return null;
  const review = body.current_review;
  const head = body.head_sha256;
  if (
    head !== null &&
    (typeof head !== "string" || !/^[a-f0-9]{64}$/.test(head))
  )
    return null;
  if (
    review !== null &&
    !(
      isRecord(review) &&
      isUuidV7(review.id) &&
      typeof review.plan_sha256 === "string" &&
      /^[a-f0-9]{64}$/.test(review.plan_sha256)
    )
  )
    return null;
  return {
    ...(validGraphVersion(body.head_graph_version)
      ? { head_graph_version: body.head_graph_version }
      : {}),
    code: body.code,
    status: body.status,
    detail: body.detail,
    current_review: review && {
      ...(validGraphVersion(review.graph_version)
        ? { graph_version: review.graph_version }
        : {}),
      id: review.id,
      plan_sha256: review.plan_sha256,
    },
    head_sha256: head,
  };
}

/** @param {unknown} value @returns {value is number} */
function validGraphVersion(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The fields of a problem that isProblemBody accepted, and nothing else.
 *
 * @param {unknown} body
 */
export function problemProjection(body) {
  const problem = /** @type {Record<string, unknown>} */ (body);

  return {
    ...(problem.type === "about:blank" ? { type: problem.type } : {}),
    title: problem.title,
    status: problem.status,
    code: problem.code,
    detail: problem.detail,
  };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown> & {severity: "error" | "warning"}}
 */
export function isDiagnostic(value) {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    (value.severity === "error" || value.severity === "warning") &&
    typeof value.message === "string"
  );
}

/**
 * @param {Response} response
 * @param {number} [maximumBytes]
 */
export async function readResponseBytes(
  response,
  maximumBytes = MAX_RESPONSE_BYTES,
) {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    /^\d+$/.test(declaredLength) &&
    Number(declaredLength) > maximumBytes
  ) {
    if (response.body !== null) {
      await response.body.cancel().catch(() => undefined);
    }
    throw new FirstDraftProtocolError(
      "The First Draft response is too large.",
      { status: response.status },
    );
  }

  if (response.body === null) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks = [];
  let byteLength = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      byteLength += value.byteLength;
      if (byteLength > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new FirstDraftProtocolError(
          "The First Draft response is too large.",
          { status: response.status },
        );
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof FirstDraftProtocolError) throw error;
    if (!(error instanceof Error)) throw error;

    throw new FirstDraftNetworkError("The First Draft response failed.", {
      cause: error,
      status: response.status,
    });
  }

  return Buffer.concat(chunks, byteLength);
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
