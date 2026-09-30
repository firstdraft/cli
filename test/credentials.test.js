import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CredentialsInvalidError,
  CredentialsLockedError,
  credentialsPath,
  deleteCredential,
  readCredentials,
  storedTokenReader,
  writeCredential,
} from "../src/credentials.js";

const ORIGIN = "https://firstdraft.com";
const OTHER = "http://127.0.0.1:3000";

test("the credentials path follows XDG_CONFIG_HOME, else ~/.config", () => {
  assert.equal(
    credentialsPath({ env: { XDG_CONFIG_HOME: "/xdg" }, homedir: () => "/h" }),
    path.join("/xdg", "firstdraft", "credentials.json"),
  );
  for (const XDG_CONFIG_HOME of [undefined, "", "relative/config"]) {
    assert.equal(
      credentialsPath({ env: { XDG_CONFIG_HOME }, homedir: () => "/home/u" }),
      path.join("/home/u", ".config", "firstdraft", "credentials.json"),
    );
  }
});

test("a missing file reads as empty and writes create private files atomically", (context) => {
  const store = temporaryStore(context);
  const empty = readCredentials(store);
  assert.equal(empty.format, "firstdraft.cli-credentials/1");
  assert.deepEqual(Object.keys(empty.origins), []);

  writeCredential(store, ORIGIN, entry("fd_one"));
  writeCredential(store, OTHER, entry("fd_two"));
  writeCredential(store, ORIGIN, entry("fd_three"));

  const file = credentialsPath(store);
  if (process.platform !== "win32") {
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
  }
  assert.deepEqual(readdirSync(path.dirname(file)), ["credentials.json"]);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
    format: "firstdraft.cli-credentials/1",
    origins: { [ORIGIN]: entry("fd_three"), [OTHER]: entry("fd_two") },
  });

  assert.equal(deleteCredential(store, ORIGIN), true);
  assert.equal(deleteCredential(store, ORIGIN), false);
  assert.deepEqual(Object.keys(readCredentials(store).origins), [OTHER]);
});

test("a failed write leaves the previous file and no temporary file", (context) => {
  const store = temporaryStore(context);
  writeCredential(store, ORIGIN, entry("fd_before"));
  const file = credentialsPath(store);
  const before = readFileSync(file, "utf8");

  const failing = {
    ...store,
    fileSystem: {
      mkdirSync,
      readFileSync,
      rmSync,
      statSync,
      writeFileSync,
      /** @type {typeof import("node:fs").renameSync} */
      renameSync: () => {
        throw Object.assign(new Error("Injected rename failure"), {
          code: "EIO",
        });
      },
    },
  };
  assert.throws(
    () => writeCredential(failing, ORIGIN, entry("fd_after")),
    /Injected/,
  );
  assert.equal(readFileSync(file, "utf8"), before);
  assert.deepEqual(readdirSync(path.dirname(file)), ["credentials.json"]);
});

test("a delete with a token removes the entry only while it still holds that token", (context) => {
  const store = temporaryStore(context);
  writeCredential(store, ORIGIN, entry("fd_newer"));

  assert.equal(
    deleteCredential(store, ORIGIN, { accessToken: "fd_older" }),
    false,
  );
  assert.deepEqual(readCredentials(store).origins[ORIGIN], entry("fd_newer"));
  assert.equal(
    deleteCredential(store, ORIGIN, { accessToken: "fd_newer" }),
    true,
  );
  assert.deepEqual(Object.keys(readCredentials(store).origins), []);
});

test("an update waits for another update's lock instead of interleaving", (context) => {
  const store = temporaryStore(context);
  writeCredential(store, ORIGIN, entry("fd_before"));
  const file = credentialsPath(store);
  /** @type {unknown} */
  let concurrentFailure;

  // The concurrent update starts after the outer one has read the store but
  // before it renames its replacement into place.
  writeCredential(
    {
      ...store,
      fileSystem: {
        mkdirSync,
        readFileSync,
        renameSync,
        rmSync,
        statSync,
        /** @type {typeof writeFileSync} */
        writeFileSync: (target, data, options) => {
          if (
            String(target).endsWith(".tmp") &&
            concurrentFailure === undefined
          ) {
            try {
              writeCredential(
                { ...store, lockTimeoutMs: 50 },
                OTHER,
                entry("fd_other"),
              );
            } catch (error) {
              concurrentFailure = error;
            }
          }
          return writeFileSync(target, data, options);
        },
      },
    },
    ORIGIN,
    entry("fd_after"),
  );

  assert(concurrentFailure instanceof CredentialsLockedError);
  assert.deepEqual(Object.keys(readCredentials(store).origins), [ORIGIN]);
  assert.deepEqual(readdirSync(path.dirname(file)), ["credentials.json"]);

  writeCredential(store, OTHER, entry("fd_other"));
  assert.deepEqual(
    { ...readCredentials(store).origins },
    {
      [ORIGIN]: entry("fd_after"),
      [OTHER]: entry("fd_other"),
    },
  );
});

test("a held lock times out without changing the file, however old the lock is", (context) => {
  const store = temporaryStore(context);
  writeCredential(store, ORIGIN, entry("fd_before"));
  const file = credentialsPath(store);
  const lock = path.join(path.dirname(file), "credentials.json.lock");
  const before = readFileSync(file, "utf8");

  writeFileSync(lock, "12345\n");
  // Age alone never makes a lock removable: two updates reclaiming the same
  // abandoned lock could both proceed and drop each other's entries.
  const abandoned = new Date(Date.now() - 24 * 60 * 60 * 1000);
  for (const time of [new Date(), abandoned]) {
    utimesSync(lock, time, time);
    assert.throws(
      () =>
        writeCredential({ ...store, lockTimeoutMs: 50 }, OTHER, entry("fd_x")),
      CredentialsLockedError,
    );
    assert.throws(
      () => deleteCredential({ ...store, lockTimeoutMs: 50 }, ORIGIN),
      CredentialsLockedError,
    );
    assert.equal(readFileSync(file, "utf8"), before);
    assert.equal(readFileSync(lock, "utf8"), "12345\n");
  }

  rmSync(lock);
  writeCredential({ ...store, lockTimeoutMs: 50 }, OTHER, entry("fd_other"));
  assert.deepEqual(Object.keys(readCredentials(store).origins), [
    ORIGIN,
    OTHER,
  ]);
  assert.deepEqual(readdirSync(path.dirname(file)), ["credentials.json"]);
});

test("malformed credentials are rejected rather than guessed", (context) => {
  const store = temporaryStore(context);
  const file = credentialsPath(store);
  mkdirSync(path.dirname(file), { recursive: true });
  for (const source of [
    "not json",
    "[]",
    '{"format":"firstdraft.cli-credentials/2","origins":{}}',
    '{"format":"firstdraft.cli-credentials/1"}',
    '{"format":"firstdraft.cli-credentials/1","origins":{"https://x.test":{"access_token":""}}}',
    Buffer.from([0xff, 0xfe]),
  ]) {
    writeFileSync(file, source);
    assert.throws(() => readCredentials(store), CredentialsInvalidError);
    assert.deepEqual(Object.keys(storedTokenReader(store)()), []);
  }
});

test("a __proto__ origin key stays inert", (context) => {
  const store = temporaryStore(context);
  const file = credentialsPath(store);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      format: "firstdraft.cli-credentials/1",
      origins: JSON.parse(
        `{"__proto__": ${JSON.stringify(entry("fd_proto"))}, "${ORIGIN}": ${JSON.stringify(entry("fd_real"))}}`,
      ),
    }),
  );
  const tokens = storedTokenReader(store)();
  assert.equal(tokens[ORIGIN], "fd_real");
  assert.equal(Object.getPrototypeOf(tokens), null);
  assert.equal(
    /** @type {Record<string, unknown>} */ ({}).access_token,
    undefined,
  );
});

/** @param {import("node:test").TestContext} context */
function temporaryStore(context) {
  const directory = mkdtempSync(path.join(tmpdir(), "firstdraft-credentials-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return {
    env: { XDG_CONFIG_HOME: path.join(directory, "config") },
    homedir: () => assert.fail("The home directory must not be used"),
  };
}

/** @param {string} token */
function entry(token) {
  return {
    access_token: token,
    token_type: "Bearer",
    created_at: "2026-09-29T12:00:00.000Z",
  };
}
