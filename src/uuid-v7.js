import { randomBytes as secureRandomBytes } from "node:crypto";

const MAX_TIMESTAMP = 2 ** 48 - 1;
const RANDOM_BYTE_LENGTH = 16;

/**
 * @typedef {object} UuidV7Options
 * @property {() => number} [now]
 * @property {(size: number) => Uint8Array} [randomBytes]
 */

/** @param {UuidV7Options} [options] */
export function generateUuidV7({
  now = Date.now,
  randomBytes = secureRandomBytes,
} = {}) {
  const timestamp = now();

  if (
    !Number.isInteger(timestamp) ||
    timestamp < 0 ||
    timestamp > MAX_TIMESTAMP
  ) {
    throw new RangeError(
      `UUIDv7 timestamp must be an integer between 0 and ${MAX_TIMESTAMP}`,
    );
  }

  const suppliedRandomness = randomBytes(RANDOM_BYTE_LENGTH);

  if (
    !(suppliedRandomness instanceof Uint8Array) ||
    suppliedRandomness.byteLength !== RANDOM_BYTE_LENGTH
  ) {
    throw new TypeError("UUIDv7 randomBytes must return exactly 16 bytes");
  }

  const bytes = Uint8Array.from(suppliedRandomness);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let remainingTimestamp = timestamp;

  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = remainingTimestamp % 256;
    remainingTimestamp = Math.floor(remainingTimestamp / 256);
  }

  view.setUint8(6, (view.getUint8(6) & 0x0f) | 0x70);
  view.setUint8(8, (view.getUint8(8) & 0x3f) | 0x80);

  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
