import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

import { isAuthenticationProblem } from "../api-authentication.js";
import {
  GithubCommandError,
  SshCommandError,
  ToolUnavailableError,
  generateHostKey,
  github,
  hostKeyDirectory,
  readHostKey,
  readPrivateKey,
  removeHostKey,
  runTool,
  ssh,
} from "../host-tools.js";
import {
  DEFAULT_ENVIRONMENT,
  HostRejectedError,
  HostResponseInvalidError,
  HostUnavailableError,
  checkDomain,
  connectDomain,
  createHost,
  createSmtpCredentials,
  defaultHostname,
  destroyHost,
  disconnectDomain,
  isEnvironmentName,
  isHostname,
  isSlug,
  readBackups,
  readDomain,
  readEmail,
  readHost,
  resizeHost,
} from "./host.js";

const WAIT_MS = 5 * 60_000;
const HOST_POLL_MS = 5_000;
const SETUP_POLL_MS = 10_000;
const UP_TIMEOUT_MS = 10_000;
const DEPLOY_FILES = ["config/deploy.yml", ".github/workflows/ci.yml"];
// The deploy job stream H's prototype runs after every check on main.
const DEPLOY_JOB = "deploy";
const BUSY_STATES = new Set(["provisioning", "resizing", "destroying"]);

const ENVIRONMENT_HELP = `Environment:
  FIRSTDRAFT_API_TOKEN          Authenticate production or custom API origins
  FIRSTDRAFT_STAGING_API_TOKEN  Authenticate staging.firstdraft.com
`;
const COMMON_OPTIONS = `      --environment <name>  Deployed Environment (default: production)
      --staging             Use staging; reject a different saved origin
  -h, --help                Show help`;

export const HOST_HELP = `First Draft CLI

Usage:
  firstdraft host <command> [options]

Commands:
  create   Create the app's Droplet and connect its repository
  status   Show the host, its release, and what stands in the way
  resize   Change the Droplet's size
  destroy  Remove the Droplet
  domain   Connect and check the app's own domain
  email    Show email state and store SMTP credentials

Options:
  -h, --help  Show help

Run host commands from the application's root. They use gh, logged in to
GitHub with access to the application's repository; create also uses
ssh-keygen and ssh. A push to the default branch whose checks all pass
deploys; no host command deploys.
`;

const HOST_CREATE_HELP = `First Draft CLI

Usage:
  firstdraft host create [--region <slug>] [--size <slug>]

Options:
      --region <slug>       DigitalOcean region (default: nyc1)
      --size <slug>         Droplet size (default: s-1vcpu-1gb)
${COMMON_OPTIONS}

${ENVIRONMENT_HELP}
The command generates this host's SSH key on this computer, asks First Draft
to create the Droplet, and stores the key and the app's generated secrets as
GitHub Actions secrets with gh. Once the Droplet has finished setting itself
up, it sets the DEPLOY_HOST and APP_HOST repository variables, so the next
push whose checks all pass deploys. It waits at most five minutes; run it
again to continue. It prints no secret.
`;

const HOST_STATUS_HELP = `First Draft CLI

Usage:
  firstdraft host status [--wait]

Options:
      --wait                Wait while the host or a deploy is busy (5 min)
${COMMON_OPTIONS}

${ENVIRONMENT_HELP}
The command prints the host, its backups and domain, the newest CI run on the
default branch, whether /up answers, and next: what stands between the owner
and a live app.
`;

const HOST_RESIZE_HELP = `First Draft CLI

Usage:
  firstdraft host resize --size <slug> --yes

Options:
      --size <slug>         The new Droplet size
      --yes                 Confirm: the app is down while it resizes
${COMMON_OPTIONS}

${ENVIRONMENT_HELP}
Ask the owner before passing --yes. The Droplet powers off, changes CPU and
memory, and powers on; its disk keeps its size.
`;

const HOST_DESTROY_HELP = `First Draft CLI

Usage:
  firstdraft host destroy --confirm <environment>

Options:
      --confirm <environment>  The Environment's name, to confirm
${COMMON_OPTIONS}

${ENVIRONMENT_HELP}
Ask the owner first. First Draft removes the Droplet; its off-server backups
are kept for their retention period. The CLI then deletes the DEPLOY_HOST
and APP_HOST variables and the SSH_PRIVATE_KEY secret, and this computer's
key for the host.
`;

const HOST_DOMAIN_HELP = `First Draft CLI

Usage:
  firstdraft host domain [options]
  firstdraft host domain connect <hostname> [options]
  firstdraft host domain check [options]
  firstdraft host domain disconnect [options]

Options:
${COMMON_OPTIONS}

${ENVIRONMENT_HELP}
Without a command, it prints the last check of the connected domain. connect
returns the DNS records to create at the owner's DNS provider. check checks
them now; once the app record is right, it sets APP_HOST to the domain, and
the next deploy serves it. disconnect removes the domain and sets APP_HOST
back to the Droplet's own name.
`;

const HOST_EMAIL_HELP = `First Draft CLI

Usage:
  firstdraft host email [options]
  firstdraft host email connect [options]

Options:
${COMMON_OPTIONS}

${ENVIRONMENT_HELP}
Without a command, it prints whether the app can send email and how much of
the month's allowance it has used. connect asks First Draft for new SMTP
credentials, revoking the earlier ones, and stores them with gh: the password
as the SMTP_PASSWORD secret, the rest as variables. It prints no password.
`;

const HELP = new Map([
  ["create", HOST_CREATE_HELP],
  ["status", HOST_STATUS_HELP],
  ["resize", HOST_RESIZE_HELP],
  ["destroy", HOST_DESTROY_HELP],
  ["domain", HOST_DOMAIN_HELP],
  ["email", HOST_EMAIL_HELP],
]);

const DETAILS = {
  invalidArguments: (/** @type {string} */ command) =>
    `Invalid arguments. Run 'firstdraft host ${command} --help' for usage.`,
  deployFilesMissing:
    "This application has no Kamal deploy files, so it was compiled for another host. Nothing was sent.",
  rejected:
    "First Draft rejected the request; response.code says why. host_not_found means the Environment has no host yet: run 'firstdraft host create'. host_busy means another operation is still running: run 'firstdraft host status --wait'. hosting_not_allowed means this account cannot hold another host yet.",
  unavailable:
    "Could not complete the request or confirm its result. A read is safe to retry. After create, resize, destroy, or a domain or email change, run 'firstdraft host status' before repeating it.",
  invalidResponse:
    "First Draft returned an invalid hosting response. Retrying unchanged will not repair this protocol mismatch; run 'firstdraft host status' to see the host.",
  toolUnavailable: (/** @type {string} */ tool) =>
    `The ${tool} program is not installed or not on PATH. Ask the person to install ${tool === "gh" ? "GitHub's gh and run 'gh auth login'" : "the OpenSSH client"}, then run the command again.`,
  githubFailed:
    "A gh command failed; message is its first line of output. Check that gh is logged in ('gh auth status') with access to this repository, then run the command again: every step it completed is skipped.",
  sshFailed:
    "ssh could not run the command on the host; message says why. A changed host key means the Droplet is not the one this computer first reached: stop and tell the owner.",
  hostKeyMissing:
    "This Environment's host trusts an SSH key that this computer does not have. Run host commands from the computer that created the host, or copy its key directory (key_directory) here.",
  hostFailed:
    "First Draft could not create or change the Droplet; host.failure says why. Tell the owner; do not run create again until First Draft has looked.",
  setupFailed:
    "The Droplet's first-boot setup (cloud-init) reported an error, so the repository was not connected to it. Tell the owner.",
  confirmResize:
    "Resizing takes the app down and can change the bill. Ask the owner, then pass --yes. Nothing was sent.",
  confirmDestroy: (/** @type {string} */ environment) =>
    `Destroying removes the Droplet and its data. Ask the owner, suggest a database export first, then pass --confirm ${environment}. Nothing was sent.`,
};

/**
 * @typedef {object} HostShared
 * @property {(staging: boolean | undefined) => {apiUrl: string, projectId: string, fetchFunction: typeof globalThis.fetch} | null} authenticate
 * @property {(writer: {write(text: string): unknown}, error: unknown) => number | null} writeSharedError
 * @property {(writer: {write(text: string): unknown}, status?: number, response?: Record<string, unknown>) => void} writeAuthenticationRequired
 * @property {<T>(promise: Promise<T>) => Promise<T>} settle
 */

/**
 * @typedef {object} HostOptions
 * @property {readonly string[]} argv
 * @property {{write(text: string): unknown}} stdout
 * @property {{write(text: string): unknown}} stderr
 * @property {string} cwd
 * @property {import("../credentials.js").CredentialStore} credentials
 * @property {typeof globalThis.fetch} [fetchFunction] unwrapped, for /up
 * @property {(timeoutMs: number) => AbortSignal} [createRequestSignal]
 * @property {import("../host-tools.js").ToolRunner} [hostTools]
 * @property {(ms: number) => Promise<void>} [hostSleep]
 * @property {() => number} [hostNow]
 * @property {HostShared} shared
 */

/** @param {HostOptions} options */
export async function runHost(options) {
  const [command, ...argv] = options.argv;
  if (command === undefined || command === "--help" || command === "-h") {
    options.stdout.write(HOST_HELP);
    return 0;
  }
  if (!HELP.has(command)) {
    writeJson(options.stderr, {
      error: "invalid_arguments",
      detail: "Invalid arguments. Run 'firstdraft host --help' for usage.",
    });
    return 2;
  }

  const sub =
    (command === "domain" || command === "email") &&
    argv[0] !== undefined &&
    !argv[0].startsWith("-")
      ? argv[0]
      : undefined;
  const parsed = parseCommand(command, sub, sub ? argv.slice(1) : argv);
  if (parsed === null) {
    writeJson(options.stderr, {
      error: "invalid_arguments",
      detail: DETAILS.invalidArguments(command),
    });
    return 2;
  }
  if (parsed.help) {
    options.stdout.write(/** @type {string} */ (HELP.get(command)));
    return 0;
  }

  if (command === "resize" && parsed.values.yes !== true) {
    writeJson(options.stderr, {
      error: "confirmation_required",
      detail: DETAILS.confirmResize,
    });
    return 2;
  }
  if (command === "destroy" && parsed.values.confirm !== parsed.environment) {
    writeJson(options.stderr, {
      error: "confirmation_required",
      detail: DETAILS.confirmDestroy(parsed.environment),
    });
    return 2;
  }
  if (command === "create") {
    const missing = DEPLOY_FILES.filter(
      (file) => !existsSync(path.join(options.cwd, file)),
    );
    const workflow = path.join(options.cwd, DEPLOY_FILES[1] ?? "");
    if (
      missing.length === 0 &&
      !/^ {2}deploy:/m.test(readFileSync(workflow, "utf8"))
    ) {
      missing.push(`${DEPLOY_FILES[1]} job ${DEPLOY_JOB}`);
    }
    if (missing.length > 0) {
      writeJson(options.stderr, {
        error: "deploy_files_missing",
        detail: DETAILS.deployFilesMissing,
        missing,
      });
      return 1;
    }
  }

  try {
    const authentication = options.shared.authenticate(
      parsed.values.staging === true,
    );
    if (authentication === null) {
      options.shared.writeAuthenticationRequired(options.stderr);
      return 1;
    }
    const context = {
      ...authentication,
      environment: parsed.environment,
      createRequestSignal: options.createRequestSignal,
    };
    const result = await options.shared.settle(
      dispatch(command, sub, parsed, context, options),
    );
    writeJson(options.stdout, result);
    return 0;
  } catch (error) {
    return writeHostError(options, error);
  }
}

/**
 * @param {string} command
 * @param {string | undefined} sub
 * @param {readonly string[]} argv
 */
function parseCommand(command, sub, argv) {
  /** @type {Record<string, {type: "string" | "boolean", short?: string}>} */
  const flags = {
    environment: { type: "string" },
    staging: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  };
  if (command === "create") {
    flags.region = { type: "string" };
    flags.size = { type: "string" };
  }
  if (command === "status") flags.wait = { type: "boolean" };
  if (command === "resize") {
    flags.size = { type: "string" };
    flags.yes = { type: "boolean" };
  }
  if (command === "destroy") flags.confirm = { type: "string" };

  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: flags,
      allowPositionals: true,
      strict: true,
      tokens: true,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      String(error.code).startsWith("ERR_PARSE_ARGS_")
    ) {
      return null;
    }
    throw error;
  }

  const names = parsed.tokens
    .filter((token) => token.kind === "option" && token.name !== "help")
    .map((token) => (token.kind === "option" ? token.name : ""));
  if (new Set(names).size !== names.length) return null;

  const values = /** @type {Record<string, string | boolean | undefined>} */ (
    parsed.values
  );
  if (values.help)
    return { help: true, values, environment: "", positionals: [] };

  const environment = values.environment ?? DEFAULT_ENVIRONMENT;
  if (!isEnvironmentName(environment)) return null;
  for (const slug of [values.region, values.size]) {
    if (slug !== undefined && !isSlug(slug)) return null;
  }
  if (command === "resize" && values.size === undefined) return null;

  const positionals = parsed.positionals;
  const expected = command === "domain" && sub === "connect" ? 1 : 0;
  if (positionals.length !== expected) return null;
  if (
    command === "domain" &&
    !["connect", "check", "disconnect", undefined].includes(sub)
  ) {
    return null;
  }
  if (command === "email" && !["connect", undefined].includes(sub)) return null;
  if (
    sub === "connect" &&
    command === "domain" &&
    !isHostname(positionals[0])
  ) {
    return null;
  }

  return { help: false, values, environment, positionals };
}

/**
 * @typedef {{help: boolean, values: Record<string, string | boolean | undefined>, environment: string, positionals: string[]}} ParsedCommand
 * @typedef {import("./host.js").HostContext} HostContext
 */

/**
 * @param {string} command
 * @param {string | undefined} sub
 * @param {ParsedCommand} parsed
 * @param {HostContext} context
 * @param {HostOptions} options
 */
async function dispatch(command, sub, parsed, context, options) {
  const tools = options.hostTools ?? runTool;
  if (command === "create") return create(parsed, context, options, tools);
  if (command === "status") return status(parsed, context, options, tools);
  if (command === "resize") {
    const result = await resizeHost({
      ...context,
      size: /** @type {string} */ (parsed.values.size),
    });
    return {
      ...result,
      next: "The app is down while the Droplet resizes. Run 'firstdraft host status --wait' until host.state is ready.",
    };
  }
  if (command === "destroy") return destroy(context, options, tools);
  if (command === "domain") return domain(sub, parsed, context, options, tools);
  return email(sub, context, options, tools);
}

/**
 * @param {ParsedCommand} parsed
 * @param {HostContext} context
 * @param {HostOptions} options
 * @param {import("../host-tools.js").ToolRunner} tools
 */
async function create(parsed, context, options, tools) {
  const now = options.hostNow ?? Date.now;
  const sleep = options.hostSleep ?? delay;
  const deadline = now() + WAIT_MS;
  const gh = github(tools, options.cwd);
  const { repository, defaultBranch } = gh.repository();
  const keyDirectory = hostKeyDirectory(
    options.credentials,
    context.projectId,
    context.environment,
  );

  let key = readHostKey(keyDirectory);
  let response = await readExistingHost(context);
  if (response === null) {
    key ??= generateHostKey(
      tools,
      keyDirectory,
      `firstdraft-${context.environment}-${repository}`,
    );
    response = await createHost({
      ...context,
      region: /** @type {string | undefined} */ (parsed.values.region),
      size: /** @type {string | undefined} */ (parsed.values.size),
      sshPublicKey: key.publicKey,
    });
  }
  if (key === null || key.fingerprint !== response.host.ssh_key_fingerprint) {
    throw new HostKeyMissingError(keyDirectory);
  }

  // The deploy job logs in with the same key the Droplet trusts.
  const existing = new Set(gh.secretNames());
  gh.setSecret("SSH_PRIVATE_KEY", readPrivateKey(keyDirectory));
  /** @type {string[]} */
  const secrets = ["SSH_PRIVATE_KEY"];
  for (const [name, bytes] of /** @type {const} */ ([
    ["SECRET_KEY_BASE", 64],
    // Hex keeps it safe inside DATABASE_URL.
    ["POSTGRES_PASSWORD", 24],
  ])) {
    if (!existing.has(name))
      gh.setSecret(name, randomBytes(bytes).toString("hex"));
    secrets.push(name);
  }

  let host = response.host;
  let progress = host.state;
  while (BUSY_STATES.has(host.state) && now() < deadline) {
    await sleep(HOST_POLL_MS);
    host = (await readHost(context)).host;
    if (host.state !== progress) {
      progress = host.state;
      options.stderr.write(`First Draft: the host is ${host.state}.\n`);
    }
  }
  if (host.state === "failed") throw new HostFailedError(host);

  /** @type {"provisioning" | "setting_up" | "connected"} */
  let step = host.state === "ready" ? "setting_up" : "provisioning";
  const variables = gh.variables();
  if (step === "setting_up" && host.ipv4 !== null) {
    const ipv4 = host.ipv4;
    // The deploy job is skipped until DEPLOY_HOST is set, so no deploy
    // races the Droplet's first-boot setup.
    if (variables.get("DEPLOY_HOST") !== ipv4) {
      while (step === "setting_up") {
        const setup = setupState(tools, key, host, options.cwd);
        if (setup === "error") throw new HostSetupFailedError();
        if (setup === "done") step = "connected";
        else if (now() >= deadline) break;
        else {
          options.stderr.write(
            "First Draft: the Droplet is still setting itself up.\n",
          );
          await sleep(SETUP_POLL_MS);
        }
      }
      if (step === "connected") {
        if (!variables.has("APP_HOST")) {
          gh.setVariable("APP_HOST", defaultHostname(ipv4));
          variables.set("APP_HOST", defaultHostname(ipv4));
        }
        gh.setVariable("DEPLOY_HOST", ipv4);
        variables.set("DEPLOY_HOST", ipv4);
      }
    } else {
      step = "connected";
    }
  }

  const checks = step === "connected" ? readChecks(gh, defaultBranch) : null;
  const appHost = variables.get("APP_HOST") ?? null;
  return {
    environment: response.environment,
    host,
    step,
    url: appHost === null ? null : `https://${appHost}`,
    github: {
      repository,
      secrets,
      variables: ["DEPLOY_HOST", "APP_HOST"].filter((name) =>
        variables.has(name),
      ),
    },
    checks,
    key_directory: keyDirectory,
    next: nextStep({
      host,
      step,
      checks,
      up: null,
      defaultBranch,
      command: "create",
    }),
  };
}

/**
 * @param {ParsedCommand} parsed
 * @param {HostContext} context
 * @param {HostOptions} options
 * @param {import("../host-tools.js").ToolRunner} tools
 */
async function status(parsed, context, options, tools) {
  const now = options.hostNow ?? Date.now;
  const sleep = options.hostSleep ?? delay;
  const deadline = now() + WAIT_MS;
  const gh = github(tools, options.cwd);
  const { defaultBranch } = gh.repository();

  for (;;) {
    const response = await readExistingHost(context);
    if (response === null) {
      return {
        environment: {
          project_id: context.projectId,
          name: context.environment,
        },
        host: null,
        next: "This Environment has no host. Run 'firstdraft host create' after the owner agrees to pay for one.",
      };
    }
    const { host } = response;
    const variables = gh.variables();
    const step =
      host.state === "provisioning"
        ? "provisioning"
        : variables.get("DEPLOY_HOST") === host.ipv4
          ? "connected"
          : "setting_up";
    const ready = host.state === "ready";
    const backups = ready ? (await readBackups(context)).backups : null;
    const domain = ready ? await readOptionalDomain(context) : null;
    const checks = step === "connected" ? readChecks(gh, defaultBranch) : null;
    const appHost = variables.get("APP_HOST") ?? null;
    const up =
      ready && appHost !== null
        ? await probe(options.fetchFunction ?? globalThis.fetch, appHost)
        : null;
    const result = {
      environment: response.environment,
      host,
      step,
      url: appHost === null ? null : `https://${appHost}`,
      up,
      backups,
      domain,
      checks,
      next: nextStep({
        host,
        step,
        checks,
        up,
        defaultBranch,
        command: "status",
      }),
    };

    const busy =
      BUSY_STATES.has(host.state) ||
      checks?.run?.status === "in_progress" ||
      checks?.run?.status === "queued";
    if (!parsed.values.wait || !busy || now() >= deadline) return result;
    await sleep(SETUP_POLL_MS);
  }
}

/**
 * @param {HostContext} context
 * @param {HostOptions} options
 * @param {import("../host-tools.js").ToolRunner} tools
 */
async function destroy(context, options, tools) {
  const gh = github(tools, options.cwd);
  gh.repository();
  const result = await destroyHost({
    ...context,
    confirm: context.environment,
  });

  // The Droplet is going, so the repository stops deploying to it and this
  // computer forgets its key. Each step is attempted, and what is left is
  // named, because the destroy itself has already been accepted.
  /** @type {string[]} */
  const deleted = [];
  /** @type {string[]} */
  const left = [];
  const variables = gh.variables();
  const secrets = new Set(gh.secretNames());
  for (const [kind, name] of /** @type {const} */ ([
    ["variable", "DEPLOY_HOST"],
    ["variable", "APP_HOST"],
    ["secret", "SSH_PRIVATE_KEY"],
  ])) {
    const present =
      kind === "variable" ? variables.has(name) : secrets.has(name);
    if (!present) continue;
    try {
      if (kind === "variable") gh.deleteVariable(name);
      else gh.deleteSecret(name);
      deleted.push(name);
    } catch (error) {
      if (!(error instanceof GithubCommandError)) throw error;
      left.push(name);
    }
  }
  const keyDirectory = hostKeyDirectory(
    options.credentials,
    context.projectId,
    context.environment,
  );
  removeHostKey(keyDirectory);

  return {
    ...result,
    github: { deleted, left },
    key_directory_removed: keyDirectory,
    next:
      left.length === 0
        ? "First Draft is removing the Droplet. Run 'firstdraft host status' until it reports no host."
        : `First Draft is removing the Droplet. gh could not delete ${left.join(", ")}; delete them with 'gh variable delete' or 'gh secret delete'.`,
  };
}

/**
 * @param {string | undefined} sub
 * @param {ParsedCommand} parsed
 * @param {HostContext} context
 * @param {HostOptions} options
 * @param {import("../host-tools.js").ToolRunner} tools
 */
async function domain(sub, parsed, context, options, tools) {
  if (sub === undefined) {
    const result = await readDomain(context);
    return { ...result, next: domainNext(result.domain, false) };
  }
  if (sub === "connect") {
    const result = await connectDomain({
      ...context,
      hostname: /** @type {string} */ (parsed.positionals[0]),
    });
    return {
      ...result,
      next: "Ask the owner to create each record in records at their DNS provider, then run 'firstdraft host domain check'. DNS changes can take hours to appear.",
    };
  }

  const gh = github(tools, options.cwd);
  if (sub === "disconnect") {
    const { host } = await readHost(context);
    const result = await disconnectDomain(context);
    const variables = gh.variables();
    const fallback = host.ipv4 === null ? null : defaultHostname(host.ipv4);
    const changed = fallback !== null && variables.get("APP_HOST") !== fallback;
    if (changed) gh.setVariable("APP_HOST", fallback);
    return {
      ...result,
      app_host: variables.get("APP_HOST") ?? null,
      app_host_now: changed ? fallback : (variables.get("APP_HOST") ?? null),
      next: changed
        ? "APP_HOST is the Droplet's own name again; the next deploy stops serving the domain. Remove its DNS records at the DNS provider."
        : "The domain is disconnected. Remove its DNS records at the DNS provider.",
    };
  }

  const result = await checkDomain(context);
  const appRecordOk =
    result.domain !== null &&
    result.domain.records.some(
      (row) => row.purpose === "app" && row.status === "ok",
    );
  let switched = false;
  if (appRecordOk && result.domain !== null) {
    const variables = gh.variables();
    if (variables.get("APP_HOST") !== result.domain.hostname) {
      gh.setVariable("APP_HOST", result.domain.hostname);
      switched = true;
    }
  }
  return {
    ...result,
    app_host_changed: switched,
    next: domainNext(result.domain, switched),
  };
}

/**
 * @param {string | undefined} sub
 * @param {HostContext} context
 * @param {HostOptions} options
 * @param {import("../host-tools.js").ToolRunner} tools
 */
async function email(sub, context, options, tools) {
  if (sub === undefined) {
    const result = await readEmail(context);
    return { ...result, next: emailNext(result.email.state) };
  }

  const gh = github(tools, options.cwd);
  gh.repository();
  const { environment, smtp, password } = await createSmtpCredentials(context);
  gh.setSecret("SMTP_PASSWORD", password);
  gh.setVariable("SMTP_ADDRESS", String(smtp.host));
  gh.setVariable("SMTP_PORT", String(smtp.port));
  gh.setVariable("SMTP_USERNAME", String(smtp.username));
  gh.setVariable("SMTP_HEADERS", JSON.stringify(smtp.headers));
  return {
    environment,
    smtp,
    github: {
      secrets: ["SMTP_PASSWORD"],
      variables: ["SMTP_ADDRESS", "SMTP_PORT", "SMTP_USERNAME", "SMTP_HEADERS"],
    },
    next: "The earlier SMTP password no longer works. The app sends email after the next deploy: push to the default branch, or rerun its newest CI run with 'gh run rerun <id>'.",
  };
}

/** @param {HostContext} context */
async function readExistingHost(context) {
  try {
    return await readHost(context);
  } catch (error) {
    if (
      error instanceof HostRejectedError &&
      error.status === 404 &&
      error.response.code === "host_not_found"
    ) {
      return null;
    }
    throw error;
  }
}

/** @param {HostContext} context */
async function readOptionalDomain(context) {
  try {
    return (await readDomain(context)).domain;
  } catch (error) {
    if (
      error instanceof HostRejectedError &&
      error.status === 404 &&
      error.response.code === "domain_not_found"
    ) {
      return null;
    }
    throw error;
  }
}

/**
 * Reads cloud-init's state on the Droplet: `done`, `running`, or `error`.
 * A Droplet that does not answer yet is still `running`.
 *
 * @param {import("../host-tools.js").ToolRunner} tools
 * @param {{privateKey: string, knownHosts: string}} key
 * @param {{ssh_user: unknown, ipv4: unknown}} host
 * @param {string} cwd
 */
function setupState(tools, key, host, cwd) {
  const result = ssh(
    tools,
    key,
    { user: String(host.ssh_user), ipv4: String(host.ipv4) },
    "cloud-init status",
    cwd,
  );
  // ssh exits 255 for its own failures, such as a Droplet still booting.
  if (result.status === 255) {
    if (/host key/i.test(result.stderr)) throw new SshCommandError(result);
    return "running";
  }
  const match = /^status:\s*(\w+)/m.exec(result.stdout);
  if (match?.[1] === "done") return "done";
  if (match?.[1] === "error") return "error";
  return "running";
}

/**
 * @param {ReturnType<typeof github>} gh
 * @param {string} branch
 */
function readChecks(gh, branch) {
  const run = gh.latestRun(branch);
  if (run === null) return { branch, run: null, failed_jobs: [], deploy: null };

  const deploy = run.jobs.find((job) => job.name === DEPLOY_JOB) ?? null;
  return {
    branch,
    run: {
      id: run.id,
      url: run.url,
      head_sha: run.head_sha,
      status: run.status,
      conclusion: run.conclusion,
    },
    failed_jobs: run.jobs
      .filter(
        (job) =>
          job.name !== DEPLOY_JOB &&
          ["failure", "timed_out", "cancelled"].includes(job.conclusion),
      )
      .map((job) => job.name),
    deploy:
      deploy === null
        ? null
        : { status: deploy.status, conclusion: deploy.conclusion },
  };
}

/**
 * @param {typeof globalThis.fetch} fetchFunction
 * @param {string} hostname
 */
async function probe(fetchFunction, hostname) {
  // A plain request to the app itself: no First Draft token or header.
  try {
    const response = await fetchFunction(`https://${hostname}/up`, {
      redirect: "manual",
      signal: AbortSignal.timeout(UP_TIMEOUT_MS),
    });
    return { hostname, status: response.status, ok: response.status === 200 };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { hostname, status: null, ok: false };
  }
}

/**
 * The one sentence that says what stands between the owner and a live app.
 *
 * @param {{host: Record<string, any>, step: string, checks: ReturnType<typeof readChecks> | null, up: {ok: boolean} | null, defaultBranch: string, command: string}} state
 */
export function nextStep({ host, step, checks, up, defaultBranch, command }) {
  const again = "run 'firstdraft host create' again";
  if (host.state === "failed") {
    return "The host failed; host.failure says why. Tell the owner.";
  }
  if (host.state === "resizing") {
    return "The Droplet is resizing and the app is down. Run 'firstdraft host status --wait'.";
  }
  if (host.state === "destroying") return "The Droplet is being removed.";
  if (step === "provisioning") {
    return `DigitalOcean is still creating the Droplet. In a minute, ${again}; it continues where it stopped.`;
  }
  if (step === "setting_up") {
    return command === "create"
      ? `The Droplet is still setting itself up (about 15 minutes after it starts). In a few minutes, ${again} to connect the repository.`
      : `The repository is not connected to the Droplet yet: ${again}.`;
  }

  const release = host.release?.state;
  const run = checks?.run ?? null;
  const deploy = checks?.deploy ?? null;
  if (release === "live" || deploy?.conclusion === "success") {
    if (up !== null && !up.ok) {
      return "The last deploy succeeded, but /up does not answer. Read the app's log and tell the owner.";
    }
    return "The app is live. Every push to the default branch whose checks all pass deploys it.";
  }
  if (deploy?.conclusion === "failure" || release === "failed") {
    return `The last deploy failed${run ? ` (${run.url})` : ""}. Read the deploy job's log, fix the cause, and push; an earlier release, if any, keeps serving.`;
  }
  if (run === null) {
    return `Nothing is deployed yet. Push to ${defaultBranch}: when every check passes, that push deploys.`;
  }
  if (run.status !== "completed") {
    return `CI is running on ${defaultBranch}. When every check passes, the deploy job runs; run 'firstdraft host status --wait'.`;
  }
  if (run.conclusion !== "success") {
    const jobs = checks?.failed_jobs.length
      ? ` (${checks.failed_jobs.join(", ")})`
      : "";
    return `Nothing is deployed: CI failed on ${defaultBranch}${jobs}, and the deploy job runs only when every check passes. Write what the README's Behavior to write lists until bin/ci passes, then push to ${defaultBranch}.`;
  }
  return `The checks on ${defaultBranch} passed before the repository was connected, so nothing deployed. Push to ${defaultBranch}, or rerun that run with 'gh run rerun ${run.id}'.`;
}

/**
 * @param {{state: unknown, hostname: unknown, records: {required: unknown, status: unknown}[]} | null} domain
 * @param {boolean} switched
 */
function domainNext(domain, switched) {
  if (domain === null) {
    return "No domain is connected. Run 'firstdraft host domain connect <hostname>' with the owner's domain.";
  }
  if (switched) {
    return `APP_HOST is now ${domain.hostname}. The next deploy serves it and gets its certificate: push to the default branch, or rerun its newest CI run with 'gh run rerun <id>'.`;
  }
  if (domain.state === "connected") {
    return "Every required record is right.";
  }
  return "Some required records are missing or wrong; records says which. Ask the owner to fix them at their DNS provider, then run 'firstdraft host domain check' again. First Draft also rechecks every 10 minutes for 72 hours.";
}

/** @param {unknown} state */
function emailNext(state) {
  if (state === "waiting_for_domain") {
    return "Email starts after a domain is connected: run 'firstdraft host domain connect <hostname>'.";
  }
  if (state === "verifying") {
    return "Amazon SES has not seen the email records yet. Run 'firstdraft host domain check' to see which are missing.";
  }
  if (state === "paused") {
    return "Sending is paused; email.paused_reason says why. Tell the owner.";
  }
  return "Email is ready. If the app has no SMTP credentials yet, run 'firstdraft host email connect'.";
}

class HostKeyMissingError extends Error {
  /** @param {string} keyDirectory */
  constructor(keyDirectory) {
    super("This computer has no key for the host.");
    this.keyDirectory = keyDirectory;
  }
}

class HostFailedError extends Error {
  /** @param {Record<string, unknown>} host */
  constructor(host) {
    super("The host failed.");
    this.host = host;
  }
}

class HostSetupFailedError extends Error {}

/**
 * @param {HostOptions} options
 * @param {unknown} error
 */
function writeHostError(options, error) {
  const { stderr } = options;
  const shared = options.shared.writeSharedError(stderr, error);
  if (shared !== null) return shared;

  if (error instanceof HostRejectedError) {
    if (isAuthenticationProblem(error.status, error.response)) {
      options.shared.writeAuthenticationRequired(
        stderr,
        error.status,
        error.response,
      );
      return 1;
    }
    writeJson(stderr, {
      error: "host_rejected",
      detail: DETAILS.rejected,
      status: error.status,
      response: error.response,
    });
    return 1;
  }
  if (error instanceof HostUnavailableError) {
    writeJson(stderr, {
      error: "host_unavailable",
      detail: DETAILS.unavailable,
      ...(typeof error.status === "number" ? { status: error.status } : {}),
      ...(error.response ? { response: error.response } : {}),
    });
    return 1;
  }
  if (error instanceof HostResponseInvalidError) {
    writeJson(stderr, {
      error: "invalid_host_response",
      detail: DETAILS.invalidResponse,
      status: error.status,
    });
    return 1;
  }
  if (error instanceof ToolUnavailableError) {
    writeJson(stderr, {
      error: "tool_unavailable",
      detail: DETAILS.toolUnavailable(error.tool),
      tool: error.tool,
    });
    return 1;
  }
  if (error instanceof GithubCommandError) {
    writeJson(stderr, {
      error: "github_failed",
      detail: DETAILS.githubFailed,
      command: error.command,
      exit_status: error.exitStatus,
      message: error.reason,
    });
    return 1;
  }
  if (error instanceof SshCommandError) {
    writeJson(stderr, {
      error: "ssh_failed",
      detail: DETAILS.sshFailed,
      exit_status: error.exitStatus,
      message: error.reason,
    });
    return 1;
  }
  if (error instanceof HostKeyMissingError) {
    writeJson(stderr, {
      error: "host_key_missing",
      detail: DETAILS.hostKeyMissing,
      key_directory: error.keyDirectory,
    });
    return 1;
  }
  if (error instanceof HostFailedError) {
    writeJson(stderr, {
      error: "host_failed",
      detail: DETAILS.hostFailed,
      host: error.host,
    });
    return 1;
  }
  if (error instanceof HostSetupFailedError) {
    writeJson(stderr, {
      error: "host_setup_failed",
      detail: DETAILS.setupFailed,
    });
    return 1;
  }
  throw error;
}

/** @param {{write(text: string): unknown}} writer @param {unknown} value */
function writeJson(writer, value) {
  writer.write(`${JSON.stringify(value, null, 2)}\n`);
}
