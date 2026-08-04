import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const inputs = listJavaScriptFiles(path.join(repository, "src"))
  .concat([
    path.join(repository, "bin", "firstdraft.js"),
    path.join(repository, "package.json"),
  ])
  .map((file) => ({
    file,
    relativePath: path.relative(repository, file).split(path.sep).join("/"),
  }))
  .sort((left, right) =>
    left.relativePath < right.relativePath
      ? -1
      : left.relativePath > right.relativePath
        ? 1
        : 0,
  );
const digest = createHash("sha256");

for (const { file, relativePath } of inputs) {
  const source = readFileSync(file);
  const relativePathLength = Buffer.alloc(4);
  relativePathLength.writeUInt32BE(Buffer.byteLength(relativePath));
  const sourceLength = Buffer.alloc(8);
  sourceLength.writeBigUInt64BE(BigInt(source.byteLength));
  digest.update(relativePathLength);
  digest.update(relativePath);
  digest.update(sourceLength);
  digest.update(source);
}

process.stdout.write(`${digest.digest("hex")}\n`);

/** @param {string} directory @returns {string[]} */
function listJavaScriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) return listJavaScriptFiles(entryPath);

      return entry.isFile() && entry.name.endsWith(".js") ? [entryPath] : [];
    })
    .sort();
}
