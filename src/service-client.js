import {
  FirstDraftNetworkError,
  FirstDraftProtocolError,
  isProblemBody,
  problemProjection,
  readResponseBytes,
} from "./api-response.js";
import { VERSION } from "./version.js";

/** The public page with the update steps for each setup. */
export const UPDATE_URL = "https://firstdraft.com/update";

/**
 * The Service API contracts this CLI accepts. release/compatibility.json
 * declares the same range for the release check, and
 * test/release-compatibility.test.js keeps the two equal.
 */
export const API_CONTRACT_RANGE = Object.freeze([">= 0.10.0", "< 0.11.0"]);

/** Set by the plugin's launcher; docs/commands.md names them for wrappers. */
export const PLUGIN_VERSION_VARIABLE = "FIRSTDRAFT_PLUGIN_VERSION";
export const AGENT_VARIABLE = "FIRSTDRAFT_AGENT";

// SemVer 2.0.0, as test/release-compatibility.test.js validates it. Build
// metadata after `+` is kept in the text but has no precedence.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const AGENT_NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const PLATFORM = /^[a-z0-9]{1,32}$/;
const MAX_LIMIT_PROBLEM_BYTES = 64 * 1024;
// The Service ignores the whole header, or keeps no client facts with a
// report, when one value is longer.
const MAX_FACT_LENGTH = 40;

/**
 * A response told the CLI to stop. The CLI finishes handling that response
 * and sends nothing after it. When the stop cut the command short, this
 * replaces the command's result, and `replaced` holds the error it replaced.
 */
export class ServiceStopError extends Error {
  /** @type {unknown} */
  replaced = undefined;
}

export class UpdateRequiredError extends ServiceStopError {
  /** @param {{component: "plugin" | "cli", installed: string, minimum: string}} options */
  constructor({ component, installed, minimum }) {
    super("First Draft requires a newer plugin or CLI.");
    this.component = component;
    this.installed = installed;
    this.minimum = minimum;
  }
}

export class ApiContractUnsupportedError extends ServiceStopError {
  /** @param {{origin: string, contract: string, kind: "newer" | "older" | "prerelease"}} options */
  constructor({ origin, contract, kind }) {
    super("First Draft serves an API contract this CLI does not accept.");
    this.origin = origin;
    this.contract = contract;
    this.kind = kind;
  }
}

export class RateLimitedError extends ServiceStopError {
  /** @param {{retryAt: string | undefined, response: Record<string, unknown> | null}} options */
  constructor({ retryAt, response }) {
    super("First Draft refused a request because of an account limit.");
    this.status = 429;
    this.retryAt = retryAt;
    this.response = response;
  }
}

/**
 * @typedef {object} ServiceSession
 * @property {string} clientHeader the FirstDraft-Client value sent on every request
 * @property {string | null} pluginVersion the plugin's version from
 *   FIRSTDRAFT_PLUGIN_VERSION, or null when that is unset or not a version
 * @property {(request?: typeof globalThis.fetch) => typeof globalThis.fetch} fetch
 *   Wraps a fetch function so every request carries FirstDraft-Client and
 *   every response is checked.
 * @property {<T>(work: Promise<T>) => Promise<T>} settle
 *   Awaits a command's work. When a response told the CLI to stop and the
 *   stop cut the work short (a later request was not sent) or was a 429,
 *   rejects with that ServiceStopError. Otherwise the work finished on its
 *   own terms: settle writes one line that names the stop and resolves or
 *   rejects as the work did, so its result or recovery data is kept. Either
 *   way it then writes the command's one version line, if any.
 * @property {() => void} throwIfStopped
 *   Throws the recorded stop as the next request would, so a command that
 *   prints what it is about to send can stop before printing it.
 * @property {() => void} flush
 *   Writes the version line for a command that does not settle its work.
 */

/**
 * One session per command invocation, so the update line is printed at most
 * once however many requests the command makes.
 *
 * @param {object} options
 * @param {Readonly<Record<string, string | undefined>>} options.env
 * @param {(line: string) => void} options.notify writes one line to stderr
 * @param {string} [options.platform]
 * @param {() => number} [options.now]
 * @returns {ServiceSession}
 */
export function createServiceSession({
  env,
  notify,
  platform = process.platform,
  now = Date.now,
}) {
  const plugin = semver(env[PLUGIN_VERSION_VARIABLE]);
  const agent = env[AGENT_VARIABLE]?.toLowerCase();
  // The Service parses this grammar and ignores a header that breaks it, so
  // build metadata, which has no precedence, is not sent.
  const clientHeader = [
    `cli/${VERSION}`,
    ...(plugin === null || plugin.release.length > MAX_FACT_LENGTH
      ? []
      : [`plugin/${plugin.release}`]),
    ...(agent !== undefined && AGENT_NAME.test(agent)
      ? [`agent/${agent}`]
      : []),
    ...(PLATFORM.test(platform) ? [`os/${platform}`] : []),
  ].join("; ");
  // A plugin is compared with the plugin versions First Draft names; a CLI
  // run without one, such as a direct npm installation, with the CLI
  // versions. The two packages are numbered separately.
  // A plugin version that is set, even blank, but unreadable says a plugin is
  // present without saying which, so neither pair is compared, and the
  // command's one version line says why.
  const pluginSet = env[PLUGIN_VERSION_VARIABLE] !== undefined;
  /** @type {{component: "plugin" | "cli", label: string, version: Version, latestHeader: string, minimumHeader: string} | null} */
  const installed =
    pluginSet && plugin === null
      ? null
      : plugin === null
        ? {
            component: "cli",
            label: "CLI",
            version: /** @type {Version} */ (semver(VERSION)),
            latestHeader: "firstdraft-latest-cli",
            minimumHeader: "firstdraft-minimum-cli",
          }
        : {
            component: "plugin",
            label: "plugin",
            version: plugin,
            latestHeader: "firstdraft-latest-plugin",
            minimumHeader: "firstdraft-minimum-plugin",
          };
  /** @type {ServiceStopError | null} */
  let stop = null;
  let blocked = false;
  /** @type {string | null} */
  let updateLine = null;
  let flushed = false;

  /**
   * @param {string} origin
   * @param {Response} response
   * @returns {Promise<Response>} the response, rebuilt when its body was read
   */
  async function observe(origin, response) {
    // A pair is compared only when both of its versions are readable.
    const pair =
      installed === null
        ? null
        : versionPair(
            response,
            installed.latestHeader,
            installed.minimumHeader,
          );
    if (
      installed !== null &&
      updateLine === null &&
      pair !== null &&
      compareVersions(installed.version, pair.latest) < 0
    ) {
      updateLine =
        `First Draft: an update is available (${installed.label} ${pair.latest.text}; this setup has ` +
        `${installed.label} ${installed.version.text}). ` +
        `Tell the person the update steps are at ${UPDATE_URL}\n`;
    }
    if (
      installed === null &&
      updateLine === null &&
      versionPair(
        response,
        "firstdraft-latest-plugin",
        "firstdraft-minimum-plugin",
      ) !== null
    ) {
      updateLine =
        `First Draft: ${PLUGIN_VERSION_VARIABLE} is set but is not a plugin version, so the CLI could not ` +
        `tell whether this setup is current. The update steps are at ${UPDATE_URL}\n`;
    }

    // A 429 refused the request, whatever else the response says.
    if (response.status === 429) {
      // The body is read here rather than through a clone: a tee holds a
      // cancelled branch until the other branch is read, so an oversized
      // body would stall. The command gets the same bytes back.
      const { body, problem } = await readLimitProblem(response);
      stop = new RateLimitedError({
        retryAt: retryTime(response.headers.get("retry-after"), now),
        response: problem,
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    const contract = semver(response.headers.get("firstdraft-api-contract"));
    if (contract !== null && !acceptsContract(contract)) {
      stop = new ApiContractUnsupportedError({
        origin,
        contract: contract.text,
        kind: contractKind(contract),
      });
      return response;
    }

    if (
      installed !== null &&
      pair !== null &&
      compareVersions(installed.version, pair.minimum) < 0
    ) {
      stop = new UpdateRequiredError({
        component: installed.component,
        installed: installed.version.text,
        minimum: pair.minimum.text,
      });
      return response;
    }

    return response;
  }

  /**
   * Writes the one version line for this command: the stop when a response
   * required an update the command survived, else the update notice.
   *
   * @param {{versionStopReported: boolean}} options
   */
  function flush({ versionStopReported }) {
    if (flushed) return;
    flushed = true;
    if (stop !== null && !(stop instanceof RateLimitedError)) {
      if (!versionStopReported) {
        notify(
          `First Draft: ${stopSentence(stop)} This command finished; ${stopAction(stop)} before the next one.\n`,
        );
      }
      return;
    }
    if (updateLine !== null) notify(updateLine);
  }

  function throwIfStopped() {
    if (stop !== null) {
      blocked = true;
      throw stop;
    }
  }

  return {
    clientHeader,
    pluginVersion: plugin === null ? null : plugin.text,
    fetch(request = globalThis.fetch) {
      /** @type {typeof globalThis.fetch} */
      const serviceFetch = async (input, init) => {
        throwIfStopped();

        const response = await request(input, {
          ...init,
          headers: { ...init?.headers, "FirstDraft-Client": clientHeader },
        });
        const url = new URL(input instanceof Request ? input.url : input);
        return observe(url.origin, response);
      };
      return serviceFetch;
    },
    async settle(work) {
      let value;
      try {
        value = await work;
      } catch (error) {
        if (stop !== null && (blocked || stop instanceof RateLimitedError)) {
          stop.replaced = error;
          flush({ versionStopReported: true });
          throw stop;
        }
        flush({ versionStopReported: false });
        throw error;
      }
      // A 429 refused the request, so a result built from it is a refusal.
      if (stop instanceof RateLimitedError) {
        flush({ versionStopReported: true });
        throw stop;
      }
      flush({ versionStopReported: false });
      return value;
    },
    throwIfStopped,
    flush() {
      flush({ versionStopReported: false });
    },
  };
}

/**
 * Both versions of a latest-and-minimum pair, or null unless both are
 * readable.
 *
 * @param {Response} response
 * @param {string} latestHeader
 * @param {string} minimumHeader
 */
function versionPair(response, latestHeader, minimumHeader) {
  const latest = semver(response.headers.get(latestHeader));
  const minimum = semver(response.headers.get(minimumHeader));
  return latest === null || minimum === null ? null : { latest, minimum };
}

/**
 * @param {Version} contract
 * @returns {"newer" | "older" | "prerelease"}
 */
function contractKind(contract) {
  if (compareVersions(contract, API_CONTRACT_FLOOR) < 0) return "older";
  return acceptsContract({ ...contract, prerelease: [] })
    ? "prerelease"
    : "newer";
}

/** @param {ServiceStopError} stop */
export function stopAction(stop) {
  return stop instanceof ApiContractUnsupportedError && stop.kind !== "newer"
    ? "use the CLI version that this First Draft origin supports"
    : `tell the person to update with the steps at ${UPDATE_URL}`;
}

/** @typedef {{major: number, minor: number, patch: number, prerelease: string[], text: string, release: string}} Version */

/**
 * @param {string | null | undefined} value
 * @returns {Version | null}
 */
function semver(value) {
  const match = typeof value === "string" ? SEMVER.exec(value.trim()) : null;
  if (match === null) return null;

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split("."),
    text: match[0],
    release: match[0].replace(/\+.*$/, ""),
  };
}

/**
 * SemVer 2.0.0 precedence: a prerelease sorts before its release, numeric
 * identifiers compare numerically and before alphanumeric ones.
 *
 * @param {Version} left
 * @param {Version} right
 */
export function compareVersions(left, right) {
  const core =
    left.major - right.major ||
    left.minor - right.minor ||
    left.patch - right.patch;
  if (core !== 0) return Math.sign(core);
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return Math.sign(right.prerelease.length - left.prerelease.length);
  }

  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;

    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return Math.sign(Number(a) - Number(b));
    if (aNumeric) return -1;
    if (bNumeric) return 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

const COMPARATOR_SIGNS = new Map([
  ["=", [0]],
  ["<", [-1]],
  ["<=", [-1, 0]],
  [">", [1]],
  [">=", [0, 1]],
]);

const API_CONTRACT_COMPARATORS = API_CONTRACT_RANGE.map((requirement) => {
  const [operator, bound] = requirement.split(/\s+/);
  const signs = COMPARATOR_SIGNS.get(operator ?? "");
  const version = semver(bound);
  if (signs === undefined || version === null) {
    throw new TypeError(`Invalid API contract requirement: ${requirement}`);
  }
  return { signs, version };
});

const API_CONTRACT_FLOOR = /** @type {Version} */ (
  API_CONTRACT_COMPARATORS.find(({ signs }) => signs.includes(1))?.version
);

/**
 * As in npm ranges, a prerelease contract is outside a range whose bounds
 * name none, so `0.10.0-rc.1` is refused like `0.10.0`.
 *
 * @param {Version} contract
 */
function acceptsContract(contract) {
  return (
    contract.prerelease.length === 0 &&
    API_CONTRACT_COMPARATORS.every(({ signs, version }) =>
      signs.includes(compareVersions(contract, version)),
    )
  );
}

/**
 * The sentence that names a stop, shared by the stop line and the handled
 * errors in src/cli.js.
 *
 * @param {ServiceStopError} stop
 */
export function stopSentence(stop) {
  if (stop instanceof UpdateRequiredError) {
    const label = stop.component === "plugin" ? "plugin" : "CLI";
    return `First Draft requires ${label} ${stop.minimum} or later, and this setup has ${label} ${stop.installed}.`;
  }
  if (stop instanceof ApiContractUnsupportedError) {
    return stop.kind === "prerelease"
      ? `First Draft at ${stop.origin} serves prerelease API contract ${stop.contract}, which CLI ${VERSION} does not accept.`
      : `First Draft at ${stop.origin} serves API contract ${stop.contract}, which is ${stop.kind} than CLI ${VERSION} accepts.`;
  }
  return "First Draft refused a request because a limit was reached.";
}

/**
 * RFC 9110 Retry-After: delay-seconds or an HTTP-date. Returns a UTC time to
 * the second, or undefined when the header is absent or unreadable.
 *
 * @param {string | null} value
 * @param {() => number} now
 */
function retryTime(value, now) {
  if (value === null) return undefined;

  const trimmed = value.trim();
  const milliseconds = /^\d{1,10}$/.test(trimmed)
    ? now() + Number(trimmed) * 1000
    : /[A-Za-z]/.test(trimmed)
      ? Date.parse(trimmed)
      : Number.NaN;
  if (!Number.isFinite(milliseconds)) return undefined;

  return new Date(Math.ceil(milliseconds / 1000) * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
}

/** @param {Response} response */
async function readLimitProblem(response) {
  let bytes;
  try {
    bytes = await readResponseBytes(response, MAX_LIMIT_PROBLEM_BYTES);
  } catch (error) {
    // The limit still applies when its explanation cannot be read.
    if (
      error instanceof FirstDraftNetworkError ||
      error instanceof FirstDraftProtocolError
    ) {
      return { body: null, problem: null };
    }
    throw error;
  }

  const body = parseJson(bytes);
  return {
    body: bytes,
    problem: isProblemBody(response, body) ? problemProjection(body) : null,
  };
}

/** @param {Buffer} bytes */
function parseJson(bytes) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) return null;
    throw error;
  }
}
