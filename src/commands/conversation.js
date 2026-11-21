import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import {
  FirstDraftNetworkError,
  FirstDraftProtocolError,
  SERVICE_ROUTES,
  isProblemBody,
  problemProjection,
  readResponseBody,
  sendRequest,
  serviceEndpoint,
} from "../api-response.js";
import { isFileSystemError } from "../file-system.js";

export const MAX_CONVERSATION_BYTES = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * @typedef {object} ConversationFileSystem
 * @property {typeof statSync} statSync
 * @property {typeof readFileSync} readFileSync
 */

/** @type {ConversationFileSystem} */
const DEFAULT_FILE_SYSTEM = { statSync, readFileSync };

export class ConversationFileError extends Error {
  /** @param {"unreadable" | "empty" | "too_large"} reason @param {{cause?: unknown}} [options] */
  constructor(reason, options = {}) {
    super("The conversation file cannot be sent.", { cause: options.cause });
    this.reason = reason;
  }
}

export class ConversationRejectedError extends Error {
  /**
   * @param {number} status
   * @param {Record<string, unknown>} response
   */
  constructor(status, response) {
    super("First Draft rejected the conversation.");
    this.status = status;
    this.response = response;
  }
}

export class ConversationUnavailableError extends Error {
  /**
   * @param {number | undefined} status
   * @param {Record<string, unknown> | null} [response]
   */
  constructor(status, response = null) {
    super("The conversation upload could not be confirmed.");
    this.status = status;
    this.response = response;
  }
}

/**
 * @typedef {object} Conversation
 * @property {string} path absolute path of the file on this computer
 * @property {string} name the file's base name, the only part of the path sent
 * @property {Buffer} bytes
 * @property {string} sha256
 */

/**
 * Reads the conversation file, so the person can see what will be sent
 * before any request.
 *
 * @param {object} options
 * @param {string} options.cwd
 * @param {string} options.file
 * @param {ConversationFileSystem} [options.fileSystem]
 * @returns {Conversation}
 */
export function readConversationFile({
  cwd,
  file,
  fileSystem = DEFAULT_FILE_SYSTEM,
}) {
  const absolute = path.resolve(cwd, file);
  let bytes;
  try {
    const stat = fileSystem.statSync(absolute);
    if (!stat.isFile()) throw new ConversationFileError("unreadable");
    if (stat.size > MAX_CONVERSATION_BYTES) {
      throw new ConversationFileError("too_large");
    }
    bytes = fileSystem.readFileSync(absolute);
  } catch (error) {
    if (error instanceof ConversationFileError) throw error;
    if (!isFileSystemError(error)) throw error;

    throw new ConversationFileError("unreadable", { cause: error });
  }
  if (bytes.byteLength > MAX_CONVERSATION_BYTES) {
    throw new ConversationFileError("too_large");
  }
  if (bytes.byteLength === 0) throw new ConversationFileError("empty");

  return {
    path: absolute,
    name: path.basename(absolute),
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/**
 * @typedef {object} SendConversationOptions
 * @property {string} apiUrl
 * @property {string} projectId
 * @property {Conversation} conversation
 * @property {typeof globalThis.fetch} [fetchFunction]
 * @property {(timeoutMs: number) => AbortSignal} [createRequestSignal]
 */

/**
 * Uploads the file's bytes unchanged, once, as the `conversation[file]` part
 * of a multipart form. Nothing is retried: First Draft may already hold the
 * file when the outcome is unconfirmed.
 *
 * @param {SendConversationOptions} options
 * @returns {Promise<{outcome: "sent"}>}
 */
export async function sendConversation({
  apiUrl,
  projectId,
  conversation,
  fetchFunction = globalThis.fetch,
  createRequestSignal = (timeoutMs) => AbortSignal.timeout(timeoutMs),
}) {
  const endpoint = serviceEndpoint(SERVICE_ROUTES.sendConversation, apiUrl, {
    project_id: projectId,
  });
  const form = new FormData();
  form.append(
    "conversation[file]",
    new Blob([conversation.bytes], { type: "application/octet-stream" }),
    conversation.name,
  );

  let response;
  try {
    response = await sendRequest(fetchFunction, endpoint, {
      headers: { Accept: "application/json, application/problem+json" },
      body: form,
      redirect: "error",
      signal: createRequestSignal(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof FirstDraftNetworkError) {
      throw new ConversationUnavailableError(error.status);
    }
    throw error;
  }

  if (response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { outcome: "sent" };
  }

  let body;
  try {
    body = await readResponseBody(response);
  } catch (error) {
    if (
      error instanceof FirstDraftNetworkError ||
      error instanceof FirstDraftProtocolError
    ) {
      throw new ConversationUnavailableError(response.status);
    }
    throw error;
  }

  const problem = isProblemBody(response, body)
    ? problemProjection(body)
    : null;
  if (problem !== null && response.status !== 408 && response.status < 500) {
    throw new ConversationRejectedError(response.status, problem);
  }
  throw new ConversationUnavailableError(response.status, problem);
}
