import { PlanStateConfigurationError, normalizeApiUrl } from "./plan-state.js";

export const STAGING_API_URL = "https://staging.firstdraft.com";

export class ApiAuthenticationRequiredError extends Error {}

/**
 * @param {object} options
 * @param {typeof globalThis.fetch} [options.fetchFunction]
 * @param {string} [options.apiToken]
 * @param {string} [options.stagingApiToken]
 * @param {string} [options.apiUrl]
 * @param {boolean} [options.staging]
 */
export function authenticateApiCommand({
  fetchFunction,
  apiToken,
  stagingApiToken,
  apiUrl,
  staging = false,
}) {
  if (
    staging &&
    apiUrl !== undefined &&
    normalizeApiUrl(apiUrl) !== STAGING_API_URL
  ) {
    throw new PlanStateConfigurationError(
      "--staging conflicts with FIRSTDRAFT_API_URL. Unset it or select the staging origin.",
    );
  }

  const configured = staging ? STAGING_API_URL : apiUrl;
  if (!hasToken(apiToken) && !hasToken(stagingApiToken)) return null;

  let selectedOrigin = staging ? STAGING_API_URL : undefined;
  const request = fetchFunction ?? globalThis.fetch;
  /** @type {typeof globalThis.fetch} */
  const authorizedFetch = (input, init) => {
    const endpoint = new URL(input instanceof Request ? input.url : input);
    if (selectedOrigin !== undefined && endpoint.origin !== selectedOrigin) {
      throw new PlanStateConfigurationError(
        "The requested API environment does not match the Project origin. No request was made.",
      );
    }
    const token =
      endpoint.origin === STAGING_API_URL ? stagingApiToken : apiToken;
    if (!hasToken(token)) throw new ApiAuthenticationRequiredError();
    selectedOrigin = endpoint.origin;
    return request(input, {
      ...init,
      headers: {
        ...init?.headers,
        Authorization: `Bearer ${token}`,
      },
    });
  };
  return { apiUrl: configured, fetchFunction: authorizedFetch };
}

/** @param {string | undefined} token */
function hasToken(token) {
  return token !== undefined && token.trim().length > 0;
}

/**
 * @param {number | undefined} status
 * @param {unknown} response
 * @returns {response is Record<string, unknown>}
 */
export function isAuthenticationProblem(status, response) {
  return (
    status === 401 &&
    isRecord(response) &&
    response.status === 401 &&
    response.code === "authentication_required"
  );
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
