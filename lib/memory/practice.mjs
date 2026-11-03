// 3.0 G3: things the two of them do together (scenes/camp.practices.json): 认星, 守夜, 烤松子. A practice has steps;
// a step is done by the user's words (user_said_any), by her saying so (her reply's practice.step_done) or by an
// action. Her reply may carry practice: { start } | { step_done } | { end }; the host checks it and writes practice
// events. Finished together → a memory of it (an observation she saw herself) and a step on the relationship, like a
// gift. Not finished within max_turns user turns, or the session ends → abandoned, no memory. No model calls.
import { newId } from '../ids.mjs';
import { j } from '../db.mjs';
import { rand01 } from '../rand.mjs';
import { match } from '../rules.mjs';
import { dayOf } from '../climate.mjs';

export function createPractice(lab) {
  const { ledger, db } = lab;
  const on = saveId => Boolean(lab.scene(saveId).rules) && lab.features(saveId).practices;
  const defs = saveId => lab.scene(saveId).practices || [];
  const def = (saveId, id) => defs(saveId).find(p => p.id === id);
  const active = saveId => ledger.world(saveId).practice;
  const host = (saveId, payload) => lab.worldsim.host(saveId, lab.clock.now(saveId), { type: 'practice', room: lab.scene(saveId).user_room, perceivers: lab.scene(saveId).characters.map(c => c.id), payload });
  const startEv = saveId => ledger.list(saveId, { types: ['practice'], desc: true, limit: 20 }).find(e => e.payload?.phase === 'start');
  const turnsSince = (saveId, charId, seq) => ledger.list(saveId, { types: ['user_said'], after: seq, all: true }).filter(e => e.payload?.to === charId).length;

  /** Which practices could start now (for the section, and to check a start). */
  function startable(saveId, charId) {
    if (!on(saveId) || active(saveId)) return [];
    const ctx = lab.rules.context(saveId, charId);
    return defs(saveId).filter(p => match(p.start_when, ctx));
  }

  /** The step done → the next one (or the end). The roll of a step that has one happens as it begins. */
  function advance(saveId, charId, cur, p) {
    const next = cur.step + 1;
    if (next >= p.steps.length) return end(saveId, charId, p);
    const roll = p.steps[next].roll;
    const outcome = roll ? (rand01(saveId, p.id, dayOf(lab.clock.now(saveId)), ledger.lastSeq(saveId)) < roll.p ? roll.yes : roll.no) : undefined;
    return [host(saveId, { practice: p.id, phase: 'step', step: next, ...(outcome ? { outcome } : {}) })];
  }

  function end(saveId, charId, p) {
    const start = startEv(saveId);
    const rolled = ledger.list(saveId, { types: ['practice'], after: start?.seq ?? 0, all: true }).map(e => e.payload?.outcome).filter(Boolean).at(-1) || '';
    const out = [host(saveId, { practice: p.id, phase: 'end', ...(rolled ? { outcome: rolled } : {}) })];
    const fx = p.end_effects || {};
    const cause = `一起${p.name}`;
    if (fx.add) out.push(...lab.worldsim.applyEffects(saveId, { add: fx.add }, cause, out[0].t));
    const burnt = p.steps.some(s => s.roll && s.roll.yes === rolled);
    if (fx.add_unless_rolled && !burnt) out.push(...lab.worldsim.applyEffects(saveId, { add: fx.add_unless_rolled }, cause, out[0].t));
    if (fx.use_up && ledger.world(saveId).objects[fx.use_up]) out.push(ledger.append(saveId, { type: 'object_removed', actor: 'host', target: fx.use_up, payload: {} }));
    if (fx.commitment_done) {
      const k = lab.commitments.list(saveId, charId, 'open').find(x => x.text.includes(fx.commitment_done));
      if (k) lab.commitments.markDone(saveId, charId, [`commit:${k.id}`], out[0].seq);
    }
    // The memory of it: what they did together, seen with her own eyes.
    const user = lab.relationship.userName?.(saveId, charId) || '你';
    const text = `${p.memory_template.replace('{user}', user).replace('{result}', rolled || '')}（一起做的）`;
    const save = lab.saves.getSave(saveId);
    db.prepare('INSERT INTO caches (id, save_id, character_id, kind, text, priority, derived_from, from_seq, to_seq, generation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(newId('c'), saveId, charId, 'observation', text, 1, j([start?.seq, out[0].seq].filter(Boolean)), start?.seq ?? out[0].seq, out[0].seq, save.generation, lab.clock.now(saveId));
    return out;
  }

  function abandon(saveId, why) {
    const cur = active(saveId);
    if (!cur) return [];
    return [host(saveId, { practice: cur.id, phase: 'abandon', outcome: why })];
  }

  /** Before her reply: the user's words may finish the step they were on; too many turns → abandoned. */
  function beforeReply(saveId, charId, userText) {
    if (!on(saveId)) return [];
    const cur = active(saveId);
    if (!cur) return [];
    const p = def(saveId, cur.id);
    const start = startEv(saveId);
    if (!p || turnsSince(saveId, charId, start?.seq ?? 0) > p.max_turns) return abandon(saveId, `${p?.max_turns ?? 0} 轮没做完`);
    const want = p.steps[cur.step]?.done_when;
    if (want?.user_said_any && want.user_said_any.some(w => String(userText).includes(w))) return advance(saveId, charId, cur, p);
    return [];
  }

  /**
   * After her reply (committed): her practice field and what was done. → { events, rejected } (rejected: why a
   * practice field was dropped).
   */
  function afterReply(saveId, charId, field, actions = []) {
    if (!on(saveId)) return { events: [], rejected: field ? '共同活动没开' : null };
    const cur = active(saveId);
    if (!cur) {
      if (!field?.start) return { events: [], rejected: field && (field.step_done || field.end) ? '没有在进行的活动' : null };
      const p = def(saveId, field.start);
      if (!p) return { events: [], rejected: `没有这个活动：${field.start}` };
      if (!startable(saveId, charId).some(x => x.id === p.id)) return { events: [], rejected: `现在不能${p.name}` };
      return { events: [host(saveId, { practice: p.id, phase: 'start', step: 0 })], rejected: null };
    }
    const p = def(saveId, cur.id);
    if (field?.end) return { events: end(saveId, charId, p), rejected: null };
    const want = p.steps[cur.step]?.done_when;
    const done = (want === 'model' && field?.step_done) || (want?.action && actions.some(a => a.name === want.action));
    if (done) return { events: advance(saveId, charId, cur, p), rejected: null };
    return { events: [], rejected: field?.start ? `已经在${p.name}了` : null };
  }

  /** The practice section: what they are doing and her goal for this step; else what could start now. */
  function section(saveId, charId) {
    if (!on(saveId)) return { text: '', refs: [] };
    const cur = active(saveId);
    if (cur) {
      const p = def(saveId, cur.id);
      const outcome = ledger.list(saveId, { types: ['practice'], desc: true, limit: 1 })[0]?.payload?.outcome;
      return { text: `你们在：${p.name}（第 ${cur.step + 1} 步，共 ${p.steps.length} 步）。你这一步想：${p.steps[cur.step].goal}。${outcome ? `结果：${outcome}。` : ''}这一步做到了就在 practice 里填 {"step_done": true}；不想做了填 {"end": true}。`, refs: [], why: '宿主记的共同活动进度' };
    }
    const can = startable(saveId, charId);
    if (!can.length) return { text: '', refs: [] };
    return { text: `现在可以一起做：${can.map(p => `${p.name}（id ${p.id}）`).join('、')}。他想做、或者你邀请他他答应了，就在 practice 里填 {"start": "id"}。`, refs: [], why: '条件满足、能开始的共同活动' };
  }

  /** Session over: whatever was going on is dropped. */
  const sessionEnd = saveId => (on(saveId) ? abandon(saveId, '会话结束了') : []);

  return { beforeReply, afterReply, section, startable, sessionEnd, active };
}
