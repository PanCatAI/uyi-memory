// Relationship card: a deterministic fold over ledger events and the commitments table. No model call.
// 2.0 D5: the stage now changes behaviour (STAGE_TABLE), a stage change is written as relationship_stage, and test
// saves can set a floor (saves.relationship_floor, set_relationship_floor in scenarios; not in the UI).
import { DAY, formatAgo } from '../clock.mjs';
import { STAGES, stageIndex } from '../card.mjs';

/**
 * What each stage allows. address = how she calls the user; idleBudget = idle lines per session (D2);
 * cooldown = multiplier on the 1.0 proactive cap (a proactive mention blocks the next 5 user turns);
 * secrets = whether 秘密 may enter the context at all. 过往 entries are gated by their own 可说 stage.
 */
export const STAGE_TABLE = {
  初识: { address: '你', idleBudget: 1, cooldown: 1.5, secrets: false },
  熟悉: { address: '你（知道名字后偶尔叫名字）', idleBudget: 2, cooldown: 1.0, secrets: false },
  亲近: { address: '名字', idleBudget: 3, cooldown: 0.8, secrets: false },
  挚友: { address: '名字', idleBudget: 4, cooldown: 0.7, secrets: true }
};
/** 2.0 D2 name, kept for idle.mjs. */
export const IDLE_BUDGET = Object.fromEntries(STAGES.map(s => [s, STAGE_TABLE[s].idleBudget]));
export const PROACTIVE_CAP_TURNS = 5;
export const cooldownTurns = stage => Math.round(PROACTIVE_CAP_TURNS * STAGE_TABLE[stage].cooldown);

/** The bar for each stage after 初识 (the 1.0 rule, unchanged: the highest stage whose bar is met). */
const NEEDS = {
  熟悉: { talks: 10, days_known: 1 },
  亲近: { talks: 40, days_known: 5, gifts_received: 1 },
  挚友: { talks: 150, days_known: 20, promises_kept: 3 }
};
const NEED_TEXT = { talks: n => `再对话 ${n} 次`, days_known: n => `再过 ${n} 天`, gifts_received: n => `再收 ${n} 件礼物`, promises_kept: n => `再做到 ${n} 个约定` };
const meets = (r, need) => Object.entries(need).every(([k, v]) => r[k] >= v);

export function createRelationship(lab) {
  const { db } = lab;
  const floorOf = saveId => db.prepare('SELECT relationship_floor FROM saves WHERE id = ?').get(saveId)?.relationship_floor || null;

  function compute(saveId, charId) {
    const evs = lab.ledger.list(saveId, { types: ['user_said', 'session_start', 'session_end', 'user_action'], all: true });
    const talks = evs.filter(e => e.type === 'user_said' && e.payload?.to === charId);
    const now = lab.clock.now(saveId);
    const first = talks[0]?.t;
    const count = status => db.prepare("SELECT count(*) n FROM commitments WHERE save_id = ? AND character_id = ? AND owner = 'character' AND status = ?").get(saveId, charId, status).n;
    const r = {
      days_known: first == null ? 0 : Math.floor((now - first) / DAY),
      sessions: evs.filter(e => e.type === 'session_start').length,
      talks: talks.length,
      gifts: evs.filter(e => e.type === 'user_action' && e.action === 'give' && e.payload?.args?.to === charId).length,
      // 3.0 G3: something done together to the end counts like a gift.
      together: lab.ledger.list(saveId, { types: ['practice'], all: true }).filter(e => e.payload?.phase === 'end').length,
      promises_kept: count('done'),
      promises_broken: count('dropped'),
      last_seen_t: evs.filter(e => e.type === 'session_end').at(-1)?.t ?? null
    };
    r.gifts_received = r.gifts + r.together;
    const earned = [...STAGES].reverse().find(s => s === '初识' || meets(r, NEEDS[s]));
    const floor = floorOf(saveId);
    r.earned_stage = earned;
    r.stage = floor && stageIndex(floor) > stageIndex(earned) ? floor : earned;
    r.floor = floor;
    const next = STAGES[stageIndex(r.stage) + 1];
    r.next = next ? { stage: next, missing: Object.entries(NEEDS[next]).filter(([k, v]) => r[k] < v).map(([k, v]) => NEED_TEXT[k](v - r[k])) } : null;
    return r;
  }

  /** The user's name as she would say it (call_me first, then name), or null. */
  function userName(saveId, charId) {
    const facts = lab.facts.active(saveId, charId);
    return (facts.find(f => f.predicate === 'call_me') || facts.find(f => f.predicate === 'name'))?.object || null;
  }

  function card(saveId, charId) {
    const r = compute(saveId, charId);
    const parts = [`你们认识 ${r.days_known} 天，见过 ${r.sessions} 次，现在算是${r.stage}。`];
    if (r.gifts) parts.push(`用户送过你 ${r.gifts} 样东西。`);
    if (r.together) parts.push(`你们一起做完过 ${r.together} 件事。`);
    if (r.promises_kept || r.promises_broken) parts.push([r.promises_kept && `你答应过的事做到了 ${r.promises_kept} 件`, r.promises_broken && `没做到 ${r.promises_broken} 件`].filter(Boolean).join('、') + '。');
    if (r.last_seen_t != null) parts.push(`上次见面是${formatAgo(lab.clock.now(saveId) - r.last_seen_t)}。`);
    // 2.0 D5: how she addresses the user at this stage.
    const name = userName(saveId, charId);
    const how = STAGE_TABLE[r.stage].address;
    parts.push(`称呼用户：${how === '名字' ? (name ? `叫名字「${name}」` : '还不知道名字，叫「你」') : how === '你' || !name ? '叫「你」' : `平时叫「你」，偶尔叫「${name}」`}。`);
    return parts.join('');
  }

  /**
   * Writes relationship_stage { from, to } when the stage differs from the last one written (初识 before any).
   * Call after anything that can change the counts (each turn, session start). Returns the new event or null.
   */
  function sync(saveId, charId) {
    const last = lab.ledger.list(saveId, { types: ['relationship_stage'], target: charId, desc: true, limit: 1 })[0];
    const from = last?.payload?.to || '初识';
    const to = compute(saveId, charId).stage;
    if (from === to) return null;
    return lab.ledger.append(saveId, { type: 'relationship_stage', actor: 'host', target: charId, room: null, perceivers: [], payload: { from, to } });
  }

  /** Stage changes so far, oldest first: [{ t, from, to }]. */
  const history = (saveId, charId) => lab.ledger.list(saveId, { types: ['relationship_stage'], target: charId, all: true }).map(e => ({ t: e.t, from: e.payload.from, to: e.payload.to }));

  /** Test saves only: never below this stage. null clears it. */
  function setFloor(saveId, stage) {
    if (stage != null && !STAGES.includes(stage)) throw new Error(`阶段名不认识：${stage}`);
    db.prepare('UPDATE saves SET relationship_floor = ? WHERE id = ?').run(stage, saveId);
  }

  return { compute, card, sync, history, setFloor, userName };
}
