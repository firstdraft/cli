import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { isFileSystemError } from "./file-system.js";

export const CREDENTIALS_FORMAT = "firstdraft.cli-credentials/1";
export const DEVICE_LOGIN_FORMAT = "firstdraft.cli-device-login/1";
const MAX_CREDENTIALS_BYTES = 256 * 1024;
const MAX_DEVICE_LOGIN_BYTES = 16 * 1024;
const USER_CODE = /^[\x21-\x7e]{1,64}$/;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 25;

/**
 * @typedef {object} CredentialsFileSystem
 * @property {typeof mkdirSync} mkdirSync
 * @property {typeof readFileSync} readFileSync
 * @property {typeof renameSync} renameSync
 * @property {typeof rmSync} rmSync
 * @property {typeof statSync} statSync
 * @property {typeof writeFileSync} writeFileSync
 */

/**
 * Where and how the CLI stores login credentials. Every member is injectable so
 * tests never touch the real configuration directory.
 *
 * @typedef {object} CredentialStore
 * @property {Readonly<Record<string, string | undefined>>} [env]
 * @property {() => string} [homedir]
 * @property {CredentialsFileSystem} [fileSystem]
 * @property {() => string} [createTemporaryId]
 * @property {number} [lockTimeoutMs] how long an update waits for another
 *   process's lock before failing
 */

/**
 * @typedef {object} CredentialEntry
 * @property {string} access_token
 * @property {string} token_type
 * @property {string} created_at
 */

/**
 * @typedef {object} Credentials
 * @property {typeof CREDENTIALS_FORMAT} format
 * @property {Record<string, CredentialEntry>} origins
 */

/** @type {CredentialsFileSystem} */
const DEFAULT_FILE_SYSTEM = {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
};

export class CredentialsInvalidError extends Error {}

/**
 * The credentials lock stayed held for the whole wait: another command is
 * updating the file, or one exited while holding the lock. The lock is never
 * removed automatically, because no file-system check can tell an abandoned
 * lock from one another command has just taken. Its `code` lets callers treat
 * it like any other unavailable credentials file.
 */
export class CredentialsLockedError extends Error {
  code = "ELOCKED";
}

/**
 * `$XDG_CONFIG_HOME/firstdraft/credentials.json`, falling back to
 * `~/.config/firstdraft/credentials.json`. A relative XDG_CONFIG_HOME is
 * ignored, as the XDG Base Directory specification requires.
 *
 * @param {CredentialStore} [store]
 */
export function credentialsPath(store = {}) {
  const env = store.env ?? process.env;
  const configHome = env.XDG_CONFIG_HOME;
  const base =
    configHome !== undefined && path.isAbsolute(configHome)
      ? configHome
      : path.join((store.homedir ?? homedir)(), ".config");
  return path.join(base, "firstdraft", "credentials.json");
}

/**
 * `device-login.json` beside the credentials file. It holds the one device
 * login that `login --no-wait` started and `login --finish` has not ended,
 * including its device code, which is a credential.
 *
 * @param {CredentialStore} [store]
 */
export function deviceLoginPath(store = {}) {
  return path.join(path.dirname(credentialsPath(store)), "device-login.json");
}

/**
 * @typedef {object} DeviceLogin
 * @property {string} origin
 * @property {string} deviceCode
 * @property {string} userCode
 * @property {string} verificationUri
 * @property {string | undefined} verificationUriComplete
 * @property {number} interval seconds between polls
 * @property {number} expiresAt epoch milliseconds
 * @property {number} nextPollAt epoch milliseconds
 */

/**
 * Reads the waiting device login, or null when there is none. A malformed
 * file throws CredentialsInvalidError.
 *
 * @param {CredentialStore} [store]
 * @returns {DeviceLogin | null}
 */
export function readDeviceLogin(store = {}) {
  const fileSystem = store.fileSystem ?? DEFAULT_FILE_SYSTEM;
  let source;
  try {
    source = fileSystem.readFileSync(deviceLoginPath(store));
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }

  const parsed =
    source.byteLength > MAX_DEVICE_LOGIN_BYTES ? null : parseJson(source);
  if (
    !isRecord(parsed) ||
    parsed.format !== DEVICE_LOGIN_FORMAT ||
    typeof parsed.origin !== "string" ||
    typeof parsed.device_code !== "string" ||
    parsed.device_code.length === 0 ||
    typeof parsed.user_code !== "string" ||
    !USER_CODE.test(parsed.user_code) ||
    !isHttpUrl(parsed.verification_uri) ||
    (parsed.verification_uri_complete !== undefined &&
      !isHttpUrl(parsed.verification_uri_complete)) ||
    !Number.isSafeInteger(parsed.interval) ||
    Number(parsed.interval) <= 0 ||
    typeof parsed.expires_at !== "string" ||
    !Number.isFinite(Date.parse(parsed.expires_at)) ||
    typeof parsed.next_poll_at !== "string" ||
    !Number.isFinite(Date.parse(parsed.next_poll_at))
  ) {
    throw new CredentialsInvalidError("The device login file is invalid.");
  }

  return {
    origin: parsed.origin,
    deviceCode: parsed.device_code,
    userCode: parsed.user_code,
    verificationUri: parsed.verification_uri,
    verificationUriComplete: parsed.verification_uri_complete,
    interval: Number(parsed.interval),
    expiresAt: Date.parse(parsed.expires_at),
    nextPollAt: Date.parse(parsed.next_poll_at),
  };
}

/**
 * Saves the waiting device login with mode 0600, replacing any other.
 *
 * @param {CredentialStore} store
 * @param {DeviceLogin} login
 */
export function writeDeviceLogin(store, login) {
  const fileSystem = store.fileSystem ?? DEFAULT_FILE_SYSTEM;
  const target = deviceLoginPath(store);
  fileSystem.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  writePrivateFile(store, target, {
    format: DEVICE_LOGIN_FORMAT,
    origin: login.origin,
    device_code: login.deviceCode,
    user_code: login.userCode,
    verification_uri: login.verificationUri,
    ...(login.verificationUriComplete === undefined
      ? {}
      : { verification_uri_complete: login.verificationUriComplete }),
    interval: login.interval,
    expires_at: new Date(login.expiresAt).toISOString(),
    next_poll_at: new Date(login.nextPollAt).toISOString(),
  });
}

/** @param {CredentialStore} store */
export function deleteDeviceLogin(store) {
  (store.fileSystem ?? DEFAULT_FILE_SYSTEM).rmSync(deviceLoginPath(store), {
    force: true,
  });
}

/**
 * Reads the credentials file. A missing file is an empty store; an unreadable
 * or malformed file throws.
 *
 * @param {CredentialStore} [store]
 * @returns {Credentials}
 */
export function readCredentials(store = {}) {
  const fileSystem = store.fileSystem ?? DEFAULT_FILE_SYSTEM;
  let source;
  try {
    source = fileSystem.readFileSync(credentialsPath(store));
  } catch (error) {
    if (isMissingFileError(error)) return emptyCredentials();
    throw error;
  }

  if (source.byteLength > MAX_CREDENTIALS_BYTES) {
    throw new CredentialsInvalidError("The credentials file is too large.");
  }

  let parsed;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(source),
    );
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof TypeError))
      throw error;
    throw new CredentialsInvalidError("The credentials file is invalid.");
  }

  if (
    !isRecord(parsed) ||
    parsed.format !== CREDENTIALS_FORMAT ||
    !isRecord(parsed.origins)
  ) {
    throw new CredentialsInvalidError("The credentials file is invalid.");
  }

  const origins = emptyOrigins();
  for (const [origin, entry] of Object.entries(parsed.origins)) {
    if (!isCredentialEntry(entry)) {
      throw new CredentialsInvalidError("The credentials file is invalid.");
    }
    origins[origin] = {
      access_token: entry.access_token,
      token_type: entry.token_type,
      created_at: entry.created_at,
    };
  }
  return { format: CREDENTIALS_FORMAT, origins };
}

/**
 * Stores (or replaces) the credential for one origin, keeping the others.
 *
 * @param {CredentialStore} store
 * @param {string} origin
 * @param {CredentialEntry} entry
 */
export function writeCredential(store, origin, entry) {
  withStoreLock(store, () => {
    const credentials = readCredentials(store);
    credentials.origins[origin] = entry;
    saveCredentials(store, credentials);
  });
}

/**
 * Removes the credential for one origin. With `accessToken`, removes it only
 * while it still holds that token, so a newer login saved in the meantime is
 * kept.
 *
 * @param {CredentialStore} store
 * @param {string} origin
 * @param {{accessToken?: string}} [options]
 * @returns {boolean} whether an entry was removed
 */
export function deleteCredential(store, origin, { accessToken } = {}) {
  if (!Object.hasOwn(readCredentials(store).origins, origin)) return false;

  return withStoreLock(store, () => {
    const credentials = readCredentials(store);
    const entry = credentials.origins[origin];
    if (
      entry === undefined ||
      (accessToken !== undefined && entry.access_token !== accessToken)
    )
      return false;
    delete credentials.origins[origin];
    saveCredentials(store, credentials);
    return true;
  });
}

/**
 * Returns a memoized, never-throwing reader of stored access tokens keyed by
 * origin. An unreadable or malformed file reads as empty.
 *
 * @param {CredentialStore} [store]
 * @returns {() => Readonly<Record<string, string>>}
 */
export function storedTokenReader(store = {}) {
  /** @type {Record<string, string> | undefined} */
  let tokens;
  return () => {
    if (tokens !== undefined) return tokens;
    /** @type {Record<string, string>} */
    const loaded = Object.create(null);
    try {
      for (const [origin, entry] of Object.entries(
        readCredentials(store).origins,
      )) {
        loaded[origin] = entry.access_token;
      }
    } catch (error) {
      if (
        !(error instanceof CredentialsInvalidError) &&
        !isFileSystemError(error)
      )
        throw error;
    }
    tokens = loaded;
    return tokens;
  };
}

/**
 * Runs `callback` while holding `credentials.json.lock`, so concurrent
 * processes cannot interleave a read-modify-write and lose each other's
 * entries. Reads need no lock because each save is an atomic rename.
 *
 * @template T
 * @param {CredentialStore} store
 * @param {() => T} callback
 * @returns {T}
 */
function withStoreLock(store, callback) {
  const fileSystem = store.fileSystem ?? DEFAULT_FILE_SYSTEM;
  const directory = path.dirname(credentialsPath(store));
  const lock = path.join(directory, "credentials.json.lock");
  const deadline = Date.now() + (store.lockTimeoutMs ?? LOCK_TIMEOUT_MS);

  fileSystem.mkdirSync(directory, { recursive: true, mode: 0o700 });
  while (true) {
    try {
      fileSystem.writeFileSync(lock, `${process.pid}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      break;
    } catch (error) {
      if (!isExistingFileError(error)) throw error;
    }
    if (Date.now() >= deadline) {
      throw new CredentialsLockedError(
        "Another process is updating the credentials file.",
      );
    }
    sleep(LOCK_RETRY_MS);
  }

  try {
    return callback();
  } finally {
    try {
      fileSystem.rmSync(lock, { force: true });
    } catch {
      // The callback's outcome matters more; a leftover lock is reported later.
    }
  }
}

/** @param {number} milliseconds */
function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/** @param {CredentialStore} store @param {Credentials} credentials */
function saveCredentials(store, credentials) {
  writePrivateFile(store, credentialsPath(store), credentials);
}

/**
 * Writes JSON with mode 0600 through a temporary file and an atomic rename,
 * so a reader sees the old file or the new one, never a partial write.
 *
 * @param {CredentialStore} store
 * @param {string} target
 * @param {unknown} value
 */
function writePrivateFile(store, target, value) {
  const fileSystem = store.fileSystem ?? DEFAULT_FILE_SYSTEM;
  const directory = path.dirname(target);
  const temporaryId =
    store.createTemporaryId?.() ?? randomBytes(8).toString("hex");
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${temporaryId}.tmp`,
  );

  try {
    fileSystem.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    fileSystem.renameSync(temporary, target);
  } catch (error) {
    try {
      fileSystem.rmSync(temporary, { force: true });
    } catch {
      // The original failure is the useful one.
    }
    throw error;
  }
}

/** @returns {Credentials} */
function emptyCredentials() {
  return { format: CREDENTIALS_FORMAT, origins: emptyOrigins() };
}

/**
 * Origins are keyed by URL origin; a null prototype keeps keys such as
 * `__proto__` inert.
 *
 * @returns {Record<string, CredentialEntry>}
 */
function emptyOrigins() {
  return Object.create(null);
}

/** @param {unknown} value @returns {value is CredentialEntry} */
function isCredentialEntry(value) {
  return (
    isRecord(value) &&
    typeof value.access_token === "string" &&
    value.access_token.length > 0 &&
    typeof value.token_type === "string" &&
    typeof value.created_at === "string"
  );
}

/** @param {unknown} error */
function isExistingFileError(error) {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

/** @param {unknown} error */
function isMissingFileError(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** @param {Buffer} source */
function parseJson(source) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(source));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) return null;
    throw error;
  }
}

/** @param {unknown} value @returns {value is string} */
function isHttpUrl(value) {
  if (typeof value !== "string" || !URL.canParse(value)) return false;
  const { protocol } = new URL(value);
  return protocol === "https:" || protocol === "http:";
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
