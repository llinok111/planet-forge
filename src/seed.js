/**
 * Seed handling: turn an arbitrary user-facing seed string into a family of
 * independent 32-bit streams.
 *
 * Requirement being satisfied: "支持随机种子复现" — the same seed must reproduce
 * the same planet bit-for-bit, and each subsystem (tectonics, clouds, rings,
 * starfield) must draw from its own stream so that changing one subsystem's
 * parameters cannot silently reshuffle another's layout.
 */

/**
 * FNV-1a 32-bit string hash. Chosen because it is tiny, has no dependencies,
 * and produces well-distributed values for short ASCII/UTF-8 strings.
 *
 * @param {string} str
 * @returns {number} Unsigned 32-bit hash.
 */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Named streams so call sites read as intent rather than magic offsets.
 * Values are arbitrary odd constants; what matters is that they are distinct.
 */
const STREAM_OFFSETS = {
  tectonics: 0x9e3779b1,
  detail: 0x85ebca6b,
  erosion: 0xc2b2ae35,
  ocean: 0x27d4eb2f,
  clouds: 0x165667b1,
  atmosphere: 0xd3a2646c,
  rings: 0xfd7046c5,
  stars: 0xb55a4f09,
  scatter: 0x7feb352d,
};

/**
 * Derive a subsystem seed from the master seed.
 *
 * @param {string|number} seed Master seed, as typed by the user.
 * @param {keyof typeof STREAM_OFFSETS} stream Subsystem name.
 * @returns {number} Unsigned 32-bit sub-seed.
 */
export function deriveSeed(seed, stream) {
  const master = typeof seed === 'number' ? seed >>> 0 : hashString(String(seed));
  const offset = STREAM_OFFSETS[stream] ?? 0;
  // Mix rather than add so that "a"+"b" and "ab" do not collide in low bits.
  let h = (master ^ offset) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  return (h ^ (h >>> 15)) >>> 0;
}

/** All stream names, useful for tests and diagnostics. */
export const STREAMS = Object.keys(STREAM_OFFSETS);
