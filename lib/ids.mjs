import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
/** newId('f') → 'f_k3j9x0aa'. Prefixes: s save, f fact, k commitment, c cache, sc self canon, sp suppression, fj forget job, t turn, l llm call, r scenario run, rf rejected fact. */
export function newId(prefix) {
  const bytes = randomBytes(8);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % 36];
  return `${prefix}_${out}`;
}
