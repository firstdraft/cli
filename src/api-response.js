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
 * @param {typeof globalThis.fetch} fetchFunction
 * @param {URL} endpoint
 * @param {RequestInit} request
 */
export async function sendRequest(fetchFunction, endpoint, request) {
  try {
    return await fetchFunction(endpoint, request);
  } catch (error) {
    if (!(error instanceof Error)) throw error;

    throw new FirstDraftNetworkError("The First Draft request failed.", {
      cause: error,
    });
  }
}

/** @param {Response} response */
export async function readResponseBody(response) {
  const bytes = await readResponseBytes(response);

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

/** @param {Response} response */
async function readResponseBytes(response) {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    /^\d+$/.test(declaredLength) &&
    Number(declaredLength) > MAX_RESPONSE_BYTES
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
      if (byteLength > MAX_RESPONSE_BYTES) {
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
