import assert from "node:assert/strict";
import test from "node:test";

import { generateUuidV7 } from "../src/uuid-v7.js";

const MAX_TIMESTAMP = 2 ** 48 - 1;

test("matches the RFC 9562 Appendix A.6 UUIDv7 vector", () => {
  const randomness = Uint8Array.from([
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xcc, 0xc3, 0x98, 0xc4, 0xdc, 0x0c,
    0x0c, 0x07, 0x39, 0x8f,
  ]);

  assert.equal(
    generateUuidV7({
      now: () => 1_645_557_742_000,
      randomBytes: () => randomness,
    }),
    "017f22e2-79b0-7cc3-98c4-dc0c0c07398f",
  );
});

test("encodes the inclusive timestamp bounds in network byte order", () => {
  assert.equal(
    generateUuidV7({
      now: () => 0,
      randomBytes: () => new Uint8Array(16),
    }),
    "00000000-0000-7000-8000-000000000000",
  );
  assert.equal(
    generateUuidV7({
      now: () => MAX_TIMESTAMP,
      randomBytes: () => new Uint8Array(16).fill(0xff),
    }),
    "ffffffff-ffff-7fff-bfff-ffffffffffff",
  );
});

test("sets the version and variant while preserving the other random bits", () => {
  const zeros = generateUuidV7({
    now: () => 0,
    randomBytes: () => new Uint8Array(16),
  });
  const ones = generateUuidV7({
    now: () => 0,
    randomBytes: () => new Uint8Array(16).fill(0xff),
  });

  assert.equal(zeros, "00000000-0000-7000-8000-000000000000");
  assert.equal(ones, "00000000-0000-7fff-bfff-ffffffffffff");
  assert.match(
    zeros,
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.match(
    ones,
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-b[0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

test("requests and copies exactly 16 random bytes", () => {
  const randomness = new Uint8Array(16).fill(0xff);
  const original = Uint8Array.from(randomness);
  let requestedBytes;

  generateUuidV7({
    now: () => 0,
    randomBytes: (size) => {
      requestedBytes = size;
      return randomness;
    },
  });

  assert.equal(requestedBytes, 16);
  assert.deepEqual(randomness, original);
});

test("rejects timestamps outside the unsigned 48-bit integer range", () => {
  for (const timestamp of [
    -1,
    MAX_TIMESTAMP + 1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]) {
    assert.throws(
      () =>
        generateUuidV7({
          now: () => timestamp,
          randomBytes: () => new Uint8Array(16),
        }),
      {
        name: "RangeError",
        message: `UUIDv7 timestamp must be an integer between 0 and ${MAX_TIMESTAMP}`,
      },
    );
  }
});

test("rejects random input that is not exactly 16 bytes", () => {
  for (const randomness of [
    new Uint8Array(15),
    new Uint8Array(17),
    Array(16).fill(0),
    "0000000000000000",
  ]) {
    assert.throws(
      () =>
        generateUuidV7({
          now: () => 0,
          // @ts-expect-error Exercise runtime validation of untrusted input.
          randomBytes: () => randomness,
        }),
      {
        name: "TypeError",
        message: "UUIDv7 randomBytes must return exactly 16 bytes",
      },
    );
  }
});
