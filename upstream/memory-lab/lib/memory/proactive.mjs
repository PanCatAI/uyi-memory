// Rule-based proactive recall (PLAN §4.10) and the delivery receipt that records what was actually said.
import { pj } from '../db.mjs';
import { HOUR, DAY } from '../clock.mjs';
import { sessionInfo } from './common.mjs';
import { sameArea } from '../scene.mjs';
import { cooldownTurns } from './relationship.mjs';

const TRANSIENT = ['look_at', 'wave', 'idle']; // momentary: not worth bringing up
const RULE_TEXT = {
  commitment_due: '约定到时间了', session_open: '用户隔了一段时间回来', same_place: '你们以前在这里一起经历过',
  same_object: '你们以前和这个东西有过故事', callback: '用户这次早些时候说过',
  new_thing: '用户（造物者）新搭的东西，你第一次和它在一处', fire_out_night: '夜里篝火灭了（可以去添柴：tend_fire）'
};

export function createProactive(lab) {
  const { db, ledger, clock } = lab;
  const allowed = (saveId, charId, ref) => lab.admission.allowed(saveId, charId, ref, 'hint');

  /** Newest valid cache of this character covering event seq, else the event itself. */
  function refForEvent(saveId, charId, seq) {
    const caches = lab.observe.live(saveId, charId, 'observation').concat(lab.observe.live(saveId, charId, 'episode'))
      .filter(c => c.derived_from.includes(seq)).sort((a, b) => b.created_at - a.created_at);
    return caches.length ? `cache:${caches[0].id}` : `ev:${seq}`;
  }

  function firstAllowed(saveId, charId, refs) {
    for (const ref of refs) if (allowed(saveId, charId, ref)) return ref;
    return null;
  }

  // What happened in a place or to a thing is worth more than what was said there: real actions first (the user's,
  // and this character's own successful, lasting ones), then the words; newest first within each.
  function placeOrObjectRefs(saveId, charId, match) {
    const now = clock.now(saveId);
    const evs = ledger.list(saveId, { types: ['user_said', 'user_action', 'char_action'], all: true })
      .filter(e => e.t <= now - DAY && match(e) && (e.type !== 'char_action' || (e.actor === charId && e.outcome === 'ok' && !TRANSIENT.includes(e.action)))).reverse();
    const acts = evs.filter(e => e.type !== 'user_said'), words = evs.filter(e => e.type === 'user_said');
    return [...new Set([...acts, ...words].map(e => refForEvent(saveId, charId, e.seq)))];
  }

  /** Returns [{ ref, rule, reason }], at most 1 plus an optional commitment_due. */
  function hints({ saveId, charId, turnIndex, inputSeq }) {
    const now = clock.now(saveId);
    const info = sessionInfo(lab, saveId);
    const state = ledger.world(saveId);
    const out = [];
    const openCommits = lab.commitments.list(saveId, charId, 'open');

    const due = firstAllowed(saveId, charId, openCommits.filter(c => c.due_at != null && c.due_at <= now).map(c => `commit:${c.id}`));
    if (due) out.push({ ref: due, rule: 'commitment_due' });

    // Cap: a proactive mention in the last 5 user turns blocks everything except commitments that are due.
    // 2.0 D5: 5 × the stage's cooldown (初识 8, 熟悉 5, 亲近 4, 挚友 4).
    const cap = cooldownTurns(lab.relationship.compute(saveId, charId).stage);
    const userTurns = ledger.list(saveId, { types: ['user_said'], desc: true, limit: cap + 1 });
    const since = userTurns.length > cap ? userTurns[cap].seq : 0;
    const recentProactive = ledger.list(saveId, { after: since, types: ['char_said'], all: true }).some(e => e.actor === charId && e.payload?.proactive);
    if (recentProactive) return out;

    const rules = [];
    if (turnIndex === 1 && info.current && info.previousEnd && info.current.t - info.previousEnd.t >= 6 * HOUR) {
      rules.push(['session_open', () => {
        const prevEnd = info.previousEnd;
        const soon = openCommits.filter(c => c.due_at != null && c.due_at <= now + 12 * HOUR).map(c => `commit:${c.id}`);
        const offscreen = ledger.list(saveId, { after: prevEnd.seq, types: ['char_action'], actor: charId, all: true }).filter(e => e.offscreen && e.outcome === 'ok' && !TRANSIENT.includes(e.action)).map(e => `ev:${e.seq}`);
        const facts = lab.facts.active(saveId, charId).filter(f => ['relation_to_object', 'plan', 'state'].includes(f.predicate) && f.recorded_at >= now - 14 * DAY).reverse().map(f => `fact:${f.id}`);
        const from = info.previousStart?.seq ?? 0;
        const obs = lab.observe.live(saveId, charId, 'observation').filter(c => c.to_seq > from && c.from_seq <= prevEnd.seq).sort((a, b) => a.priority - b.priority || b.created_at - a.created_at).map(c => `cache:${c.id}`);
        return [...soon, ...offscreen, ...facts, ...obs];
      }]);
    }
    const room = state.characters[charId]?.room;
    // 2.0 C2: something the user built in 造物台, now in this character's area, never brought up before (once, ever).
    // First of the rules: a new thing right in front of her beats an old memory (S2 step 8 asks right after a gap).
    rules.unshift(['new_thing', () => {
      const scene = lab.scene(saveId);
      const ever = ref => db.prepare('SELECT 1 FROM mentions WHERE save_id = ? AND character_id = ? AND memory_ref = ? LIMIT 1').get(saveId, charId, ref);
      return ledger.list(saveId, { types: ['world_edit'], desc: true, all: true })
        .filter(e => e.payload?.op === 'add' && state.objects[e.target] && sameArea(scene, room, state.objects[e.target].room))
        .map(e => `ev:${e.seq}`).filter(ref => !ever(ref));
    }]);
    rules.push(['same_place', () => placeOrObjectRefs(saveId, charId, e => e.room === room)]);
    const lastTarget = ledger.list(saveId, { before: inputSeq, desc: true, limit: 5 }).find(e => e.target && state.objects[e.target])?.target;
    if (lastTarget) rules.push(['same_object', () => placeOrObjectRefs(saveId, charId, e => e.target === lastTarget || e.payload?.args?.target === lastTarget)]);
    if (turnIndex >= 9 && info.current) {
      rules.push(['callback', () => lab.facts.active(saveId, charId).filter(f => ['state', 'plan'].includes(f.predicate) && f.recorded_at >= info.current.t).map(f => `fact:${f.id}`)]);
    }
    // 2.0 C5, lowest priority: the fire went out and it is night.
    rules.push(['fire_out_night', () => lab.environment.fireOutRefs(saveId, charId)]);
    for (const [rule, candidates] of rules) {
      const ref = firstAllowed(saveId, charId, candidates().filter(r => !out.some(h => h.ref === r)));
      if (ref) { out.push({ ref, rule }); break; }
    }
    return out.map(h => ({ ...h, reason: RULE_TEXT[h.rule] }));
  }

  /** Delivery receipt: the reply was shown, so its used refs now count as mentioned. Idempotent. */
  function recordDelivered(turnId) {
    const turn = db.prepare('SELECT * FROM turns WHERE id = ?').get(turnId);
    if (!turn || !turn.committed || turn.reply_seq == null) return { ok: false };
    if (db.prepare('SELECT 1 FROM mentions WHERE save_id = ? AND seq = ? LIMIT 1').get(turn.save_id, turn.reply_seq)) return { ok: true, already: true };
    const ev = ledger.get(turn.save_id, turn.reply_seq);
    if (!ev?.payload) return { ok: false };
    const hintRefs = new Set((pj(turn.sections_json, []).find(s => s.name === 'hints')?.refs) || []);
    for (const ref of ev.payload.used || []) {
      db.prepare('INSERT INTO mentions (save_id, character_id, memory_ref, seq, t, proactive, session_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(turn.save_id, turn.character_id, ref, ev.seq, ev.t, hintRefs.has(ref) ? 1 : 0, ev.session_id);
    }
    return { ok: true };
  }

  return { hints, recordDelivered };
}
