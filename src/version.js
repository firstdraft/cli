import { readFileSync } from "node:fs";

const packageMetadata = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

if (typeof packageMetadata.version !== "string") {
  throw new TypeError("package.json must declare a string version");
}

export const VERSION = packageMetadata.version;
