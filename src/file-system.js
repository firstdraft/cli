/**
 * @param {unknown} error
 * @returns {error is Error & {code: string}}
 */
export function isFileSystemError(error) {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    (error.code === "ERR_ACCESS_DENIED" || !error.code.startsWith("ERR_"))
  );
}
