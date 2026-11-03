// Observation log and episodes (PLAN §4.12): model-written narrative, stored as caches with derived_from.
import { newId } from '../ids.mjs';
import { j } from '../db.mjs';
import { formatWorldTime } from '../clock.mjs';
import { render } from '../prompts.mjs';
import { estimate } from '../tokens.mjs';
import { visibility, overheardText } from '../perception.mjs';
import { cacheRow, getWatermark, setWatermark, nameOf, eventText } from './common.mjs';

const COUNTED = ['user_said', 'char_said', 'user_action', 'char_action'];
const SKIP = ['session_start', 'session_end', 'time_skip', 'memory_op', 'scene_imported', 'weather', 'relationship_stage'];
export const OBSERVE_EVERY = 8;
export const REFLECT_TOKENS = 1500;

export function createObserve(lab) {
  const { db, ledger, clock } = lab;

  const live = (saveId, charId, kind) => db.prepare('SELECT * FROM caches WHERE save_id = ? AND character_id = ? AND kind = ? AND invalid = 0 ORDER BY from_seq, created_at, rowid').all(saveId, charId, kind).map(cacheRow);

  /** Events after `after` (and up to `upTo`) this character may write about, already rewritten for overheard speech. */
  function visibleEvents(saveId, charId, after, upTo = Infinity) {
    const scene = lab.scene(saveId);
    const gone = lab.admission.forgottenSet(saveId, charId);
    const out = [];
    for (const ev of ledger.list(saveId, { after, all: true })) {
      if (ev.seq > upTo) break;
      if (SKIP.includes(ev.type) || !ev.payload || gone.has(ev.seq)) continue;
      const v = visibility(ev, charId);
      if (v === 'none') continue;
      out.push(v === 'overheard' ? { ...ev, overheard: true, payload: { to: ev.payload.to, text: overheardText(ev, scene) } } : ev);
    }
    return out;
  }

  function line(scene, ev) {
    const n = id => nameOf(scene, id);
    let what;
    if (ev.overheard) what = ev.payload.text;
    else if (ev.type === 'user_said') what = `用户对${n(ev.payload.to)}说：${ev.payload.text}`;
    else if (ev.type === 'char_said') what = `${n(ev.actor)}对${n(ev.payload.to)}说：${ev.payload.text}`;
    else if (ev.type === 'char_action') what = eventText(scene, { ...ev, offscreen: 0 }); // offscreen is tagged below
    else if (ev.type === 'user_action') what = `用户 ${ev.action} ${n(ev.target)}${ev.payload.args?.to ? ` → ${n(ev.payload.args.to)}` : ''}`;
    else if (ev.type === 'char_moved') what = `${n(ev.actor)}从${n(ev.payload.from)}走到${n(ev.payload.to)}`;
    else if (ev.type === 'object_created') what = `${n(ev.room)}出现了${ev.payload.object?.name || n(ev.target)}`;
    else what = `${ev.type} ${n(ev.target)}`;
    const tags = [ev.offscreen ? '不在场' : null, ev.user_presence === 'maybe' ? '可能看到' : null].filter(Boolean);
    return `[${ev.seq}] ${formatWorldTime(ev.t)} ${what}${tags.length ? `（${tags.join('，')}）` : ''}`;
  }

  async function writeFor(saveId, charId, events) {
    if (!events.length) return [];
    const scene = lab.scene(saveId);
    const save = lab.saves.getSave(saveId);
    const recent = live(saveId, charId, 'observation').slice(-20);
    const allowed = new Set(events.map(e => e.seq));
    const names = Object.fromEntries([...scene.characters, ...scene.objects, ...scene.palette, ...scene.rooms].map(x => [x.id, x.name]));
    const out = await lab.llm.callChecked({
      purpose: 'observe', system: '你只输出 JSON。', saveId,
      user: render('observe', { character_name: nameOf(scene, charId), user_name: save.user_name, recent_log: recent.map(c => c.text).join('\n') || '（无）', events: events.map(e => line(scene, e)).join('\n') }),
      mockInput: { events, charName: nameOf(scene, charId), names }
    });
    const from = events[0].seq, to = events.at(-1).seq, now = clock.now(saveId);
    // The model call took a while: anything forgotten or deleted meanwhile must not be written back.
    const gone = lab.admission.forgottenSet(saveId, charId);
    const stillThere = s => !gone.has(s) && Boolean(ledger.get(saveId, s)?.payload);
    const ids = [];
    for (const o of out.observations) {
      const seqs = o.seqs.filter(s => allowed.has(s));
      if (!seqs.length || seqs.length !== o.seqs.length || !seqs.every(stillThere)) continue;
      const id = newId('c');
      db.prepare('INSERT INTO caches (id, save_id, character_id, kind, text, priority, derived_from, from_seq, to_seq, generation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, saveId, charId, 'observation', o.text, o.priority, j(seqs), from, to, save.generation, now);
      ids.push(id);
    }
    return ids;
  }

  /** Writes observations when ≥ 8 counted events piled up after the watermark, or always when force. */
  async function run(saveId, charId, { force = false } = {}) {
    const wm = getWatermark(lab, saveId, charId, 'observe');
    const last = ledger.lastSeq(saveId);
    const events = visibleEvents(saveId, charId, wm, last);
    if (!force && events.filter(e => COUNTED.includes(e.type)).length < OBSERVE_EVERY) return [];
    let ids;
    // The watermark only moves on success, so a failed range is retried by the next run; job_runs keeps the record.
    try { ids = await writeFor(saveId, charId, events); }
    catch (e) { lab.jobs.fail(saveId, charId, 'observe', wm + 1, last, e.message); e.recorded = true; throw e; }
    setWatermark(lab, saveId, charId, 'observe', last);
    lab.jobs.recoverUpTo(saveId, charId, 'observe', last);
    try { await reflect(saveId, charId); }
    catch (e) { lab.jobs.fail(saveId, charId, 'reflect', wm + 1, last, e.message); e.recorded = true; throw e; }
    return ids;
  }

  /** Rebuild: same as run, for a fixed range, without touching the watermark. */
  const observeRange = (saveId, charId, fromSeq, toSeq) => writeFor(saveId, charId, visibleEvents(saveId, charId, fromSeq - 1, toSeq));

  async function reflect(saveId, charId) {
    const obs = live(saveId, charId, 'observation');
    if (obs.reduce((n, c) => n + estimate(c.text), 0) <= REFLECT_TOKENS) return [];
    const old = obs.slice(0, Math.ceil(obs.length / 2));
    const allowed = new Set(old.map(c => c.id));
    const out = await lab.llm.callChecked({
      purpose: 'reflect', system: '你只输出 JSON。', saveId,
      user: render('reflect', { character_name: nameOf(lab.scene(saveId), charId), observations: old.map(c => `${c.id} [p${c.priority}] ${c.text}`).join('\n') }),
      mockInput: { observations: old }
    });
    const save = lab.saves.getSave(saveId), now = clock.now(saveId);
    const still = new Set(live(saveId, charId, 'observation').map(c => c.id)); // invalidated while the model ran → skip
    const used = new Set();
    for (const ep of out.episodes) {
      const src = old.filter(c => ep.from_ids.includes(c.id) && allowed.has(c.id) && still.has(c.id));
      if (!src.length) continue;
      const seqs = [...new Set(src.flatMap(c => c.derived_from))].sort((a, b) => a - b);
      db.prepare('INSERT INTO caches (id, save_id, character_id, kind, text, priority, derived_from, from_seq, to_seq, generation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(newId('c'), saveId, charId, 'episode', ep.text, Math.min(...src.map(c => c.priority)), j(seqs), Math.min(...src.map(c => c.from_seq)), Math.max(...src.map(c => c.to_seq)), save.generation, now);
      src.forEach(c => used.add(c.id));
    }
    for (const id of used) db.prepare("UPDATE caches SET invalid = 1, invalid_reason = 'reflected' WHERE id = ?").run(id);
    return [...used];
  }

  /** Counted events waiting since the watermark (turn.mjs uses it to decide whether to enqueue). */
  const backlog = (saveId, charId) => visibleEvents(saveId, charId, getWatermark(lab, saveId, charId, 'observe')).filter(e => COUNTED.includes(e.type)).length;

  return { run, observeRange, reflect, live, backlog, visibleEvents };
}
