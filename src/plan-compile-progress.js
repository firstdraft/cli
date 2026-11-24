const PREFIX = "First Draft: ";

/**
 * @typedef {object} AnalysisProgress
 * @property {"analysis"} phase
 * @property {"waiting" | "valid"} status
 */

/**
 * @typedef {object} CompilationProgress
 * @property {"compilation"} phase
 * @property {"waiting" | "succeeded"} status
 */

/**
 * @typedef {AnalysisProgress | CompilationProgress} PlanCompileProgress
 */

/**
 * Convert deliberately narrow lifecycle observations into stable progress.
 * This boundary never receives response projections, identifiers, hashes, URLs,
 * or local state.
 *
 * @param {{write: (text: string) => unknown}} writer
 * @returns {(progress: PlanCompileProgress) => void}
 */
export function createPlanCompileProgressReporter(writer) {
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

    write(
      progress.status === "waiting"
        ? "Compiling application..."
        : "Application compiled.",
    );
  };
}
