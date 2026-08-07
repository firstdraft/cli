const PREFIX = "First Draft: ";

const PUBLICATION_MESSAGES = new Map([
  ["preparing_repository", "Preparing private GitHub repository..."],
  ["creating_repository", "Creating private GitHub repository..."],
  [
    "preparing_repository_reconciliation",
    "Preparing to verify GitHub repository creation...",
  ],
  ["reconciling_repository", "Verifying GitHub repository creation..."],
  ["preparing_artifact", "Preparing compiled application..."],
  ["publishing_artifact", "Publishing compiled application to GitHub..."],
  [
    "preparing_publication_reconciliation",
    "Preparing to verify GitHub publication...",
  ],
  ["reconciling_publication", "Verifying GitHub publication..."],
  ["completed", "GitHub publication complete."],
]);

/**
 * @typedef {object} AnalysisProgress
 * @property {"analysis"} phase
 * @property {"waiting" | "valid"} status
 */

/**
 * @typedef {object} CompilationProgress
 * @property {"compilation"} phase
 * @property {"waiting"} status
 */

/**
 * @typedef {object} PublicationProgress
 * @property {"publication"} phase
 * @property {"queued" | "running" | "succeeded" | "failed" | "cancelled"} compilationStatus
 * @property {string} publicationPhase
 * @property {string | null} retryAt
 * @property {number} retryCount
 * @property {string | null} reasonCode
 */

/**
 * @typedef {AnalysisProgress | CompilationProgress | PublicationProgress} PlanCompileProgress
 */

/**
 * Convert deliberately narrow lifecycle observations into stable progress.
 * This boundary never receives response projections, identifiers, hashes,
 * repository names, URLs, or local state.
 *
 * @param {{write: (text: string) => unknown}} writer
 * @returns {(progress: PlanCompileProgress) => void}
 */
export function createPlanCompileProgressReporter(writer) {
  let compilationSucceeded = false;
  /** @type {string | null} */
  let previousProgress = null;

  /** @param {string} message */
  function write(message) {
    writer.write(`${PREFIX}${message}\n`);
  }

  return (progress) => {
    const serialized = JSON.stringify(progress);
    if (serialized === previousProgress) return;
    previousProgress = serialized;

    if (progress.phase === "analysis") {
      write(
        progress.status === "waiting"
          ? "Analyzing Foundation Plan..."
          : "Foundation Plan analysis valid.",
      );
      return;
    }

    if (progress.phase === "compilation") {
      write("Compiling application...");
      return;
    }

    if (progress.compilationStatus === "succeeded" && !compilationSucceeded) {
      write("Application compiled.");
      compilationSucceeded = true;
    }

    if (progress.publicationPhase === "compiling") return;
    if (progress.publicationPhase === "failed") {
      write(
        progress.compilationStatus === "failed"
          ? "Application compilation failed."
          : "GitHub publication failed.",
      );
      return;
    }
    if (progress.publicationPhase === "cancelled") {
      write(
        progress.compilationStatus === "cancelled"
          ? "Application compilation cancelled."
          : "GitHub publication cancelled.",
      );
      return;
    }
    if (progress.publicationPhase === "github_preflight") {
      write(githubPreflightMessage(progress));
      return;
    }

    const message = PUBLICATION_MESSAGES.get(progress.publicationPhase);
    if (message !== undefined) write(message);
  };
}

/** @param {PublicationProgress} progress */
function githubPreflightMessage(progress) {
  if (progress.retryCount === 0) return "Checking GitHub access...";

  const retry =
    progress.retryAt === null
      ? "automatic retries paused; operator recovery required"
      : `next retry: ${progress.retryAt}`;
  return `Checking GitHub access (reason: ${progress.reasonCode}; retry count: ${progress.retryCount}; ${retry}).`;
}
