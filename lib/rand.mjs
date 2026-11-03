// 3.0 F1: the host's only source of chance. Same save and same keys → same number, always (no Math.random, no clock).
// FNV-1a over "save|key|key…", then a murmur3 finaliser so neighbouring keys ("…|10-21", "…|10-22") spread evenly.

/** 32-bit FNV-1a of a string (the 2.0 weather hash). */
export function fnv(s) {
  let h = 0x811c9dc5;
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

function mix(h) {
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** A number in [0, 1) fixed by the save and the keys. */
export const rand01 = (saveId, ...keys) => mix(fnv([saveId, ...keys].join('|'))) / 4294967296;

/** Picks from [[value, weight], …] (weights need not sum to 1) with a draw r in [0, 1). */
export function pickWeighted(pairs, r) {
  const total = pairs.reduce((a, [, w]) => a + w, 0);
  let x = r * total;
  for (const [v, w] of pairs) { if (x < w) return v; x -= w; }
  return pairs.at(-1)[0];
}
