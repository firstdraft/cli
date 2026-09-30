import { hostname as osHostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

import {
  STAGING_API_URL,
  assertStagingSelection,
} from "../api-authentication.js";
import {
  CredentialsInvalidError,
  CredentialsLockedError,
  credentialsPath,
  readCredentials,
  writeCredential,
} from "../credentials.js";
import { isFileSystemError } from "../file-system.js";
import {
  LOOPBACK_TIMEOUT_MS,
  OAuthError,
  authorizationUrl,
  createPkcePair,
  createState,
  exchangeAuthorizationCode,
  pollDeviceToken,
  requestDeviceAuthorization,
  startLoopbackServer,
} from "../oauth.js";
import { normalizeApiUrl } from "../plan-state.js";
import { DEFAULT_API_URL } from "./plan-push.js";

const MAX_DEVICE_NAME_LENGTH = 100;

export class LoginDeniedError extends Error {}
export class LoginExpiredError extends Error {}

export class LoginFailedError extends Error {
  /**
   * @param {string} message
   * @param {{reason?: string, status?: number, credentialsPath?: string, phase?: "read" | "write", cause?: unknown}} [options]
   */
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.reason = options.reason;
    this.status = options.status;
    this.credentialsPath = options.credentialsPath;
    this.phase = options.phase;
  }
}

/**
 * Selects the origin exactly as other API commands select their initial
 * origin: `--staging`, else FIRSTDRAFT_API_URL, else production.
 *
 * @param {{apiUrl?: string, staging?: boolean}} options
 */
export function resolveLoginOrigin({ apiUrl, staging = false }) {
  assertStagingSelection(apiUrl, staging);
  if (staging) return STAGING_API_URL;
  return apiUrl === undefined ? DEFAULT_API_URL : normalizeApiUrl(apiUrl);
}

/**
 * @typedef {object} LoginOptions
 * @property {string} origin
 * @property {boolean} [device] use the device authorization grant
 * @property {(text: string) => void} prompt writes user instructions (stderr)
 * @property {typeof globalThis.fetch} [fetchFunction]
 * @property {(timeoutMs?: number) => AbortSignal} [createRequestSignal]
 * @property {(delayMs: number, signal?: AbortSignal) => Promise<void>} [sleep]
 * @property {() => number} [now]
 * @property {() => string} [hostname]
 * @property {import("../oauth.js").StartLoopbackServer} [startLoopback]
 * @property {import("../credentials.js").CredentialStore} [credentials]
 */

/**
 * Runs the browser (loopback + PKCE) or device flow and stores the resulting
 * token for `origin`. Never returns or prints the token.
 *
 * @param {LoginOptions} options
 */
export async function login({
  origin,
  device = false,
  prompt,
  fetchFunction,
  createRequestSignal,
  sleep = defaultSleep,
  now = Date.now,
  hostname = osHostname,
  startLoopback = startLoopbackServer,
  credentials = {},
}) {
  // Reject an unreadable or invalid store before any network request.
  // A later write can still fail after a token has been issued.
  readStore(credentials);
  const deviceName = safeDeviceName(hostname);
  const request = { origin, fetchFunction, createRequestSignal };

  /** @param {import("../oauth.js").AccessToken} token */
  const save = (token) => {
    try {
      writeCredential(credentials, origin, {
        access_token: token.access_token,
        token_type: token.token_type,
        created_at: new Date(now()).toISOString(),
      });
    } catch (error) {
      throw credentialsError(error, credentials, "write");
    }
  };

  try {
    if (device) {
      save(await deviceLogin({ ...request, deviceName, prompt, sleep, now }));
    } else {
      await browserLogin({
        ...request,
        deviceName,
        prompt,
        sleep,
        startLoopback,
        save,
      });
    }
  } catch (error) {
    throw loginError(error);
  }
  return { origin };
}

/**
 * @param {import("../oauth.js").RequestOptions & {
 *   deviceName: string | undefined,
 *   prompt: (text: string) => void,
 *   sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>,
 *   startLoopback: import("../oauth.js").StartLoopbackServer,
 *   save: (token: import("../oauth.js").AccessToken) => void,
 * }} options
 */
async function browserLogin({
  deviceName,
  prompt,
  sleep,
  startLoopback,
  save,
  ...request
}) {
  const state = createState();
  const { verifier, challenge } = createPkcePair();

  let listener;
  try {
    listener = await startLoopback({ state });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    throw new LoginFailedError(
      "Could not start the local login callback server.",
      { reason: "loopback_unavailable", cause: error },
    );
  }

  const timer = new AbortController();
  try {
    const url = authorizationUrl(request.origin, {
      redirectUri: listener.redirectUri,
      state,
      challenge,
      deviceName,
    });
    prompt(
      `To log in to ${request.origin}, open this URL in your browser:\n\n  ${url}\n\n` +
        "Waiting up to 5 minutes for approval. On a machine without a browser, " +
        "run 'firstdraft login --interactive' instead.\n",
    );
    /** @type {Promise<"timeout">} */
    const timeout = sleep(LOOPBACK_TIMEOUT_MS, timer.signal).then(
      () => "timeout",
      () => new Promise(() => {}),
    );
    const outcome = await Promise.race([listener.result, timeout]);
    timer.abort();

    if (outcome === "timeout") {
      throw new LoginExpiredError("No browser callback arrived in time.");
    }
    if ("error" in outcome) {
      listener.respond(outcome.error === "access_denied" ? "denied" : "failed");
      throw new OAuthError("The authorization was not granted.", {
        code: outcome.error,
      });
    }

    // The browser waits on the held callback until the token is exchanged and
    // saved, so its page reports what the terminal will report.
    save(
      await exchangeAuthorizationCode({
        ...request,
        code: outcome.code,
        redirectUri: listener.redirectUri,
        verifier,
      }),
    );
    listener.respond("approved");
  } finally {
    timer.abort();
    // Answers any still-held callback as failed.
    await listener.close();
  }
}

/**
 * @param {import("../oauth.js").RequestOptions & {
 *   deviceName: string | undefined,
 *   prompt: (text: string) => void,
 *   sleep: (delayMs: number) => Promise<void>,
 *   now: () => number,
 * }} options
 */
async function deviceLogin({ deviceName, prompt, sleep, now, ...request }) {
  const authorization = await requestDeviceAuthorization({
    ...request,
    deviceName,
  });
  prompt(
    `To log in to ${request.origin}, open this URL in a browser on any device:\n\n` +
      `  ${authorization.verificationUri}\n\n` +
      `and enter the code: ${authorization.userCode}\n\n` +
      (authorization.verificationUriComplete === undefined
        ? ""
        : `Or open this URL, which already includes the code:\n\n  ${authorization.verificationUriComplete}\n\n`) +
      "Waiting for approval...\n",
  );
  return pollDeviceToken({
    ...request,
    deviceCode: authorization.deviceCode,
    interval: authorization.interval,
    expiresIn: authorization.expiresIn,
    sleep,
    now,
  });
}

/** @param {import("../credentials.js").CredentialStore} credentials */
function readStore(credentials) {
  try {
    return readCredentials(credentials);
  } catch (error) {
    throw credentialsError(error, credentials, "read");
  }
}

/**
 * @param {unknown} error
 * @param {import("../credentials.js").CredentialStore} credentials
 * @param {"read" | "write"} phase
 */
function credentialsError(error, credentials, phase) {
  if (!(error instanceof CredentialsInvalidError) && !isFileSystemError(error))
    throw error;
  return new LoginFailedError("The credentials file could not be used.", {
    reason:
      error instanceof CredentialsLockedError
        ? "credentials_locked"
        : error instanceof CredentialsInvalidError
          ? "credentials_invalid"
          : "credentials_unavailable",
    credentialsPath: credentialsPath(credentials),
    phase,
    cause: error,
  });
}

/** @param {unknown} error */
function loginError(error) {
  if (
    error instanceof LoginDeniedError ||
    error instanceof LoginExpiredError ||
    error instanceof LoginFailedError
  )
    return error;
  if (!(error instanceof OAuthError)) throw error;

  if (error.code === "access_denied") {
    return new LoginDeniedError("The authorization was denied.");
  }
  if (error.code === "expired_token") {
    return new LoginExpiredError("The authorization expired.");
  }
  return new LoginFailedError("The login could not be completed.", {
    reason: error.code,
    status: error.status,
    cause: error,
  });
}

/** @param {() => string} hostname */
function safeDeviceName(hostname) {
  let name;
  try {
    name = hostname();
  } catch {
    return undefined;
  }
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned.length === 0
    ? undefined
    : cleaned.slice(0, MAX_DEVICE_NAME_LENGTH);
}

/** @param {number} delayMs @param {AbortSignal} [signal] */
function defaultSleep(delayMs, signal) {
  return delay(delayMs, undefined, { signal });
}
