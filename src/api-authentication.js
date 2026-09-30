import { PlanStateConfigurationError, normalizeApiUrl } from "./plan-state.js";

export const STAGING_API_URL = "https://staging.firstdraft.com";

export class ApiAuthenticationRequiredError extends Error {}

/**
 * Rejects `--staging` together with a FIRSTDRAFT_API_URL that names another
 * origin.
 *
 * @param {string | undefined} apiUrl
 * @param {boolean} staging
 */
export function assertStagingSelection(apiUrl, staging) {
  if (
    staging &&
    apiUrl !== undefined &&
    normalizeApiUrl(apiUrl) !== STAGING_API_URL
  ) {
    throw new PlanStateConfigurationError(
      "--staging conflicts with FIRSTDRAFT_API_URL. Unset it or select the staging origin.",
    );
  }
}

/**
 * Selects the environment token for an origin: staging uses its own variable,
 * production and custom origins share FIRSTDRAFT_API_TOKEN.
 *
 * @param {string} origin
 * @param {{apiToken?: string, stagingApiToken?: string}} tokens
 */
export function environmentTokenFor(origin, { apiToken, stagingApiToken }) {
  const token = origin === STAGING_API_URL ? stagingApiToken : apiToken;
  return hasToken(token) ? token : undefined;
}

/**
 * @param {object} options
 * @param {typeof globalThis.fetch} [options.fetchFunction]
 * @param {string} [options.apiToken]
 * @param {string} [options.stagingApiToken]
 * @param {string} [options.apiUrl]
 * @param {boolean} [options.staging]
 * @param {() => Readonly<Record<string, string>>} [options.readStoredTokens]
 *   Stored `firstdraft login` tokens keyed by exact origin. Consulted only when
 *   the environment has no token for the requested origin.
 */
export function authenticateApiCommand({
  fetchFunction,
  apiToken,
  stagingApiToken,
  apiUrl,
  staging = false,
  readStoredTokens = () => ({}),
}) {
  assertStagingSelection(apiUrl, staging);

  const configured = staging ? STAGING_API_URL : apiUrl;
  if (
    !hasToken(apiToken) &&
    !hasToken(stagingApiToken) &&
    !Object.values(readStoredTokens()).some(hasToken)
  )
    return null;

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
      environmentTokenFor(endpoint.origin, { apiToken, stagingApiToken }) ??
      storedToken(readStoredTokens(), endpoint.origin);
    if (token === undefined) throw new ApiAuthenticationRequiredError();
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

/** @param {Readonly<Record<string, string>>} tokens @param {string} origin */
function storedToken(tokens, origin) {
  const token = Object.hasOwn(tokens, origin) ? tokens[origin] : undefined;
  return hasToken(token) ? token : undefined;
}

/**
 * @param {string | undefined} token
 * @returns {token is string}
 */
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
