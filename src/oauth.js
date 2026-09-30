import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

import {
  SERVICE_ROUTES,
  readResponseBody,
  serviceEndpoint,
} from "./api-response.js";

export const CLIENT_ID = "firstdraft-cli";
export const LOOPBACK_TIMEOUT_MS = 5 * 60 * 1000;
export const LOOPBACK_HOST = "127.0.0.1";
export const LOOPBACK_PATH = "/callback";
export const SLOW_DOWN_INCREMENT_MS = 5000;
const DEFAULT_DEVICE_INTERVAL_SECONDS = 5;
const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_OAUTH_RESPONSE_BYTES = 64 * 1024;
const OAUTH_ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const USER_CODE = /^[\x21-\x7e]{1,64}$/;

/** @type {Record<LoopbackOutcome, [title: string, message: string]>} */
const OUTCOME_PAGES = {
  approved: [
    "Login complete",
    "First Draft CLI is logged in. You can close this tab and return to your terminal.",
  ],
  denied: [
    "Login cancelled",
    "First Draft CLI was not authorized. You can close this tab and return to your terminal.",
  ],
  failed: [
    "Login failed",
    "First Draft CLI could not finish logging in. Return to your terminal for details.",
  ],
};

// `default-src 'none'` also blocks inline styles, so the one stylesheet is
// allowed by its hash rather than by loosening the policy.
const CALLBACK_PAGE_STYLE =
  "body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem}";
const CALLBACK_PAGE_CSP = `default-src 'none'; style-src 'sha256-${createHash(
  "sha256",
)
  .update(CALLBACK_PAGE_STYLE)
  .digest("base64")}'`;

/**
 * An OAuth endpoint answered with an RFC 6749 error, or the exchange could not
 * be completed. `code` is the validated OAuth error code when there is one.
 */
export class OAuthError extends Error {
  /**
   * @param {string} message
   * @param {{code?: string, status?: number, cause?: unknown}} [options]
   */
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.code = options.code;
    this.status = options.status;
  }
}

/**
 * @typedef {object} AccessToken
 * @property {string} access_token
 * @property {"Bearer"} token_type
 */

/**
 * @typedef {object} RequestOptions
 * @property {string} origin
 * @property {typeof globalThis.fetch} [fetchFunction]
 * @property {(timeoutMs?: number) => AbortSignal} [createRequestSignal]
 */

/** @param {(size: number) => Buffer} [random] */
export function createPkcePair(random = randomBytes) {
  const verifier = random(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** @param {(size: number) => Buffer} [random] */
export function createState(random = randomBytes) {
  return random(32).toString("base64url");
}

/**
 * @param {string} origin
 * @param {{redirectUri: string, state: string, challenge: string, deviceName?: string}} options
 */
export function authorizationUrl(
  origin,
  { redirectUri, state, challenge, deviceName },
) {
  const url = new URL("/oauth/authorize", origin);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...(deviceName ? { device_name: deviceName } : {}),
  }).toString();
  return url.href;
}

/**
 * @typedef {{code: string} | {error: string}} LoopbackResult
 */

/**
 * @typedef {"approved" | "denied" | "failed"} LoopbackOutcome
 */

/**
 * @typedef {object} LoopbackListener
 * @property {string} redirectUri
 * @property {Promise<LoopbackResult>} result
 *   Settles once, with the first callback that carries the expected state.
 * @property {(outcome: LoopbackOutcome) => void} respond
 *   Answers the accepted callback, which is held open until the login knows
 *   its real outcome. Later calls do nothing.
 * @property {() => Promise<void>} close
 *   Answers a still-held callback as failed, then stops listening.
 */

/**
 * @typedef {(options: {state: string}) => Promise<LoopbackListener>} StartLoopbackServer
 */

/**
 * Listens on 127.0.0.1 at an ephemeral port for exactly one OAuth redirect.
 *
 * Only `GET /callback` with a `Host` of the bound address and a `state` equal
 * to the expected value is accepted. Anything else (a favicon request, a
 * missing or wrong state, a rebinding `Host`) receives an error response and
 * does not end the wait, so a stray or hostile local request can neither
 * inject a code nor cancel the login. The first accepted callback settles the
 * result; later requests receive 404. The accepted request is answered only
 * through `respond`, so the browser never reports success before the code
 * exchange and credential write have finished.
 *
 * @type {StartLoopbackServer}
 */
export async function startLoopbackServer({ state }) {
  /** @type {(result: LoopbackResult) => void} */
  let settle = () => {};
  /** @type {Promise<LoopbackResult>} */
  const result = new Promise((resolve) => {
    settle = resolve;
  });
  let settled = false;
  /** @type {Promise<void>} */
  let responded = Promise.resolve();
  /** @type {import("node:http").ServerResponse | undefined} */
  let held;
  let port = 0;

  const server = createServer((request, response) => {
    /** @param {number} status @param {string} title @param {string} message */
    const reply = (status, title, message) =>
      writeCallbackPage(response, status, title, message);

    const url = parseRequestUrl(request.url);
    if (
      settled ||
      request.method !== "GET" ||
      url === null ||
      url.pathname !== LOOPBACK_PATH
    ) {
      reply(404, "Not found", "This address only accepts the login callback.");
      return;
    }

    const params = url.searchParams;
    const states = params.getAll("state");
    if (
      request.headers.host !== `${LOOPBACK_HOST}:${port}` ||
      states.length !== 1 ||
      !equalSecrets(states[0] ?? "", state)
    ) {
      reply(
        400,
        "Login not accepted",
        "This callback does not match the login in progress. Return to your terminal.",
      );
      return;
    }

    settled = true;
    held = response;
    responded = new Promise((resolve) => {
      response.once("close", resolve);
    });
    const codes = params.getAll("code");
    const errors = params.getAll("error");
    const [code] = codes;
    const [error] = errors;
    if (errors.length === 0 && codes.length === 1 && code) {
      settle({ code });
      return;
    }

    settle({
      error:
        errors.length === 1 &&
        error !== undefined &&
        OAUTH_ERROR_CODE.test(error)
          ? error
          : "invalid_request",
    });
  });

  /** @param {LoopbackOutcome} outcome */
  const respond = (outcome) => {
    const response = held;
    held = undefined;
    if (response === undefined) return;
    const [title, message] = OUTCOME_PAGES[outcome];
    writeCallbackPage(response, 200, title, message);
  };

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, () => {
      server.off("error", reject);
      resolve(undefined);
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("The loopback server has no TCP address.");
  }
  port = address.port;

  return {
    redirectUri: `http://${LOOPBACK_HOST}:${port}${LOOPBACK_PATH}`,
    result,
    respond,
    close: async () => {
      respond("failed");
      const closed = new Promise((resolve) => {
        server.close(resolve);
      });
      // Let the final browser page flush, but never wait on a stalled client.
      await Promise.race([
        responded,
        new Promise((resolve) => {
          setTimeout(resolve, 1000).unref();
        }),
      ]);
      server.closeAllConnections();
      await closed;
    },
  };
}

/**
 * @param {RequestOptions & {code: string, redirectUri: string, verifier: string}} options
 * @returns {Promise<AccessToken>}
 */
export async function exchangeAuthorizationCode({
  code,
  redirectUri,
  verifier,
  ...request
}) {
  const response = await postForm(request, SERVICE_ROUTES.requestOAuthToken, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: CLIENT_ID,
    code_verifier: verifier,
  });
  return accessTokenFrom(response);
}

/**
 * @typedef {object} DeviceAuthorization
 * @property {string} deviceCode
 * @property {string} userCode
 * @property {string} verificationUri
 * @property {string | undefined} verificationUriComplete
 * @property {number} expiresIn seconds
 * @property {number} interval seconds
 */

/**
 * @param {RequestOptions & {deviceName?: string}} options
 * @returns {Promise<DeviceAuthorization>}
 */
export async function requestDeviceAuthorization({ deviceName, ...request }) {
  const { status, body } = await postForm(
    request,
    SERVICE_ROUTES.requestDeviceAuthorization,
    {
      client_id: CLIENT_ID,
      ...(deviceName ? { device_name: deviceName } : {}),
    },
  );
  if (status !== 200) throw oauthFailure(status, body);

  const verificationUri = httpUrl(body?.verification_uri);
  const verificationUriComplete =
    body?.verification_uri_complete === undefined
      ? undefined
      : httpUrl(body.verification_uri_complete);
  const interval =
    body?.interval === undefined
      ? DEFAULT_DEVICE_INTERVAL_SECONDS
      : body.interval;
  if (
    body === null ||
    typeof body.device_code !== "string" ||
    body.device_code.length === 0 ||
    typeof body.user_code !== "string" ||
    !USER_CODE.test(body.user_code) ||
    verificationUri === null ||
    verificationUriComplete === null ||
    !isPositiveInteger(body.expires_in) ||
    !isPositiveInteger(interval)
  ) {
    throw new OAuthError("The device authorization response is invalid.", {
      status,
    });
  }

  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri,
    verificationUriComplete,
    expiresIn: body.expires_in,
    interval,
  };
}

/**
 * Polls the token endpoint until the device grant is approved, denied, or
 * expired. Waits `interval` seconds before each poll and adds five seconds on
 * every `slow_down` (RFC 8628 §3.5).
 *
 * @param {RequestOptions & {
 *   deviceCode: string,
 *   interval: number,
 *   expiresIn: number,
 *   sleep: (delayMs: number) => Promise<void>,
 *   now: () => number,
 * }} options
 * @returns {Promise<AccessToken>}
 */
export async function pollDeviceToken({
  deviceCode,
  interval,
  expiresIn,
  sleep,
  now,
  ...request
}) {
  const deadline = now() + expiresIn * 1000;
  let intervalMs = interval * 1000;

  while (true) {
    await sleep(intervalMs);
    if (now() >= deadline) {
      throw new OAuthError("The device code expired.", {
        code: "expired_token",
      });
    }

    const response = await postForm(request, SERVICE_ROUTES.requestOAuthToken, {
      grant_type: DEVICE_CODE_GRANT_TYPE,
      device_code: deviceCode,
      client_id: CLIENT_ID,
    });
    if (response.status === 200) return accessTokenFrom(response);

    const failure = oauthFailure(response.status, response.body);
    if (failure.code === "authorization_pending") continue;
    if (failure.code === "slow_down") {
      intervalMs += SLOW_DOWN_INCREMENT_MS;
      continue;
    }
    throw failure;
  }
}

/**
 * Best-effort RFC 7009 revocation. Resolves true only for a 200 response.
 *
 * @param {RequestOptions & {token: string}} options
 */
export async function revokeToken({ token, ...request }) {
  try {
    const { status } = await postForm(
      request,
      SERVICE_ROUTES.revokeOAuthToken,
      {
        token,
        client_id: CLIENT_ID,
      },
    );
    return status === 200;
  } catch (error) {
    if (error instanceof OAuthError) return false;
    throw error;
  }
}

/**
 * @param {RequestOptions} request
 * @param {{method: string, path: string}} route
 * @param {Record<string, string>} params
 * @returns {Promise<{status: number, body: Record<string, unknown> | null}>}
 */
async function postForm(
  {
    origin,
    fetchFunction = globalThis.fetch,
    createRequestSignal = () => AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  },
  route,
  params,
) {
  const endpoint = serviceEndpoint(route, origin, {});
  let response;
  try {
    response = await fetchFunction(endpoint.url, {
      method: endpoint.method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params).toString(),
      redirect: "error",
      signal: createRequestSignal(),
    });
  } catch (error) {
    throw new OAuthError("The First Draft request failed.", { cause: error });
  }

  let body;
  try {
    body = await readResponseBody(response, MAX_OAUTH_RESPONSE_BYTES);
  } catch (error) {
    throw new OAuthError("The First Draft response failed.", {
      status: response.status,
      cause: error,
    });
  }
  return { status: response.status, body: isRecord(body) ? body : null };
}

/**
 * @param {{status: number, body: Record<string, unknown> | null}} response
 * @returns {AccessToken}
 */
function accessTokenFrom({ status, body }) {
  if (status !== 200) throw oauthFailure(status, body);
  if (
    body === null ||
    typeof body.access_token !== "string" ||
    body.access_token.trim().length === 0 ||
    /\s/.test(body.access_token) ||
    typeof body.token_type !== "string" ||
    body.token_type.toLowerCase() !== "bearer"
  ) {
    throw new OAuthError("The token response is invalid.", { status });
  }
  return { access_token: body.access_token, token_type: "Bearer" };
}

/**
 * @param {number} status
 * @param {Record<string, unknown> | null} body
 */
function oauthFailure(status, body) {
  const code =
    typeof body?.error === "string" && OAUTH_ERROR_CODE.test(body.error)
      ? body.error
      : undefined;
  return new OAuthError("First Draft rejected the OAuth request.", {
    code,
    status,
  });
}

/** @param {unknown} value @returns {string | null} */
function httpUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** @param {string | undefined} value */
function parseRequestUrl(value) {
  if (value === undefined || !value.startsWith("/")) return null;
  try {
    return new URL(value, `http://${LOOPBACK_HOST}`);
  } catch {
    return null;
  }
}

/** @param {string} actual @param {string} expected */
function equalSecrets(actual, expected) {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

/**
 * @param {import("node:http").ServerResponse} response
 * @param {number} status
 * @param {string} title
 * @param {string} message
 */
function writeCallbackPage(response, status, title, message) {
  const body = callbackPage(title, message);
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "Content-Security-Policy": CALLBACK_PAGE_CSP,
    "Referrer-Policy": "no-referrer",
    Connection: "close",
  });
  response.end(body);
}

/** @param {string} title @param {string} message */
function callbackPage(title, message) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${title} · First Draft CLI</title><style>${CALLBACK_PAGE_STYLE}</style></head>
<body>
<h1>${title}</h1>
<p>${message}</p>
</body>
</html>
`;
}

/** @param {unknown} value @returns {value is number} */
function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
