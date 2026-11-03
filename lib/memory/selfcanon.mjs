// What a character said about itself (PLAN §4.12). Conflicts with the authored canon are kept but never used.
import { newId } from '../ids.mjs';
import { j } from '../db.mjs';
import { render } from '../prompts.mjs';

const CLAIM = /(不)?(怕|喜欢|讨厌|会|有)([^\s，。！？、,.!?]{1,6})/g;
const triples = text => [...String(text).matchAll(CLAIM)].map(m => ({ neg: Boolean(m[1]), verb: m[2], obj: m[3] }));

/** True when claim says the opposite of a canon line (same verb and object, opposite negation). */
export function conflicts(claim, canon) {
  const mine = triples(claim);
  return canon.some(line => triples(line).some(c => mine.some(m => m.verb === c.verb && (m.obj.startsWith(c.obj) || c.obj.startsWith(m.obj)) && m.neg !== c.neg)));
}

// Claims that a world event happened ("我爬上去了", "我上到一半就停下来了") are facts about the world, not free
// self-description: they need a matching successful host event by this character, or they are kept as 'no_event'.
const EVENT_WORDS = {
  climb: ['爬', '上去', '上到', '上了', '登上'], walk_to: ['走到', '走过去', '去了', '去过', '到了'], pick_up: ['拿起', '拿了', '捡'],
  put_down: ['放下', '放到', '放在'], wear: ['戴上', '戴着', '戴了', '穿上', '穿了'], clean: ['擦'], sit: ['坐到', '坐了', '坐在'],
  switch: ['开灯', '点亮', '打开', '开了', '关了', '关灯', '亮了'], give: ['递给', '给了你']
};
export const claimedActions = text => Object.entries(EVENT_WORDS).filter(([, words]) => words.some(w => String(text).includes(w))).map(([a]) => a);

export function createSelfCanon(lab) {
  const { db } = lab;
  const didOk = (saveId, charId, action) => lab.ledger.list(saveId, { types: ['char_action'], actor: charId, all: true }).some(e => e.action === action && e.outcome === 'ok' && e.payload);
  return {
    /**
     * 2.0 D-gate: does a new line say the opposite of something she said about herself before (her stances and
     * promises too: "掀被子我可不动手")? One background call, only when the line has claims and there are earlier ones.
     * → { conflicts: [{ ref, text, why }], superseded: [ids] } (superseded = earlier claims she explicitly changed her mind on)
     */
    async check(saveId, charId, { line, claims = [] }) {
      const earlier = db.prepare("SELECT id, text FROM self_canon WHERE save_id = ? AND character_id = ? AND status = 'active' ORDER BY created_at DESC, rowid DESC LIMIT 30").all(saveId, charId)
        .map(r => ({ ref: `sc:${r.id}`, id: r.id, text: r.text })).filter(r => !claims.includes(r.text));
      if (!claims.length || !earlier.length) return { conflicts: [], superseded: [] };
      const known = new Map(earlier.map(r => [r.ref, r]));
      const card = lab.scene(saveId).characters.find(c => c.id === charId);
      const out = await lab.llm.callChecked({
        purpose: 'self_check', saveId, system: '你只输出 JSON。', maxTokens: 300,
        user: render('self-check', { character_name: card?.name || charId, earlier: earlier.map(r => `[${r.ref}] ${r.text}`).join('\n'), line: String(line || ''), claims: claims.map(c => `- ${c}`).join('\n') }),
        mockInput: { claims, earlier }
      }, o => [...o.conflicts.map(c => c.ref), ...(o.superseded || [])].filter(r => !known.has(r)).map(r => `${r} 不在列出的说法里`));
      return {
        conflicts: out.conflicts.map(c => ({ ref: c.ref, text: known.get(c.ref).text, why: String(c.why || '') })),
        superseded: (out.superseded || []).map(r => known.get(r).id)
      };
    },
    /** She explicitly changed her mind: the earlier claims stop being used (kept, status 'superseded'). */
    supersede(saveId, ids) { for (const id of ids) db.prepare("UPDATE self_canon SET status = 'superseded' WHERE save_id = ? AND id = ? AND status = 'active'").run(saveId, id); },
    add(saveId, charId, claims, seq, { selfConflict = false } = {}) {
      const canon = lab.scene(saveId).characters.find(c => c.id === charId)?.canon || [];
      const out = [];
      for (const text of claims || []) {
        const t = String(text).trim();
        if (!t || db.prepare('SELECT 1 FROM self_canon WHERE save_id = ? AND character_id = ? AND text = ?').get(saveId, charId, t)) continue;
        const id = newId('sc');
        const claimed = claimedActions(t);
        const status = conflicts(t, canon) ? 'conflicts_canon' : selfConflict ? 'conflicts_self' : claimed.length && !claimed.every(a => didOk(saveId, charId, a)) ? 'no_event' : 'active';
        db.prepare('INSERT INTO self_canon (id, save_id, character_id, text, source_seqs, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(id, saveId, charId, t, j([seq]), status, lab.clock.now(saveId));
        out.push({ id, status });
      }
      return out;
    },
    list: (saveId, charId) => db.prepare('SELECT * FROM self_canon WHERE save_id = ? AND character_id = ? ORDER BY created_at, rowid').all(saveId, charId)
  };
}
