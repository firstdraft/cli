import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_DERIVED_APPLICATION_KEY_BYTES,
  deriveApplicationKey,
  deriveApplicationName,
  isValidApplicationKey,
  isValidApplicationName,
} from "../src/application-identity.js";

test("derives readable lower-snake keys from Unicode names", () => {
  assert.equal(deriveApplicationKey("Movie Catalog"), "movie_catalog");
  assert.equal(deriveApplicationKey("Café & Æther"), "cafe_aether");
  assert.equal(deriveApplicationKey("Smørrebrød & Œufs"), "smorrebrod_oeufs");
  assert.equal(deriveApplicationKey("2026 Inventory"), "app_2026_inventory");
  assert.equal(deriveApplicationKey("Home 🏠 Inventory"), "home_inventory");
});

test("uses a stable digest when no readable ASCII remains", () => {
  assert.equal(deriveApplicationKey("東京"), "app_130016b2599b");
  assert.equal(deriveApplicationKey("___"), "app_bda251550bf0");
  assert.equal(deriveApplicationKey("東京"), deriveApplicationKey("東京"));
  assert.equal(
    deriveApplicationKey("안녕"),
    deriveApplicationKey("안녕".normalize("NFD")),
  );
});

test("bounds long derived keys with a readable prefix and stable digest", () => {
  const key = deriveApplicationKey("A".repeat(100));

  assert.equal(key, `${"a".repeat(50)}_d82c6aa133a0`);
  assert.equal(Buffer.byteLength(key), MAX_DERIVED_APPLICATION_KEY_BYTES);
  assert.match(key, /^[a-z][a-z0-9_]*$/);
});

test("every generated key lowers to the current iOS identifier component", () => {
  for (const name of [
    "Movie Catalog",
    "2026 Inventory",
    "東京",
    "Home 🏠 Inventory",
    "_".repeat(100),
    "A very long readable application name ".repeat(10),
  ]) {
    const key = deriveApplicationKey(name);
    const component = key.replaceAll("_", "-");

    assert.ok(Buffer.byteLength(key) <= MAX_DERIVED_APPLICATION_KEY_BYTES);
    assert.match(component, /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
  }
});

test("explicit keys retain the complete Foundation Plan schema boundary", () => {
  for (const key of [
    "a",
    "movie_catalog",
    "movie___catalog___",
    "a".repeat(500),
  ]) {
    assert.equal(isValidApplicationKey(key), true, key);
  }

  for (const key of [
    "",
    "2026_inventory",
    "Movie_Catalog",
    "movie-catalog",
    "café",
  ]) {
    assert.equal(isValidApplicationKey(key), false, key);
  }
});

test("derives a clean display name from explicit keys", () => {
  assert.equal(deriveApplicationName("movie_catalog"), "Movie Catalog");
  assert.equal(deriveApplicationName("movie___catalog___"), "Movie Catalog");
  assert.equal(deriveApplicationName("api_v2_client"), "Api V2 Client");
});

test("accepts interoperable nonblank Unicode text", () => {
  for (const name of ["Movie Catalog", "東京", "🏠"]) {
    assert.equal(isValidApplicationName(name), true, JSON.stringify(name));
  }

  for (const name of [
    "",
    "\u00a0\t",
    "\u0085",
    "\u3000",
    "\u0000",
    "\ufdd0",
    "\ufffe",
    String.fromCodePoint(0x1fffe),
    "\ud800",
    "\udc00",
  ]) {
    assert.equal(isValidApplicationName(name), false, JSON.stringify(name));
  }
});

test("derivation rejects invalid direct inputs", () => {
  assert.throws(() => deriveApplicationKey("\u3000"), /valid nonblank/);
  assert.throws(
    () => deriveApplicationName("Invalid-Key"),
    /valid lower-snake/,
  );
});
