import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SERVICE_ROUTES } from "../src/api-response.js";

const repository = fileURLToPath(new URL("..", import.meta.url));
const ROUTES_FILE = path.join("src", "api-response.js");

test("the Service endpoints table lists exactly the routes the CLI requests", () => {
  const rows = endpointRows(
    readFileSync(path.join(repository, "docs", "commands.md"), "utf8"),
  );
  const routes = Object.entries(SERVICE_ROUTES).map(([name, route]) => ({
    name,
    key: `${route.method} ${route.path}`,
  }));
  const rowKeys = rows.map((row) => `${row.method} ${row.path}`);
  const routeKeys = new Set(routes.map((route) => route.key));
  const requestSources = listJavaScriptFiles(path.join(repository, "src"))
    .map((file) => ({
      name: path.relative(repository, file),
      source: readFileSync(file, "utf8"),
    }))
    .filter(({ name }) => name !== ROUTES_FILE);
  const findings = [];

  for (const route of routes) {
    if (!rowKeys.includes(route.key)) {
      findings.push(`SERVICE_ROUTES.${route.name} (${route.key}) has no row.`);
    }
    const reference = new RegExp(`\\bSERVICE_ROUTES\\.${route.name}\\b`);
    if (!requestSources.some(({ source }) => reference.test(source))) {
      findings.push(`No file in src/ requests SERVICE_ROUTES.${route.name}.`);
    }
  }

  rowKeys.forEach((key, index) => {
    if (!routeKeys.has(key)) {
      findings.push(`The row ${key} matches no SERVICE_ROUTES entry.`);
    } else if (rowKeys.indexOf(key) !== index) {
      findings.push(`The row ${key} appears more than once.`);
    }
  });

  // sendRequest takes the method from the route, so a literal method means a
  // request that bypasses SERVICE_ROUTES.
  for (const { name, source } of requestSources) {
    if (/\bmethod: "/.test(source)) {
      findings.push(
        `${name} names an HTTP method; declare its route in SERVICE_ROUTES.`,
      );
    }
  }

  assert.notEqual(rows.length, 0, "the Service endpoints table has no rows");
  assert.ok(
    findings.length === 0,
    `Update docs/commands.md#service-endpoints or SERVICE_ROUTES:\n${findings.join("\n")}`,
  );
});

/**
 * @param {string} markdown
 * @returns {{method: string, path: string}[]}
 */
function endpointRows(markdown) {
  const lines = markdown.split("\n");
  const start = lines.indexOf("## Service endpoints");
  assert.notEqual(
    start,
    -1,
    "docs/commands.md needs a Service endpoints section",
  );
  const end = lines.findIndex(
    (line, index) => index > start && line.startsWith("## "),
  );

  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .filter((line) => line.startsWith("|"))
    .slice(2)
    .map((line) => {
      const [method, endpointPath] = line
        .split("|")
        .slice(1, 3)
        .map((cell) => cell.trim().replace(/^`|`$/g, ""));
      assert(method && endpointPath, `malformed endpoint row: ${line}`);
      return { method, path: endpointPath };
    });
}

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
