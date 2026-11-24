import { STAGING_API_URL } from "./api-authentication.js";

// The plain sentences the CLI prints for an agent, kept here so they are
// written once. `firstdraft start` and the two steps of the agent's device
// login print only these, besides the update line every command shares
// (src/service-client.js), and `firstdraft maintain` prints one of them
// beside its JSON. A First Draft answer only chooses among them, and
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
 * person who said no hears nothing about reports or notes. One yes covers
 * both, so any command that tells the agent about reports prints these same
 * sentences, followed by NOTES_ON_LINES.
 */
export const REPORTS_ON_LINES = Object.freeze([
  "Reports are on: this person agreed that you send First Draft progress and failure reports about the code it generates, and notes about problems with First Draft itself.",
  "Progress: run 'firstdraft report progress --step <step>' when bin/setup finishes (setup), when the first spec run finishes (specs_first_run), when every item under the README's Behavior to write is written (behavior_written), when the specs pass (specs_passing), and when the preview starts (preview_started). Add the counts you have; 'firstdraft report progress --help' lists them.",
  "Failure: when generated code fails in a way the README does not list, run 'firstdraft report failure --kind <kind>' once you have fixed it or stopped trying, where <kind> is setup_failure, spec_failure, boot_error, or lint_failure; 'firstdraft report failure --help' lists the other fields.",
  "Each report names the Compilation that the CLI last recorded for this Project when 'firstdraft plan compile' or 'firstdraft compilation download' wrote its code; to name a different one, put its compilation.id right after 'report progress' or 'report failure'.",
  "Run each report and note command from the generated application's root, or from the Project's directory before the code is written or after --output. Each prints what it sends: pass only text that may leave this computer, never secrets or the person's data.",
]);

/** The notes half of what REPORTS_ON_LINES introduces, printed right after it. */
export const NOTES_ON_LINES = Object.freeze([
  "Notes: send a note only when a problem with First Draft cost you a real detour and is likely to happen again, never for routine debugging, and only after the Plan has been pushed once with 'firstdraft plan push' or 'firstdraft plan compile'.",
  "Unstated request: when the person asked for something the Plan could not state, run 'firstdraft note unstated_request --request <text>', adding --workaround <text> for what you wrote in the Plan instead or left for later.",
  "Unclear guidance: when a Skill page or a diagnostic was unclear, run 'firstdraft note unclear_guidance --page <page> --unclear <text>', where <page> is the page's path inside the Skill, such as SKILL.md or references/plan/policies.md; for a diagnostic code or a CLI error value, give --code <code> in place of or beside --page, and add --workaround <text> for what you did instead.",
  "Wrong output: when analysis or generated code was wrong, run 'firstdraft note wrong_output --source <source> --expected <text> --actual <text>', where <source> is analysis or generated_code; a note about generated code names the recorded Compilation as a report does, and 'firstdraft note wrong_output --help' lists --code, --file, and --workaround.",
  "Write each note in your own plain words, at most 300 characters a field: never secrets, credentials, personal data, or code from the person's project.",
]);

/**
 * What `firstdraft maintain` prints on standard error when the person said
 * yes to reports, and only then. An item's evidence can hold end users' text,
 * so the report carries none of it.
 */
export const MAINTAIN_REPORTS_ON_LINE =
  "Reports are on: after you resolve an item with --cause generated_code, run 'firstdraft report failure --kind deployed_error --item <item-id>' from the generated application's root, adding --error-class from the item's title, --rerun for the spec you wrote, --frame for each place you fixed, and --fix-summary; never put anything from the item's evidence in a report or a note, because it can hold end users' text.";

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
    "Still waiting: First Draft has not confirmed that the person approved the login.",
    ...linkLines(login),
    `The link and the code expire at ${utcTime(login.expiresAt)}. When the person says they approved, run ${commandLine(login.origin, "login --finish")} again.`,
  ];
}

/** @param {string} origin */
export function deviceLoginExpiredLines(origin) {
  return [
    `Expired: the link and the code expired before this computer finished the login, so no new login was saved for ${origin}.`,
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
