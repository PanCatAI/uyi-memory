// 3.0 E5: "is it fun?" numbers for a stretch of conversation, by program (no model): catchphrase rate, questions
// asked 3+ times, echo openings, the intent mix, how much she gives (分享/提议/逗/抱怨/安慰) and how often her lines
// touch the world around her. The judge (prompts/fun-judge.md) adds a 1–5 score when a judge model is set.
import { readFileSync, existsSync } from 'node:fs';
import { questions, jaccard, echoOpening, INTENTS, GIVING, SAME_QUESTION } from './memory/voice.mjs';

// Words that mean "the world right now". F and G add their own names from the scene data files when present.
const BASE_WORLD = ['天', '雨', '雾', '风', '火', '柴', '冷', '雪', '星', '云', '晴', '夜', '烟', '霜'];
export function worldWords(sceneId = 'camp') {
  const words = new Set(BASE_WORLD);
  for (const kind of ['incidents', 'topics', 'scout']) {
    const f = new URL(`../scenes/${sceneId}.${kind}.json`, import.meta.url);
    if (!existsSync(f)) continue;
    try { for (const w of JSON.parse(readFileSync(f, 'utf8')).world_words || []) words.add(w); } catch { /* a bad file only loses words */ }
  }
  return [...words];
}

/** lines: her lines oldest first, [{ text, user, intent }]. phrases: catchphrases(card). */
export function funMetrics(lines, phrases, words = BASE_WORLD) {
  const n = lines.length;
  const rate = k => (n ? Math.round((k / n) * 100) / 100 : 0);
  const groups = [];
  for (const q of lines.flatMap(l => questions(l.text))) {
    const g = groups.find(x => jaccard(x.text, q) >= SAME_QUESTION);
    if (g) g.n++; else groups.push({ text: q, n: 1 });
  }
  const intents = Object.fromEntries(INTENTS.map(i => [i, lines.filter(l => (l.intent || '回应') === i).length]));
  return {
    n,
    ticRate: rate(lines.filter(l => phrases.some(p => l.text.includes(p.phrase))).length),
    tics: Object.fromEntries(phrases.map(p => [p.phrase, lines.filter(l => l.text.includes(p.phrase)).length])),
    nagging: groups.filter(g => g.n >= 3),
    echoRate: rate(lines.filter(l => echoOpening(l.text, l.user)).length),
    intents,
    askRate: rate(intents['打听']),
    giveRate: rate(GIVING.reduce((k, i) => k + intents[i], 0)),
    worldRate: rate(lines.filter(l => words.some(w => l.text.includes(w))).length)
  };
}

export const pct = x => `${Math.round(x * 100)}%`;
/** One table row: 口头禅率 | 反复问题 | 复述开头 | 打听 | 给东西 | 世界相关. */
export const metricCells = m => [pct(m.ticRate), m.nagging.length, pct(m.echoRate), pct(m.askRate), pct(m.giveRate), pct(m.worldRate)];
export const METRIC_HEADS = ['口头禅率', '反复问题', '复述开头', '打听', '给东西', '世界相关'];
