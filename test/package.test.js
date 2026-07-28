import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const metadata = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

test("package metadata preserves the audited runtime boundary", () => {
  assert.equal(metadata.name, "firstdraft");
  assert.equal(metadata.type, "module");
  assert.equal(metadata.engines.node, ">=22.0.0");
  assert.deepEqual(metadata.bin, { firstdraft: "./bin/firstdraft.js" });
  assert.deepEqual(metadata.files, ["bin", "src"]);
  assert.equal(metadata.scripts.test, "node scripts/run-tests.js");

  for (const property of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "peerDependenciesMeta",
    "bundledDependencies",
    "bundleDependencies",
  ]) {
    assert.equal(property in metadata, false, `${property} must stay absent`);
  }
});

test("package metadata defines no installation lifecycle", () => {
  for (const script of [
    "preinstall",
    "install",
    "postinstall",
    "prepack",
    "postpack",
    "prepare",
    "prepublish",
    "prepublishOnly",
  ]) {
    assert.equal(
      script in metadata.scripts,
      false,
      `${script} must stay absent`,
    );
  }
});
