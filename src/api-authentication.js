/**
 * @param {typeof globalThis.fetch | undefined} fetchFunction
 * @param {string | undefined} apiToken
 * @returns {typeof globalThis.fetch | null}
 */
export function authenticatedFetch(fetchFunction, apiToken) {
  if (apiToken === undefined || apiToken.trim().length === 0) return null;

  const request = fetchFunction ?? globalThis.fetch;
  return (input, init) =>
    request(input, {
      ...init,
      headers: {
        ...init?.headers,
        Authorization: `Bearer ${apiToken}`,
      },
    });
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
