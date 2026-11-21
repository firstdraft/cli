import {
  environmentTokenFor,
  environmentTokenVariable,
  storedTokenFor,
} from "../api-authentication.js";
import { readAccount } from "./account.js";

/**
 * Which token a request to `origin` would carry: one set in the environment
 * takes precedence over a saved login.
 *
 * @param {object} options
 * @param {string} options.origin
 * @param {string} [options.apiToken]
 * @param {string} [options.stagingApiToken]
 * @param {() => Readonly<Record<string, string>>} options.readStoredTokens
 *   from storedTokenReader, which reads an unreadable or malformed
 *   credentials file as no saved login, as every other command does
 * @returns {{origin: string, saved: boolean, environmentVariable: string | null}}
 */
export function readLoginState({
  origin,
  apiToken,
  stagingApiToken,
  readStoredTokens,
}) {
  return {
    origin,
    saved: storedTokenFor(readStoredTokens(), origin) !== undefined,
    environmentVariable:
      environmentTokenFor(origin, { apiToken, stagingApiToken }) === undefined
        ? null
        : environmentTokenVariable(origin),
  };
}

/**
 * The one request `firstdraft start` makes. A response that told the CLI to
 * stop, such as a minimum version this setup is below, leaves it not ready,
 * so it replaces the result, a failed one included, although no later
 * request was left to send.
 *
 * @param {import("./account.js").ReadAccountOptions & {service: import("../service-client.js").ServiceSession}} options
 */
export async function readReadiness({ service, ...request }) {
  const account = await readAccount(request).catch((error) => {
    service.throwIfStopped();
    throw error;
  });
  service.throwIfStopped();
  return account;
}
