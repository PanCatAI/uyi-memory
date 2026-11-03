// 3.0 E1: how she has been talking lately, so she stops saying the same thing every line. No model calls: from her
// last committed lines it counts her catchphrases (每 N 句最多 1 次), questions she keeps asking, lines that open by
// echoing the user's words, and a run of questions (intent 打听). The `voice` section says only what is wrong.

export const WINDOW = 8;
export const DEFAULT_EVERY = 4;
export const SAME_QUESTION = 0.5;   // bigram Jaccard at or above this is the same question
export const INTENTS = ['分享', '提议', '打听', '逗', '抱怨', '安慰', '拒绝', '回应'];
export const GIVING = ['分享', '提议', '逗', '抱怨', '安慰'];

const han = s => String(s || '').replace(/[^\p{Script=Han}A-Za-z0-9]/gu, '');
const grams = s => { const t = han(s); const out = new Set(); for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2)); if (t.length === 1) out.add(t); return out; };
export function jaccard(a, b) {
  const x = grams(a), y = grams(b);
  if (!x.size || !y.size) return 0;
  let n = 0;
  for (const g of x) if (y.has(g)) n++;
  return n / (x.size + y.size - n);
}

/**
 * Catchphrases from the card's 口头习惯: the words inside 「」 with ellipses and punctuation dropped; fewer than 2
 * characters left (「……吧。」) is not a catchphrase. 「（每 N 句最多 1 次）」 on the item sets N.
 */
export function catchphrases(card) {
  const out = [];
  for (const item of card?.voice?.habits || []) {
    const q = /「([^」]+)」/.exec(item);
    if (!q) continue;
    const phrase = q[1].replace(/…+|\.{3,}/g, '').replace(/[\p{P}\s]/gu, '');
    if ([...phrase].length < 2) continue;
    const every = /每\s*(\d+)\s*句最多\s*1\s*次/.exec(item);
    out.push({ phrase, every: every ? Number(every[1]) : DEFAULT_EVERY });
  }
  return out;
}

/** The questions in a line: each sentence ending in ？/?, back to the previous sentence end. */
export function questions(text) {
  const out = [];
  let start = 0;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if ('。！!…；;'.includes(ch)) start = i + 1;
    else if (ch === '？' || ch === '?') {
      // The question is the last clause ("火灭了，你拾柴还是我拾" → "你拾柴还是我拾"), or the last two when it is short.
      const parts = s.slice(start, i).split(/[，,、：:]/).map(x => x.trim()).filter(x => han(x));
      let q = parts.at(-1) || '';
      if (parts.length > 1 && han(q).length < 4) q = `${parts.at(-2)}，${q}`;
      if (han(q)) out.push(q);
      start = i + 1;
    }
  }
  return out;
}

/** "小远。" opening a reply to "我叫小远": at most 4 characters before the first 。, all of them in the user's line. */
export function echoOpening(reply, userLine) {
  const m = /^([^。！？!?]{1,4})。/.exec(String(reply || '').trim());
  if (!m || !userLine) return null;
  const head = han(m[1]);
  return head && [...head].every(ch => String(userLine).includes(ch)) ? m[1] : null;
}

/** Groups questions that are the same question (Jaccard ≥ SAME_QUESTION); newest first in, counts per group. */
function clusters(qs) {
  const groups = [];
  for (const q of qs) {
    const g = groups.find(x => jaccard(x.text, q) >= SAME_QUESTION);
    if (g) g.n++; else groups.push({ text: q, n: 1 });
  }
  return groups;
}

/** Pure analysis of her recent lines (newest first). lines: [{ text, user, intent }]. */
export function analyzeLines(lines, phrases) {
  const recent = lines.slice(0, WINDOW);
  const tics = phrases.map(p => ({ ...p, n: recent.filter(l => l.text.includes(p.phrase)).length, inWindow: recent.slice(0, p.every - 1).filter(l => l.text.includes(p.phrase)).length }));
  const nagging = clusters(recent.flatMap(l => questions(l.text))).filter(g => g.n >= 2);
  const echoes = recent.slice(0, 4).map(l => echoOpening(l.text, l.user)).filter(Boolean);
  const intents = recent.slice(0, 3).map(l => l.intent);
  return { tics, nagging, echoes, askingRun: intents.length === 3 && intents.every(i => i === '打听') };
}

/** The `voice` section's lines (empty when nothing is wrong). */
export function voiceLines(a) {
  const out = [];
  for (const t of a.tics) if (t.inWindow > 0) out.push(`最近 ${t.every} 句里你已经说过「${t.phrase}」，这句别用。`);
  for (const g of a.nagging) out.push(`「${g.text}」你已经问了 ${g.n} 次。别再问了：要么你自己拿主意，要么换个话题。`);
  if (a.echoes.length >= 2) out.push(`你最近好几句都拿他的话开头（${a.echoes.map(e => `「${e}。」`).join('')}），这句直接说事。`);
  if (a.askingRun) out.push('你最近三句都在问问题。这句换成说一件你的事、出个主意或者开个玩笑。');
  return out;
}

export function createVoice(lab) {
  const { ledger, db } = lab;

  /** Her last committed lines, newest first, each with the user's line just before it and the turn's intent. */
  function lines(saveId, charId, limit = WINDOW) {
    const evs = ledger.list(saveId, { types: ['user_said', 'char_said'], desc: true, limit: limit * 4 + 8 });
    const out = [];
    for (let i = 0; i < evs.length && out.length < limit; i++) {
      const e = evs[i];
      if (e.type !== 'char_said' || e.actor !== charId || !e.payload?.text || e.payload.host_line) continue;
      const user = evs.slice(i + 1).find(x => x.type === 'user_said' && x.payload?.to === charId);
      const turn = db.prepare('SELECT intent FROM turns WHERE save_id = ? AND reply_seq = ? AND committed = 1 LIMIT 1').get(saveId, e.seq);
      out.push({ text: e.payload.text, user: user?.payload?.text || '', intent: turn?.intent || null, seq: e.seq });
    }
    return out;
  }

  const phrasesOf = (saveId, charId) => catchphrases(lab.scene(saveId).characters.find(c => c.id === charId)?.card);
  const on = saveId => lab.features(saveId).voice;

  function analyze(saveId, charId) { return analyzeLines(lines(saveId, charId), phrasesOf(saveId, charId)); }

  /**
   * 3.0 E2: what is wrong with a new line before it is said: a catchphrase used again inside its window, or a
   * question she has already asked (in the nagging list, or once in her last 4 lines).
   */
  function problems(saveId, charId, say) {
    if (!on(saveId)) return { tics: [], repeats: [] };
    const recent = lines(saveId, charId);
    const a = analyzeLines(recent, phrasesOf(saveId, charId));
    const tics = a.tics.filter(t => t.inWindow > 0 && String(say).includes(t.phrase)).map(t => t.phrase);
    const asked = [...a.nagging.map(g => g.text), ...recent.slice(0, 4).flatMap(l => questions(l.text))];
    const repeats = [...new Set(questions(say).filter(q => asked.some(x => jaccard(x, q) >= SAME_QUESTION)))];
    return { tics, repeats };
  }

  function section(saveId, charId) {
    if (!on(saveId)) return { text: '', refs: [] };
    const out = voiceLines(analyze(saveId, charId));
    return { text: out.join('\n'), refs: [], why: `宿主数了你最近 ${WINDOW} 句：口头禅限额、反复问的问题、拿他的话开头、连着问问题` };
  }

  return { analyze, problems, section, lines };
}

/** 3.0 E2: deterministic fallback — drop a catchphrase that opens a sentence (「先说好，」「先说好。」). */
export function stripPhrase(say, phrase) {
  const re = new RegExp(`(^|[。！？!?…]\\s*)${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[，,。、：:]?\\s*`, 'g');
  return String(say).replace(re, '$1').trim();
}
