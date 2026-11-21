import { STAGING_API_URL } from "./api-authentication.js";

// The plain sentences the CLI prints for an agent, kept here so they are
// written once. `firstdraft start` and the two steps of the agent's device
// login print only these. A First Draft answer only chooses among them, and
// the only values they carry are an origin, versions, a token variable's
// name, and a device login's validated link, user code, and expiry.
// docs/commands.md quotes them and the Skill copies them, so a change here is
// a change to both.

/**
 * A command the agent can run as printed. A staging origin adds the flag that
 * selects it; a custom origin keeps coming from FIRSTDRAFT_API_URL.
 *
 * @param {string} origin
 * @param {string} command
 */
export function commandLine(origin, command) {
  return `'firstdraft ${command}${origin === STAGING_API_URL ? " --staging" : ""}'`;
}

/** @param {{cli: string, plugin: string | null}} versions */
export function versionLine({ cli, plugin }) {
  return plugin === null
    ? `First Draft CLI ${cli}.`
    : `First Draft CLI ${cli} with plugin ${plugin}.`;
}

/**
 * Whether a token for `origin` is saved on this computer or set in the
 * environment, which takes precedence.
 *
 * @param {{origin: string, saved: boolean, environmentVariable: string | null}} login
 */
export function loginLines({ origin, saved, environmentVariable }) {
  return [
    saved
      ? `This computer has a saved login for ${origin}.`
      : `This computer has no saved login for ${origin}.`,
    ...(environmentVariable === null
      ? []
      : [
          `${environmentVariable} is set, so the CLI uses that token in place of any saved login for ${origin}, and no login is needed.`,
        ]),
  ];
}

/** @param {string} origin */
export function loginSteps(origin) {
  return [
    `To log in, run ${commandLine(origin, "login --no-wait")}. It prints a link and a code: show both to the person and ask them to approve the login in their browser.`,
    `When the person says they approved, run ${commandLine(origin, "login --finish")}, then run ${commandLine(origin, "start")} again.`,
  ];
}

/** @param {string | null} environmentVariable */
export function readyLine(environmentVariable) {
  return environmentVariable === null
    ? "Ready: First Draft accepted this computer's login."
    : `Ready: First Draft accepted ${environmentVariable}.`;
}

/**
 * @param {string} origin
 * @param {string | null} environmentVariable
 */
export function rejectedLoginLines(origin, environmentVariable) {
  return environmentVariable === null
    ? [
        `Not logged in: First Draft did not accept the saved login for ${origin}.`,
        ...loginSteps(origin),
      ]
    : [
        `Not logged in: First Draft did not accept ${environmentVariable}. Ask the person to replace it or unset it; while it is set, the CLI uses no saved login.`,
      ];
}

/**
 * Printed when the person said yes to reports, and only then: the agent of a
 * person who said no hears nothing about reports. Any command that tells the
 * agent about reports prints these same sentences.
 */
export const REPORTS_ON_LINES = Object.freeze([
  "Reports are on: this person agreed that you send First Draft progress and failure reports about the code it generates.",
  "Progress: run 'firstdraft report progress <compilation-id> --step <step>' when bin/setup finishes (setup), when the first spec run finishes (specs_first_run), when every item under the README's Behavior to write is written (behavior_written), when the specs pass (specs_passing), and when the preview starts (preview_started). Add the counts you have; 'firstdraft report progress --help' lists them.",
  "Failure: when generated code fails in a way the README does not list, run 'firstdraft report failure <compilation-id> --kind <kind>' once you have fixed it or stopped trying, where <kind> is setup_failure, spec_failure, boot_error, or lint_failure; 'firstdraft report failure --help' lists the other fields.",
  "Use compilation.id from 'firstdraft plan compile', and run each report command from the generated application's root, or from the Project's directory after --output. Each prints what it sends: pass only text that may leave this computer, never secrets or the person's data.",
]);

/**
 * @typedef {object} DeviceLoginLink
 * @property {string} origin
 * @property {string} userCode
 * @property {string} verificationUri
 * @property {string | undefined} verificationUriComplete
 * @property {number} expiresAt epoch milliseconds
 */

/**
 * What `login --no-wait` prints. The device code is a credential and never
 * appears; the link and the user code are for the person.
 *
 * @param {DeviceLoginLink & {expiresIn: number}} login
 */
export function deviceLoginStartedLines(login) {
  const minutes = Math.max(1, Math.floor(login.expiresIn / 60));
  return [
    ...linkLines(login),
    `The link and the code expire in ${minutes} ${minutes === 1 ? "minute" : "minutes"}, at ${utcTime(login.expiresAt)}.`,
    `When the person says they approved, run ${commandLine(login.origin, "login --finish")}.`,
  ];
}

/** @param {string} origin */
export function deviceLoginFinishedLines(origin) {
  return [
    `Logged in: this computer is now logged in to ${origin}.`,
    `Run ${commandLine(origin, "start")} again.`,
  ];
}

/** @param {DeviceLoginLink} login */
export function deviceLoginPendingLines(login) {
  return [
    "Still waiting: the person has not approved the login yet.",
    ...linkLines(login),
    `The link and the code expire at ${utcTime(login.expiresAt)}. When the person says they approved, run ${commandLine(login.origin, "login --finish")} again.`,
  ];
}

/** @param {string} origin */
export function deviceLoginExpiredLines(origin) {
  return [
    `Expired: the link and the code expired before the person approved, so no new login was saved for ${origin}.`,
    `To try again, run ${commandLine(origin, "login --no-wait")}.`,
  ];
}

/** @param {string} origin */
export function deviceLoginRefusedLines(origin) {
  return [
    `Refused: the person denied this login, so no new login was saved for ${origin}.`,
    `Ask the person before you start another login with ${commandLine(origin, "login --no-wait")}.`,
  ];
}

/** @param {string} origin */
export function deviceLoginNotStartedLines(origin) {
  return [
    `No login is waiting: this computer has no device login for ${origin} that has not ended.`,
    `Run ${commandLine(origin, "start")} to see whether this computer is logged in.`,
  ];
}

/** @param {DeviceLoginLink} login */
function linkLines({
  origin,
  userCode,
  verificationUri,
  verificationUriComplete,
}) {
  return verificationUriComplete === undefined
    ? [
        `To log in to ${origin}, ask the person to open this link in a browser, enter the code ${userCode}, and approve:`,
        verificationUri,
      ]
    : [
        `To log in to ${origin}, ask the person to open this link in a browser, check that the page shows the code ${userCode}, and approve:`,
        verificationUriComplete,
      ];
}

/** @param {number} milliseconds */
function utcTime(milliseconds) {
  return new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/, "Z");
}
