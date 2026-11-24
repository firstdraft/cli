import {
  FirstDraftNetworkError,
  FirstDraftProtocolError,
  SERVICE_ROUTES,
  isProblemBody,
  readResponseBody,
  responseMediaType,
  sendRequest,
  serviceEndpoint,
} from "../api-response.js";

const REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_ENVIRONMENT = "production";
// The Service's Project::Environment::NAME_PATTERN. Checking it locally also
// keeps a name from adding path segments to the request URL.
const ENVIRONMENT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4_PATTERN =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const SHA_PATTERN = /^[0-9a-f]{7,64}$/;
const HOST_STATES = new Set([
  "provisioning",
  "ready",
  "resizing",
  "destroying",
  "failed",
]);
const RELEASE_STATES = new Set(["none_yet", "live", "failed"]);
const DOMAIN_STATES = new Set(["checking", "connected"]);
const RECORD_STATUSES = new Set(["unchecked", "ok", "missing", "wrong"]);
const EMAIL_STATES = new Set([
  "waiting_for_domain",
  "verifying",
  "ready",
  "paused",
]);
const PAUSED_REASONS = new Set(["allowance", "reputation", "operator"]);
const BACKUP_STATES = new Set(["ok", "incomplete", "stale"]);
const RESTORE_CHECK_STATES = new Set(["passed", "failed"]);
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @typedef {object} HostRecord
 * @property {"provisioning" | "ready" | "resizing" | "destroying" | "failed"} state
 * @property {string} region
 * @property {string} size
 * @property {string | null} ipv4
 * @property {string} ssh_user
 * @property {string} ssh_key_fingerprint
 * @property {string} created_at
 * @property {string | null} ready_at
 * @property {{code: string, detail: string} | null} failure
 * @property {{state: "none_yet" | "live" | "failed", version: string | null, changed_at: string | null}} release
 */

/**
 * @typedef {object} DomainRow
 * @property {string} purpose
 * @property {string} type
 * @property {string} name
 * @property {string} value
 * @property {boolean} required
 * @property {"unchecked" | "ok" | "missing" | "wrong"} status
 * @property {string[]} found
 */

/**
 * @typedef {object} DomainRecord
 * @property {string} hostname
 * @property {"checking" | "connected"} state
 * @property {string | null} checked_at
 * @property {DomainRow[]} records
 */

/**
 * @typedef {object} SmtpRecord
 * @property {string} host
 * @property {number} port
 * @property {string} username
 * @property {Record<string, string>} headers
 */

export class HostRejectedError extends Error {
  /**
   * @param {number} status
   * @param {Record<string, unknown>} response
   */
  constructor(status, response) {
    super("First Draft rejected the hosting request.");
    this.status = status;
    this.response = response;
    /** @type {unknown} The host a 409 host_exists names beside its problem. */
    this.existingHost = undefined;
  }
}

export class HostUnavailableError extends Error {
  /**
   * @param {number | undefined} status
   * @param {Record<string, unknown> | null} [response]
   */
  constructor(status, response = null) {
    super("The hosting request could not be completed.");
    this.status = status;
    this.response = response;
  }
}

export class HostResponseInvalidError extends Error {
  /** @param {number} status */
  constructor(status) {
    super("The hosting response is invalid.");
    this.status = status;
  }
}

/** @param {unknown} value @returns {value is string} */
export function isEnvironmentName(value) {
  return typeof value === "string" && ENVIRONMENT_NAME_PATTERN.test(value);
}

/** @param {unknown} value @returns {value is string} */
export function isSlug(value) {
  return typeof value === "string" && SLUG_PATTERN.test(value);
}

/** @param {unknown} value @returns {value is string} */
export function isHostname(value) {
  return typeof value === "string" && HOSTNAME_PATTERN.test(value);
}

/**
 * The sslip.io name that resolves to a Droplet's IPv4, which serves the app
 * until the owner connects a domain.
 *
 * @param {string} ipv4
 */
export function defaultHostname(ipv4) {
  return `${ipv4.replaceAll(".", "-")}.sslip.io`;
}

/**
 * @typedef {object} HostContext
 * @property {string} apiUrl
 * @property {string} projectId
 * @property {string} environment
 * @property {typeof globalThis.fetch} fetchFunction
 * @property {(timeoutMs: number) => AbortSignal} [createRequestSignal]
 */

/**
 * Asks First Draft to create the Environment's Droplet with the owner's SSH
 * public key. An Environment that already has a host answers 409
 * `host_exists` with that host, which is returned with `existing: true`.
 *
 * @param {HostContext & {region?: string, size?: string, sshPublicKey: string}} options
 */
export async function createHost({ region, size, sshPublicKey, ...context }) {
  const host = {
    ...(region === undefined ? {} : { region }),
    ...(size === undefined ? {} : { size }),
    ssh_public_key: sshPublicKey,
  };
  try {
    const { status, body } = await request(context, SERVICE_ROUTES.createHost, {
      json: { host },
      expected: 202,
    });
    return { existing: false, ...hostResponse(status, body, context) };
  } catch (error) {
    if (
      error instanceof HostRejectedError &&
      error.status === 409 &&
      error.response.code === "host_exists" &&
      isHost(error.existingHost)
    ) {
      return {
        existing: true,
        environment: environmentOf(context),
        host: copyHost(error.existingHost),
      };
    }
    throw error;
  }
}

/** @param {HostContext} context */
export async function readHost(context) {
  const { status, body } = await request(context, SERVICE_ROUTES.readHost);
  return hostResponse(status, body, context);
}

/** @param {HostContext & {size: string}} options */
export async function resizeHost({ size, ...context }) {
  const { status, body } = await request(context, SERVICE_ROUTES.resizeHost, {
    json: { host: { size } },
    expected: 202,
  });
  return hostResponse(status, body, context);
}

/** @param {HostContext & {confirm: string}} options */
export async function destroyHost({ confirm, ...context }) {
  const { status, body } = await request(context, SERVICE_ROUTES.destroyHost, {
    json: { confirm },
    expected: 202,
  });
  return hostResponse(status, body, context);
}

/** @param {HostContext} context */
export async function readBackups(context) {
  const { status, body } = await request(context, SERVICE_ROUTES.readBackups);
  if (!isRecord(body) || !isBackups(body.backups)) {
    throw new HostResponseInvalidError(status);
  }
  assertEnvironment(status, body, context);
  return {
    environment: environmentOf(context),
    backups: copyBackups(body.backups),
  };
}

/** @param {HostContext & {hostname: string}} options */
export async function connectDomain({ hostname, ...context }) {
  const { status, body } = await request(
    context,
    SERVICE_ROUTES.connectDomain,
    { json: { domain: { hostname } } },
  );
  const response = domainResponse(status, body, context);
  if (response.domain?.hostname !== hostname) {
    throw new HostResponseInvalidError(status);
  }
  return response;
}

/** @param {HostContext} context */
export async function readDomain(context) {
  const { status, body } = await request(context, SERVICE_ROUTES.readDomain);
  return domainResponse(status, body, context);
}

/** @param {HostContext} context */
export async function checkDomain(context) {
  const { status, body } = await request(context, SERVICE_ROUTES.checkDomain);
  return domainResponse(status, body, context);
}

/** @param {HostContext} context */
export async function disconnectDomain(context) {
  const { status, body } = await request(
    context,
    SERVICE_ROUTES.disconnectDomain,
  );
  const response = domainResponse(status, body, context, { nullable: true });
  if (response.domain !== null) throw new HostResponseInvalidError(status);
  return response;
}

/** @param {HostContext} context */
export async function readEmail(context) {
  const { status, body } = await request(context, SERVICE_ROUTES.readEmail);
  if (!isRecord(body) || !isEmail(body.email)) {
    throw new HostResponseInvalidError(status);
  }
  assertEnvironment(status, body, context);
  return {
    environment: environmentOf(context),
    email: copyEmail(body.email),
  };
}

/**
 * Asks First Draft for a new SMTP credential, which revokes the earlier one.
 * The password is returned once; the caller stores it and never prints it.
 *
 * @param {HostContext} context
 */
export async function createSmtpCredentials(context) {
  const { status, body } = await request(
    context,
    SERVICE_ROUTES.createSmtpCredentials,
    { expected: 201 },
  );
  if (
    !isRecord(body) ||
    !isSmtp(body.smtp) ||
    typeof body.smtp.password !== "string" ||
    body.smtp.password.length === 0
  ) {
    throw new HostResponseInvalidError(status);
  }
  assertEnvironment(status, body, context);
  return {
    environment: environmentOf(context),
    smtp: copySmtp(body.smtp),
    password: body.smtp.password,
  };
}

/**
 * @param {HostContext} context
 * @param {{method: string, path: string}} route
 * @param {{json?: unknown, expected?: number}} [options]
 */
async function request(
  {
    apiUrl,
    projectId,
    environment,
    fetchFunction,
    createRequestSignal = (timeoutMs) => AbortSignal.timeout(timeoutMs),
  },
  route,
  { json, expected = 200 } = {},
) {
  const endpoint = serviceEndpoint(route, apiUrl, {
    project_id: projectId,
    environment_name: environment,
  });
  let response;
  let body;
  try {
    response = await sendRequest(fetchFunction, endpoint, {
      headers: {
        Accept: "application/json, application/problem+json",
        ...(json === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
      redirect: "error",
      signal: createRequestSignal(REQUEST_TIMEOUT_MS),
    });
    body = await readResponseBody(response);
  } catch (error) {
    if (error instanceof FirstDraftNetworkError) {
      throw new HostUnavailableError(error.status);
    }
    if (error instanceof FirstDraftProtocolError) {
      throw error.status >= 200 && error.status < 300
        ? new HostResponseInvalidError(error.status)
        : new HostUnavailableError(error.status);
    }
    throw error;
  }

  if (response.status !== expected) {
    if (response.ok) throw new HostResponseInvalidError(response.status);

    const problem = safeProblem(response, body);
    if (problem !== null && response.status !== 408 && response.status < 500) {
      const rejected = new HostRejectedError(response.status, problem);
      if (isRecord(body)) rejected.existingHost = body.host;
      throw rejected;
    }
    throw new HostUnavailableError(response.status, problem);
  }

  if (responseMediaType(response) !== "application/json") {
    throw new HostResponseInvalidError(response.status);
  }

  return { status: response.status, body };
}

/**
 * @param {number} status
 * @param {unknown} body
 * @param {HostContext} context
 */
function hostResponse(status, body, context) {
  if (!isRecord(body) || !isHost(body.host)) {
    throw new HostResponseInvalidError(status);
  }
  assertEnvironment(status, body, context);
  return { environment: environmentOf(context), host: copyHost(body.host) };
}

/**
 * @param {number} status
 * @param {unknown} body
 * @param {HostContext} context
 * @param {{nullable?: boolean}} [options]
 */
function domainResponse(status, body, context, { nullable = false } = {}) {
  if (
    !isRecord(body) ||
    !(isDomain(body.domain) || (nullable && body.domain === null))
  ) {
    throw new HostResponseInvalidError(status);
  }
  assertEnvironment(status, body, context);
  return {
    environment: environmentOf(context),
    domain: body.domain === null ? null : copyDomain(body.domain),
  };
}

/**
 * @param {number} status
 * @param {Record<string, unknown>} body
 * @param {HostContext} context
 */
function assertEnvironment(status, body, { projectId, environment }) {
  const value = body.environment;
  if (
    !isRecord(value) ||
    value.project_id !== projectId ||
    value.name !== environment
  ) {
    throw new HostResponseInvalidError(status);
  }
}

/** @param {HostContext} context */
function environmentOf({ projectId, environment }) {
  return { project_id: projectId, name: environment };
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isHost(value) {
  if (!isRecord(value)) return false;

  const failure = value.failure;
  const release = value.release;
  return (
    typeof value.state === "string" &&
    HOST_STATES.has(value.state) &&
    isSlug(value.region) &&
    isSlug(value.size) &&
    (value.ipv4 === null ||
      (typeof value.ipv4 === "string" && IPV4_PATTERN.test(value.ipv4))) &&
    (value.state !== "ready" || value.ipv4 !== null) &&
    typeof value.ssh_user === "string" &&
    /^[a-z_][a-z0-9_-]{0,31}$/.test(value.ssh_user) &&
    typeof value.ssh_key_fingerprint === "string" &&
    value.ssh_key_fingerprint.startsWith("SHA256:") &&
    isTimestamp(value.created_at) &&
    (value.ready_at === null || isTimestamp(value.ready_at)) &&
    (value.state === "failed"
      ? isRecord(failure) &&
        typeof failure.code === "string" &&
        typeof failure.detail === "string"
      : failure === null) &&
    isRecord(release) &&
    typeof release.state === "string" &&
    RELEASE_STATES.has(release.state) &&
    (release.version === null ||
      (typeof release.version === "string" &&
        SHA_PATTERN.test(release.version))) &&
    (release.state !== "live" || release.version !== null) &&
    (release.changed_at === null || isTimestamp(release.changed_at))
  );
}

/**
 * @param {Record<string, unknown>} host
 * @returns {HostRecord}
 */
function copyHost(host) {
  const failure = /** @type {Record<string, unknown> | null} */ (host.failure);
  const release = /** @type {Record<string, unknown>} */ (host.release);
  return /** @type {HostRecord} */ ({
    state: host.state,
    region: host.region,
    size: host.size,
    ipv4: host.ipv4,
    ssh_user: host.ssh_user,
    ssh_key_fingerprint: host.ssh_key_fingerprint,
    created_at: host.created_at,
    ready_at: host.ready_at,
    failure:
      failure === null ? null : { code: failure.code, detail: failure.detail },
    release: {
      state: release.state,
      version: release.version,
      changed_at: release.changed_at,
    },
  });
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isDomain(value) {
  return (
    isRecord(value) &&
    isHostname(value.hostname) &&
    typeof value.state === "string" &&
    DOMAIN_STATES.has(value.state) &&
    (value.checked_at === null || isTimestamp(value.checked_at)) &&
    Array.isArray(value.records) &&
    value.records.every(isRecordRow)
  );
}

/** @param {unknown} value */
function isRecordRow(value) {
  return (
    isRecord(value) &&
    typeof value.purpose === "string" &&
    typeof value.type === "string" &&
    /^[A-Z]{1,10}$/.test(value.type) &&
    typeof value.name === "string" &&
    typeof value.value === "string" &&
    typeof value.required === "boolean" &&
    typeof value.status === "string" &&
    RECORD_STATUSES.has(value.status) &&
    Array.isArray(value.found) &&
    value.found.every((found) => typeof found === "string")
  );
}

/**
 * @param {Record<string, unknown>} domain
 * @returns {DomainRecord}
 */
function copyDomain(domain) {
  return /** @type {DomainRecord} */ ({
    hostname: domain.hostname,
    state: domain.state,
    checked_at: domain.checked_at,
    records: /** @type {Record<string, unknown>[]} */ (domain.records).map(
      (row) => ({
        purpose: row.purpose,
        type: row.type,
        name: row.name,
        value: row.value,
        required: row.required,
        status: row.status,
        found: [.../** @type {string[]} */ (row.found)],
      }),
    ),
  });
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isEmail(value) {
  if (!isRecord(value)) return false;

  const allowance = value.allowance;
  return (
    typeof value.state === "string" &&
    EMAIL_STATES.has(value.state) &&
    (value.sending_domain === null || isHostname(value.sending_domain)) &&
    (value.paused_reason === null ||
      (typeof value.paused_reason === "string" &&
        PAUSED_REASONS.has(value.paused_reason))) &&
    (value.state === "paused") === (value.paused_reason !== null) &&
    isRecord(allowance) &&
    isCount(allowance.limit) &&
    isCount(allowance.used) &&
    typeof allowance.period_start === "string" &&
    DATE_PATTERN.test(allowance.period_start) &&
    isTimestamp(allowance.resets_at) &&
    (value.smtp === null || isSmtp(value.smtp))
  );
}

/** @param {Record<string, unknown>} email */
function copyEmail(email) {
  const allowance = /** @type {Record<string, unknown>} */ (email.allowance);
  return {
    state: email.state,
    sending_domain: email.sending_domain,
    paused_reason: email.paused_reason,
    allowance: {
      limit: allowance.limit,
      used: allowance.used,
      period_start: allowance.period_start,
      resets_at: allowance.resets_at,
    },
    smtp:
      email.smtp === null
        ? null
        : copySmtp(/** @type {Record<string, unknown>} */ (email.smtp)),
  };
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isSmtp(value) {
  return (
    isRecord(value) &&
    isHostname(value.host) &&
    Number.isSafeInteger(value.port) &&
    Number(value.port) > 0 &&
    Number(value.port) < 65_536 &&
    typeof value.username === "string" &&
    value.username.length > 0 &&
    isRecord(value.headers) &&
    Object.entries(value.headers).every(
      ([name, header]) =>
        /^[A-Za-z0-9-]{1,64}$/.test(name) && typeof header === "string",
    )
  );
}

/**
 * @param {Record<string, unknown>} smtp
 * @returns {SmtpRecord}
 */
function copySmtp(smtp) {
  return /** @type {SmtpRecord} */ ({
    host: smtp.host,
    port: smtp.port,
    username: smtp.username,
    headers: { .../** @type {Record<string, string>} */ (smtp.headers) },
  });
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isBackups(value) {
  if (!isRecord(value)) return false;

  const latest = value.latest;
  const restore = value.latest_restore_check;
  return (
    typeof value.schedule === "string" &&
    isCount(value.retention_days) &&
    (latest === null ||
      (isRecord(latest) &&
        isTimestamp(latest.taken_at) &&
        isCount(latest.database_bytes) &&
        isCount(latest.uploads_bytes) &&
        typeof latest.state === "string" &&
        BACKUP_STATES.has(latest.state))) &&
    (value.checked_at === null || isTimestamp(value.checked_at)) &&
    (restore === null ||
      (isRecord(restore) &&
        typeof restore.state === "string" &&
        RESTORE_CHECK_STATES.has(restore.state) &&
        isTimestamp(restore.checked_at) &&
        isTimestamp(restore.backup_taken_at) &&
        typeof restore.detail === "string"))
  );
}

/** @param {Record<string, unknown>} backups */
function copyBackups(backups) {
  const latest = /** @type {Record<string, unknown> | null} */ (backups.latest);
  const restore = /** @type {Record<string, unknown> | null} */ (
    backups.latest_restore_check
  );
  return {
    schedule: backups.schedule,
    retention_days: backups.retention_days,
    latest:
      latest === null
        ? null
        : {
            taken_at: latest.taken_at,
            database_bytes: latest.database_bytes,
            uploads_bytes: latest.uploads_bytes,
            state: latest.state,
          },
    checked_at: backups.checked_at,
    latest_restore_check:
      restore === null
        ? null
        : {
            state: restore.state,
            checked_at: restore.checked_at,
            backup_taken_at: restore.backup_taken_at,
            detail: restore.detail,
          },
  };
}

/** @param {Response} response @param {unknown} body */
function safeProblem(response, body) {
  if (!isRecord(body) || !isProblemBody(response, body)) return null;

  return {
    ...(body.type === "about:blank" ? { type: body.type } : {}),
    title: body.title,
    status: body.status,
    code: body.code,
    detail: body.detail,
  };
}

/** @param {unknown} value */
function isCount(value) {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

/** @param {unknown} value */
function isTimestamp(value) {
  return (
    typeof value === "string" &&
    TIMESTAMP_PATTERN.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
