// 3.0 G1: 话头 — the one thing on her mind right now, from the scene's topic table (scenes/camp.topics.json). Of the
// topics whose condition holds and that are not cooling down, the most specific (most condition keys, plus the
// topic's priority for the big and one-time ones) wins; a tie is
// broken by rand01(save, 'topic', turn). She "said" it only when her reply's used has topic:<id>: then it cools down
// for cooldown_turns user turns, once_per_session ones wait for the next session, once ones never come back. Not
// said → no cooldown, still there next turn. No model calls. Only with features.topics (and the world on).
import { rand01 } from '../rand.mjs';
import { match, specificity } from '../rules.mjs';
import { sessionInfo, turnIndexInSession } from './common.mjs';
import { visibility } from '../perception.mjs';

export const UNTOLD_DAYS = 3;

export function createTopics(lab) {
  const { ledger, db } = lab;
  const on = saveId => Boolean(lab.scene(saveId).rules) && lab.features(saveId).topics;
  const topicsOf = saveId => lab.scene(saveId).topics || [];
  /** Turns where she said a topic: newest first, with the reply's seq. */
  const said = (saveId, charId, id) => db.prepare('SELECT t, reply_seq FROM turns WHERE save_id = ? AND character_id = ? AND topic = ? AND committed = 1 ORDER BY t DESC, rowid DESC').all(saveId, charId, id);

  /** Why a topic is not available (null = it is): cooling down, said this session, said once already. */
  function resting(saveId, charId, topic) {
    const rows = said(saveId, charId, topic.id);
    if (!rows.length) return null;
    if (topic.once) return '说过了（只说一次）';
    const cur = sessionInfo(lab, saveId).current;
    if (topic.once_per_session && cur && rows[0].t >= cur.t) return '这次会话说过了';
    const since = rows[0].reply_seq ? ledger.list(saveId, { types: ['user_said'], after: rows[0].reply_seq, all: true }).filter(e => e.payload?.to === charId).length : Infinity;
    return since < (topic.cooldown_turns ?? 0) ? `冷却中（还差 ${topic.cooldown_turns - since} 轮）` : null;
  }

  /**
   * Incidents she lived through that the user did not see (and she has not told yet): the has_untold key.
   * Told = she said the topic that is about it (its when.has_untold) after the incident started.
   */
  function untold(saveId, charId) {
    if (!charId) return [];
    const t = lab.clock.now(saveId);
    const starts = ledger.list(saveId, { types: ['incident'], desc: true, limit: 100 })
      .filter(e => e.payload?.phase === 'start' && t - e.t <= UNTOLD_DAYS * 86_400_000 && e.user_presence !== 'present' && visibility(e, charId) === 'full');
    const out = [];
    for (const e of starts) {
      const id = e.payload.incident;
      if (out.includes(id)) continue;
      const about = topicsOf(saveId).filter(x => x.when?.has_untold === id);
      if (about.some(x => said(saveId, charId, x.id).some(r => r.t >= e.t))) continue;
      out.push(id);
    }
    return out;
  }

  /** The topic for this turn, or null. → { id, direction, specificity, candidates } */
  function pick(saveId, charId) {
    if (!on(saveId)) return null;
    const ctx = lab.rules.context(saveId, charId);
    const open = topicsOf(saveId).filter(x => match(x.when, ctx) && !resting(saveId, charId, x));
    if (!open.length) return null;
    const score = x => specificity(x.when) + (x.priority || 0);
    const top = Math.max(...open.map(score));
    const best = open.filter(x => score(x) === top);
    const chosen = best[Math.floor(rand01(saveId, 'topic', ledger.lastSeq(saveId), turnIndexInSession(lab, saveId)) * best.length)];
    return { ...chosen, specificity: top, candidates: open.map(x => x.id) };
  }

  function section(saveId, charId) {
    const tp = pick(saveId, charId);
    if (!tp) return { text: '', refs: [] };
    return {
      text: `[topic:${tp.id}] 你心里正惦记着：${tp.direction}。（想说就说，别硬塞；这一节和「可以提起」最多用一件；说了就把 topic:${tp.id} 填进 used）`,
      refs: [`topic:${tp.id}`],
      why: `条件满足的话头里得分最高的（条件数 + 优先级 = ${tp.specificity}）；候选：${tp.candidates.join('、')}`
    };
  }

  return { pick, section, untold, resting, on };
}
