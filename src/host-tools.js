import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";

import { credentialsPath } from "./credentials.js";

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const TOOL_TIMEOUT_MS = 60_000;
const KEY_FILE = "id_ed25519";
const MESSAGE_LIMIT = 300;

/**
 * @typedef {object} ToolResult
 * @property {number} status
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * Runs one program on the owner's machine. Tests replace it.
 *
 * @typedef {(command: string, args: readonly string[], options: {cwd: string, input?: string, timeoutMs?: number}) => ToolResult} ToolRunner
 */

export class ToolUnavailableError extends Error {
  /** @param {string} tool @param {{cause?: unknown}} [options] */
  constructor(tool, options = {}) {
    super(`${tool} is unavailable.`, options);
    this.tool = tool;
  }
}

export class GithubCommandError extends Error {
  /** @param {string} command @param {ToolResult} result */
  constructor(command, result) {
    super("A gh command failed.");
    this.command = command;
    this.exitStatus = result.status;
    this.reason = firstLine(result.stderr) || firstLine(result.stdout);
  }
}

export class SshCommandError extends Error {
  /** @param {ToolResult} result */
  constructor(result) {
    super("An ssh command failed.");
    this.exitStatus = result.status;
    this.reason = firstLine(result.stderr);
  }
}

/** @type {ToolRunner} */
export function runTool(command, args, { cwd, input, timeoutMs }) {
  const result = spawnSync(command, [...args], {
    cwd,
    input,
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: timeoutMs ?? TOOL_TIMEOUT_MS,
    // Keep gh from opening a pager or prompting.
    env: {
      ...process.env,
      GH_PROMPT_DISABLED: "1",
      GH_PAGER: "",
      NO_COLOR: "1",
    },
  });
  if (result.error !== undefined || result.status === null) {
    throw new ToolUnavailableError(command, { cause: result.error });
  }
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/**
 * The GitHub side of a host, through the owner's own `gh` login.
 *
 * @param {ToolRunner} run
 * @param {string} cwd
 */
export function github(run, cwd) {
  /** @param {string} name @param {readonly string[]} args @param {string} [input] */
  const gh = (name, args, input) => {
    const result = run("gh", args, { cwd, input });
    if (result.status !== 0) throw new GithubCommandError(`gh ${name}`, result);
    return result.stdout;
  };
  /** @param {string} name @param {readonly string[]} args */
  const json = (name, args) => {
    const output = gh(name, args);
    try {
      return JSON.parse(output);
    } catch {
      throw new GithubCommandError(`gh ${name}`, {
        status: 0,
        stdout: "",
        stderr: "gh printed output that is not JSON.",
      });
    }
  };

  return {
    /** @returns {{repository: string, defaultBranch: string}} */
    repository() {
      const value = json("repo view", [
        "repo",
        "view",
        "--json",
        "nameWithOwner,defaultBranchRef",
      ]);
      const repository = value?.nameWithOwner;
      const defaultBranch = value?.defaultBranchRef?.name;
      if (typeof repository !== "string" || typeof defaultBranch !== "string") {
        throw new GithubCommandError("gh repo view", {
          status: 0,
          stdout: "",
          stderr: "gh did not name the repository and its default branch.",
        });
      }
      return { repository, defaultBranch };
    },
    /** @returns {string[]} */
    secretNames() {
      const value = json("secret list", ["secret", "list", "--json", "name"]);
      return Array.isArray(value)
        ? value
            .map((secret) => secret?.name)
            .filter((name) => typeof name === "string")
        : [];
    },
    /** @returns {Map<string, string>} */
    variables() {
      const value = json("variable list", [
        "variable",
        "list",
        "--json",
        "name,value",
      ]);
      return new Map(
        Array.isArray(value)
          ? value
              .filter(
                (variable) =>
                  typeof variable?.name === "string" &&
                  typeof variable?.value === "string",
              )
              .map((variable) => [variable.name, variable.value])
          : [],
      );
    },
    // The value goes through standard input, so it never appears in an
    // argument list that other processes on the machine can read.
    /** @param {string} name @param {string} value */
    setSecret(name, value) {
      gh("secret set", ["secret", "set", name], value);
    },
    /** @param {string} name */
    deleteSecret(name) {
      gh("secret delete", ["secret", "delete", name]);
    },
    /** @param {string} name @param {string} value */
    setVariable(name, value) {
      gh("variable set", ["variable", "set", name, "--body", value]);
    },
    /** @param {string} name */
    deleteVariable(name) {
      gh("variable delete", ["variable", "delete", name]);
    },
    /**
     * The newest CI run from a push to `branch`, with its jobs.
     *
     * @param {string} branch
     * @returns {{id: number, url: string, head_sha: string, status: string, conclusion: string, jobs: {name: string, status: string, conclusion: string}[]} | null}
     */
    latestRun(branch) {
      const runs = json("run list", [
        "run",
        "list",
        "--workflow",
        "ci.yml",
        "--branch",
        branch,
        "--event",
        "push",
        "--limit",
        "1",
        "--json",
        "databaseId,headSha,status,conclusion,url",
      ]);
      const latest = Array.isArray(runs) ? runs[0] : undefined;
      if (latest === undefined) return null;
      if (!Number.isSafeInteger(latest?.databaseId)) {
        throw new GithubCommandError("gh run list", {
          status: 0,
          stdout: "",
          stderr: "gh named a run without an id.",
        });
      }
      const view = json("run view", [
        "run",
        "view",
        String(latest.databaseId),
        "--json",
        "jobs",
      ]);
      const jobs = Array.isArray(view?.jobs) ? view.jobs : [];
      return {
        id: latest.databaseId,
        url: String(latest.url ?? ""),
        head_sha: String(latest.headSha ?? ""),
        status: String(latest.status ?? ""),
        conclusion: String(latest.conclusion ?? ""),
        jobs: jobs.map((/** @type {Record<string, unknown>} */ job) => ({
          name: String(job?.name ?? ""),
          status: String(job?.status ?? ""),
          conclusion: String(job?.conclusion ?? ""),
        })),
      };
    },
  };
}

/**
 * The directory that holds the owner's SSH key for one host, beside the CLI's
 * saved credentials.
 *
 * @param {import("./credentials.js").CredentialStore} store
 * @param {string} projectId
 * @param {string} environment
 */
export function hostKeyDirectory(store, projectId, environment) {
  return path.join(
    path.dirname(credentialsPath(store)),
    "hosts",
    projectId,
    environment,
  );
}

/**
 * The owner's key for one host: its private key path, public line, and
 * fingerprint, or null when this machine has none.
 *
 * @param {string} directory
 */
export function readHostKey(directory) {
  const privateKey = path.join(directory, KEY_FILE);
  const publicKey = `${privateKey}.pub`;
  if (!existsSync(privateKey) || !existsSync(publicKey)) return null;
  if (!statSync(privateKey).isFile()) return null;

  const line = readFileSync(publicKey, "utf8").trim();
  return {
    privateKey,
    knownHosts: path.join(directory, "known_hosts"),
    publicKey: line,
    fingerprint: fingerprint(line),
  };
}

/** @param {string} directory */
export function readPrivateKey(directory) {
  return readFileSync(path.join(directory, KEY_FILE), "utf8");
}

/**
 * Generates an Ed25519 key pair with no passphrase, readable only by the
 * owner, so `ssh` and the deploy job can use it unattended.
 *
 * @param {ToolRunner} run
 * @param {string} directory
 * @param {string} comment
 */
export function generateHostKey(run, directory, comment) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const result = run(
    "ssh-keygen",
    [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-C",
      comment,
      "-f",
      path.join(directory, KEY_FILE),
    ],
    { cwd: directory },
  );
  if (result.status !== 0) throw new SshCommandError(result);

  const key = readHostKey(directory);
  if (key === null) throw new ToolUnavailableError("ssh-keygen");
  return key;
}

/** @param {string} directory */
export function removeHostKey(directory) {
  rmSync(directory, { recursive: true, force: true });
}

/**
 * Runs one command on the host as its SSH user, with only this host's key and
 * known_hosts file. The first connection records the host's key; later ones
 * refuse a different key.
 *
 * @param {ToolRunner} run
 * @param {{privateKey: string, knownHosts: string}} key
 * @param {{user: string, ipv4: string}} host
 * @param {string} remoteCommand
 * @param {string} cwd
 */
export function ssh(run, key, host, remoteCommand, cwd) {
  return run(
    "ssh",
    [
      "-i",
      key.privateKey,
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      `UserKnownHostsFile=${key.knownHosts}`,
      "-o",
      "ConnectTimeout=10",
      `${host.user}@${host.ipv4}`,
      remoteCommand,
    ],
    { cwd, timeoutMs: 30_000 },
  );
}

/**
 * OpenSSH's SHA256 fingerprint of a public key line.
 *
 * @param {string} line
 */
export function fingerprint(line) {
  const blob = line.split(/\s+/)[1] ?? "";
  const digest = createHash("sha256")
    .update(Buffer.from(blob, "base64"))
    .digest("base64")
    .replace(/=+$/, "");
  return `SHA256:${digest}`;
}

/** @param {string} text */
function firstLine(text) {
  const line = text.split("\n").find((candidate) => candidate.trim() !== "");
  return (line ?? "").trim().slice(0, MESSAGE_LIMIT);
}
