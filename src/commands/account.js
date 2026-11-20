import {
  FirstDraftNetworkError,
  FirstDraftProtocolError,
  SERVICE_ROUTES,
  isProblemBody,
  problemProjection,
  readResponseBody,
  responseMediaType,
  sendRequest,
  serviceEndpoint,
} from "../api-response.js";

const REQUEST_TIMEOUT_MS = 30_000;

export class AccountUnavailableError extends Error {
  /**
   * @param {number | undefined} status
   * @param {Record<string, unknown> | null} [response]
   */
  constructor(status, response = null) {
    super("The account could not be read.");
    this.status = status;
    this.response = response;
  }
}

export class AccountResponseInvalidError extends Error {
  /** @param {number} status */
  constructor(status) {
    super("The account response is invalid.");
    this.status = status;
  }
}

/**
 * @typedef {object} ReadAccountOptions
 * @property {string} origin
 * @property {typeof globalThis.fetch} [fetchFunction]
 * @property {(timeoutMs: number) => AbortSignal} [createRequestSignal]
 */

/**
 * Reads whether the signed-in account sends progress and failure reports.
 * Only the person turns reports on, on the login approval page.
 *
 * @param {ReadAccountOptions} options
 * @returns {Promise<{reports: "on" | "off"}>}
 */
export async function readAccount({
  origin,
  fetchFunction = globalThis.fetch,
  createRequestSignal = (timeoutMs) => AbortSignal.timeout(timeoutMs),
}) {
  const endpoint = serviceEndpoint(SERVICE_ROUTES.readAccount, origin, {});
  let response;
  let body;
  try {
    response = await sendRequest(fetchFunction, endpoint, {
      headers: { Accept: "application/json, application/problem+json" },
      redirect: "error",
      signal: createRequestSignal(REQUEST_TIMEOUT_MS),
    });
    body = await readResponseBody(response);
  } catch (error) {
    if (error instanceof FirstDraftNetworkError) {
      throw new AccountUnavailableError(error.status);
    }
    if (error instanceof FirstDraftProtocolError) {
      throw error.status >= 200 && error.status < 300
        ? new AccountResponseInvalidError(error.status)
        : new AccountUnavailableError(error.status);
    }
    throw error;
  }

  if (response.status !== 200) {
    if (response.ok) throw new AccountResponseInvalidError(response.status);

    throw new AccountUnavailableError(
      response.status,
      isProblemBody(response, body) ? problemProjection(body) : null,
    );
  }

  // Other keys are ignored so the Service can add account facts without
  // breaking this command; only the validated value is printed.
  if (
    responseMediaType(response) !== "application/json" ||
    typeof body !== "object" ||
    body === null ||
    (body.reports !== "on" && body.reports !== "off")
  ) {
    throw new AccountResponseInvalidError(response.status);
  }

  return { reports: body.reports };
}
