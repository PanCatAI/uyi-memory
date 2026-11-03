// Lore selection (PLAN-2.0 B3): pick at most 3 entries from the card's 过往 by keyword hits — the user's latest line
// counts 2, the last 4 lines of talk count 1 — among entries the current relationship stage allows. Deterministic.
import { stageIndex } from '../card.mjs';
import { estimate } from '../tokens.mjs';

export const LORE_MAX = 3;
export const LORE_BUDGET = 300;

const hits = (text, kws) => kws.filter(k => k && String(text || '').includes(k)).length;

/** → [{ id, title, text, score }] best first; ties keep card order. */
export function selectLore(lore, { input = '', recent = [], stage = '初识' } = {}) {
  const at = stageIndex(stage);
  const scored = (lore || [])
    .filter(l => stageIndex(l.stage) <= at)
    .map((l, i) => ({ ...l, i, score: 2 * hits(input, [l.title, ...l.keywords]) + recent.slice(-4).reduce((n, r) => n + hits(r, l.keywords), 0) }))
    .filter(l => l.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i);
  const out = [];
  let used = 0;
  for (const l of scored) {
    if (out.length >= LORE_MAX) break;
    const cost = estimate(loreLine(l));
    if (used + cost > LORE_BUDGET && out.length) break;
    used += cost;
    out.push({ id: l.id, title: l.title, text: l.text, score: l.score });
  }
  return out;
}

export const loreLine = l => `[lore:${l.id}] ${l.title}：${l.text}（你可以自己决定说不说）`;
