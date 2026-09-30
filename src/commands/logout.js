import {
  CredentialsInvalidError,
  CredentialsLockedError,
  credentialsPath,
  deleteCredential,
  readCredentials,
} from "../credentials.js";
import { isFileSystemError } from "../file-system.js";
import { revokeToken } from "../oauth.js";

export class LogoutFailedError extends Error {
  /**
   * @param {string} message
   * @param {{reason: string, credentialsPath: string, phase: "read" | "write", revoked?: boolean, cause?: unknown}} options
   */
  constructor(message, options) {
    super(message, { cause: options.cause });
    this.reason = options.reason;
    this.credentialsPath = options.credentialsPath;
    this.phase = options.phase;
    this.revoked = options.revoked;
  }
}

/**
 * @typedef {object} LogoutOptions
 * @property {string} origin
 * @property {typeof globalThis.fetch} [fetchFunction]
 * @property {(timeoutMs?: number) => AbortSignal} [createRequestSignal]
 * @property {import("../credentials.js").CredentialStore} [credentials]
 */

/**
 * @typedef {object} LogoutResult
 * @property {boolean} stored whether a credential for the origin was stored
 * @property {boolean} revoked whether First Draft confirmed revocation
 * @property {boolean} changed whether the saved token changed during logout, so
 *   the current entry was left in place
 */

/**
 * Revokes the stored token for `origin` (best effort) and deletes the local
 * entry if it still holds that token. Other origins are untouched.
 *
 * @param {LogoutOptions} options
 * @returns {Promise<LogoutResult>}
 */
export async function logout({
  origin,
  fetchFunction,
  createRequestSignal,
  credentials = {},
}) {
  const entry = withCredentials(
    credentials,
    () => readCredentials(credentials).origins[origin],
    { phase: "read" },
  );
  if (entry === undefined)
    return { stored: false, revoked: false, changed: false };

  const revoked = await revokeToken({
    origin,
    token: entry.access_token,
    fetchFunction,
    createRequestSignal,
  });
  const removed = withCredentials(
    credentials,
    () =>
      deleteCredential(credentials, origin, {
        accessToken: entry.access_token,
      }),
    { phase: "write", revoked },
  );
  return { stored: true, revoked, changed: !removed };
}

/**
 * @template T
 * @param {import("../credentials.js").CredentialStore} credentials
 * @param {() => T} callback
 * @param {{phase: "read" | "write", revoked?: boolean}} outcome
 * @returns {T}
 */
function withCredentials(credentials, callback, outcome) {
  try {
    return callback();
  } catch (error) {
    if (
      !(error instanceof CredentialsInvalidError) &&
      !isFileSystemError(error)
    )
      throw error;
    throw new LogoutFailedError("The credentials file could not be used.", {
      reason:
        error instanceof CredentialsLockedError
          ? "credentials_locked"
          : error instanceof CredentialsInvalidError
            ? "credentials_invalid"
            : "credentials_unavailable",
      credentialsPath: credentialsPath(credentials),
      ...outcome,
      cause: error,
    });
  }
}
