// 2.0 D2: when the user is around but quiet, the character has a thought and sometimes says something.
// One background call (purpose 'idle') per quiet stretch: { thought, urge, say, ref, action }. The host decides whether
// the line is said: urge ≥ 0.6, the session's idle budget (by relationship stage) not used up, and 5 world minutes
// since her last idle line. The thought is stored either way (turns.thought, mode 'idle') and never used again.
import { realNow, formatWorldTime } from '../clock.mjs';
import { render } from '../prompts.mjs';
import { sameArea } from '../scene.mjs';
import { planActions, actionEvents, actionList } from '../arbiter.mjs';
import { IDLE_BUDGET } from './relationship.mjs';
import { newId } from '../ids.mjs';
import { j } from '../db.mjs';
import { INTENTS } from './voice.mjs';

export const QUIET_REAL_MS = 60_000;      // real time without a word from the user before she may think aloud
export const URGE_MIN = 0.6;
export const IDLE_GAP_MS = 5 * 60_000;    // world time between two idle lines
export const HOURLY_CAP = 20;             // idle calls per save per real hour

export function createIdle(lab) {
  const { db, ledger, clock } = lab;
  const lastUserReal = new Map(); // saveId → real ms of the last user_said / session_start (in memory only)
  ledger.onAppend((saveId, ev) => { if (ev.type === 'user_said' || ev.type === 'session_start') lastUserReal.set(saveId, realNow()); });

  const idleLines = (saveId, charId) => ledger.list(saveId, { types: ['char_said'], actor: charId, desc: true, limit: 200 }).filter(e => e.payload?.idle);

  /** Why she will not think aloud now, or null. */
  function blocked(saveId, charId, now) {
    const save = lab.saves.getSave(saveId);
    if (!save.session_id) return 'no_session';
    const st = ledger.world(saveId);
    const c = st.characters[charId];
    if (!c || !sameArea(lab.scene(saveId), st.userRoom, c.room)) return 'user_away';
    if (lab.life.now(saveId, charId)?.asleep) return 'asleep';
    const last = lastUserReal.get(saveId);
    if (last != null && now - last < QUIET_REAL_MS) return 'not_quiet';
    const calls = db.prepare("SELECT count(*) n FROM llm_calls WHERE save_id = ? AND purpose = 'idle' AND real_at >= ?").get(saveId, now - 3_600_000).n;
    if (calls >= HOURLY_CAP) return 'hour_cap';
    return null;
  }

  /**
   * One idle moment for a character. now = real ms (tests pass it). Returns { skipped } or
   * { turnId, thought, urge, spoke, why, events }.
   */
  async function run(saveId, charId, { now = realNow() } = {}) {
    const skipped = blocked(saveId, charId, now);
    if (skipped) return { skipped };
    const scene = lab.scene(saveId);
    const card = scene.characters.find(c => c.id === charId);
    const inputSeq = ledger.lastSeq(saveId);
    const hints = lab.proactive.hints({ saveId, charId, turnIndex: 2, inputSeq });
    const topic = lab.topics.pick(saveId, charId); // 3.0 G1: what is on her mind goes into the idle moment too
    const sec = name => lab.context.section(name, { saveId, charId, inputSeq, hints }).text;
    const recent = sec('recent').split('\n').filter(Boolean).slice(-6).join('\n');
    const out = await lab.llm.callChecked({
      purpose: 'idle', saveId, system: '你只输出 JSON。', maxTokens: 300,
      user: render('idle', {
        character_name: card.name, character_card: card.cardText, now: sec('now'), world: sec('world') || '（没有）',
        recent: recent || '（还没说过话）', hints: sec('hints') || '（没有）', self: sec('self') || '（还没有）', intention: lab.diary?.intention?.(saveId, charId) || '（没想好）',
        topic: topic ? `[topic:${topic.id}] ${topic.direction}` : '（没有特别惦记的）'
      }),
      mockInput: { hintRefs: hints.map(h => h.ref) }
    });
    const save = lab.saves.getSave(saveId);
    const stage = lab.relationship.compute(saveId, charId).stage;
    const lines = idleLines(saveId, charId);
    const mine = lines.filter(e => e.session_id === save.session_id);
    const urge = Number(out.urge) || 0;
    const ref = hints.some(h => h.ref === out.ref) || (topic && out.ref === `topic:${topic.id}`) ? out.ref : null;
    let why = null;
    if (!(typeof out.say === 'string' && out.say.trim())) why = '没想说话';
    else if (urge < URGE_MIN) why = `想说的劲不够（${urge}）`;
    else if (mine.length >= IDLE_BUDGET[stage]) why = `这次会话空闲开口已经 ${mine.length} 次（${stage}最多 ${IDLE_BUDGET[stage]}）`;
    else if (lines[0] && clock.now(saveId) - lines[0].t < IDLE_GAP_MS) why = '离上次空闲开口不到 5 分钟';
    // A line with an action is only said when the action can be done (same rule as replies, without the host line).
    const state = ledger.world(saveId);
    const plan = !why && out.action ? planActions(state, scene, charId, out.action) : null;
    if (plan?.failed) why = `动作做不成：${plan.failed.check.reason}`;
    // 2.0 D-gate: an idle line that says the opposite of what she said about herself before is simply not said.
    const claims = Array.isArray(out.self_claims) ? out.self_claims.filter(c => typeof c === 'string' && c.trim()) : [];
    const selfCheck = !why && claims.length ? await lab.selfCanon.check(saveId, charId, { line: out.say, claims }) : { conflicts: [], superseded: [] };
    if (selfCheck.conflicts.length) why = `和她以前说的说反了：${selfCheck.conflicts.map(c => `「${c.text}」`).join('')}`;
    // 3.0 E2: an idle line that repeats a catchphrase over its limit, or a question she already asked, is not said.
    const voice = !why ? lab.voice.problems(saveId, charId, out.say) : { tics: [], repeats: [] };
    if (voice.tics.length || voice.repeats.length) why = `说话重复：${[...voice.tics.map(x => `「${x}」`), ...voice.repeats.map(x => `又问「${x}」`)].join('、')}`;
    const intent = INTENTS.includes(out.intent) ? out.intent : '回应';

    const events = [];
    let replySeq = null;
    if (!why) {
      const said = ledger.append(saveId, { type: 'char_said', actor: charId, payload: { text: out.say.trim(), to: 'user', used: ref ? [ref] : [], proactive: Boolean(ref), idle: true } });
      events.push(said);
      replySeq = said.seq;
      lab.selfCanon.add(saveId, charId, claims, said.seq);
      lab.selfCanon.supersede(saveId, selfCheck.superseded);
      for (const step of plan?.steps || []) {
        if (step.check.noop) continue;
        for (const ev of actionEvents(ledger.world(saveId), scene, charId, step.action, step.check)) events.push(ledger.append(saveId, ev));
      }
    }
    const turnId = newId('t');
    const sections = [{ name: 'hints', refs: hints.map(h => h.ref), why: hints.map(h => h.rule).join('、') }, ...(topic ? [{ name: 'topic', refs: [`topic:${topic.id}`], why: topic.direction }] : [])];
    const saidTopic = !why && ref?.startsWith('topic:') ? ref.slice(6) : null;
    db.prepare('INSERT INTO turns (id, save_id, character_id, mode, committed, reply_seq, sections_json, prompt_json, output_json, rejected_json, generation, t, thought, card_version, intent, topic) VALUES (?, ?, ?, \'idle\', ?, ?, ?, \'[]\', ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(turnId, saveId, charId, why ? 0 : 1, replySeq, j(sections), j({ urge, say: out.say ?? null, ref, action: actionList(out.action), spoke: !why, intent }), j(why ? { why } : {}), save.generation, clock.now(saveId), out.thought || null, lab.cards.version(saveId, charId), intent, saidTopic);
    return { turnId, thought: out.thought || '', urge, intent, spoke: !why, why, say: why ? null : out.say.trim(), events };
  }

  /** Recent idle moments for the side panel: what she thought, and whether she said it. */
  function recentThoughts(saveId, charId, limit = 10) {
    return db.prepare("SELECT id, t, thought, output_json, rejected_json FROM turns WHERE save_id = ? AND character_id = ? AND mode = 'idle' ORDER BY t DESC, rowid DESC LIMIT ?").all(saveId, charId, limit)
      .map(r => { const o = JSON.parse(r.output_json); return { turnId: r.id, at: formatWorldTime(r.t), thought: r.thought, urge: o.urge, said: o.spoke ? o.say : null, why: JSON.parse(r.rejected_json || '{}').why || null }; });
  }

  return { run, recentThoughts, blocked: (saveId, charId, now = realNow()) => blocked(saveId, charId, now) };
}
