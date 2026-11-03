// "Off-screen life lite" (PLAN §4.13): when the user comes back, each character did 1–3 legal things meanwhile.
import { HOUR, formatSpan, formatWorldTime } from '../clock.mjs';
import { render } from '../prompts.mjs';
import { checkAction, actionEvents, actionsText } from '../arbiter.mjs';
import { roomOf } from '../world.mjs';
import { visibility } from '../perception.mjs';
import { newId } from '../ids.mjs';
import { j } from '../db.mjs';
import { nameOf } from './common.mjs';

export const CATCHUP_MIN_GAP = 2 * HOUR;
export const catchupCount = gapMs => Math.min(3, 1 + Math.floor(gapMs / (8 * HOUR)));

export function createCatchup(lab) {
  const { ledger, db } = lab;

  /** Runs for one character. gap = how long the user was away; actions get times spread over (fromT, toT). */
  async function run(saveId, charId, { gap, fromT, toT }) {
    if (gap < CATCHUP_MIN_GAP) return [];
    const k = catchupCount(gap);
    const scene = lab.scene(saveId);
    const state = ledger.world(saveId);
    const c = state.characters[charId];
    const card = scene.characters.find(x => x.id === charId);
    const here = Object.values(state.objects).filter(o => roomOf(state, o.id) === c.room);
    const allowed = [];
    for (const name of ['clean', 'sit', 'look_at']) for (const o of here) {
      const a = { name, target: o.id };
      if (checkAction(state, scene, charId, a, { userPresent: false }).ok) allowed.push(a);
    }
    const recent = ledger.list(saveId, { desc: true, limit: 30 }).filter(e => e.payload && visibility(e, charId) === 'full').slice(0, 10).reverse();
    const out = await lab.llm.callChecked({
      purpose: 'catchup', system: '你只输出 JSON。', saveId,
      user: render('catchup', {
        gap_text: formatSpan(gap), character_name: card.name, k, character_card: card.cardText, room: nameOf(scene, c.room),
        objects: here.map(o => `${o.id}（${o.name}）`).join('、') || '（没有）', actions: actionsText(scene),
        events: recent.map(e => `${formatWorldTime(e.t)} ${e.type} ${e.actor} ${e.action || ''} ${e.target || ''} ${e.payload?.text || ''}`).join('\n') || '（无）'
      }),
      mockInput: { allowed }
    });
    const appended = [];
    const kept = [];
    const proposals = out.actions.slice(0, k);
    for (let i = 0; i < proposals.length; i++) {
      const a = { name: proposals[i].name, target: proposals[i].target || null, args: proposals[i].args || {} };
      const st = ledger.world(saveId);
      const check = checkAction(st, scene, charId, a, { userPresent: false });
      if (!check.ok) { kept.push({ ...proposals[i], rejected: check.reason }); continue; }
      const t = Math.round(fromT + ((toT - fromT) * (i + 1)) / (proposals.length + 1));
      const evs = actionEvents(st, scene, charId, a, check, { offscreen: true, t });
      appended.push(...ledger.appendMany(saveId, evs));
      kept.push(proposals[i]);
    }
    db.prepare("INSERT INTO turns (id, save_id, character_id, mode, committed, sections_json, prompt_json, output_json, generation, t) VALUES (?, ?, ?, 'catchup', 0, '[]', '[]', ?, ?, ?)")
      .run(newId('t'), saveId, charId, j(kept), lab.saves.getSave(saveId).generation, toT);
    return appended;
  }

  return { run };
}
