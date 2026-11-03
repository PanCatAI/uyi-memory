// 2.0 D3: a bedtime diary per world day, and tomorrow's intention taken from it.
// When world time passes 23:00 of a day, a background job (job_runs kind 'diary') writes that day's diary from what
// the character perceived since 23:00 the day before (admission applied) plus that day's observations — never her
// thoughts. Stored as a cache (kind 'diary', derived_from = the refs it cites), so forgetting or deleting a cited
// event rewrites the diary through the 1.0 rebuild. Only characters with a 作息 keep one.
import { DAY, HOUR, formatWorldTime } from '../clock.mjs';
import { render } from '../prompts.mjs';
import { newId } from '../ids.mjs';
import { j } from '../db.mjs';
import { cacheRow, getWatermark, setWatermark, nameOf, eventText } from './common.mjs';

export const DIARY_HOUR = 23;
export const WEEK_CUT = '23:30'; // 2.0 D4: Sunday 23:30, after Sunday's diary
export const MAX_DAYS = 14; // days written at once after a long skip
const TZ = 9 * HOUR;
const TYPES = ['user_said', 'char_said', 'user_action', 'char_action', 'char_moved', 'world_edit', 'fire_out', 'object_created'];

const dayText = t => new Date(t + TZ).toISOString().slice(0, 10);
/** 23:00 (Tokyo) of a day '2026-10-20'. */
export const cutOf = day => Date.parse(`${day}T${String(DIARY_HOUR).padStart(2, '0')}:00:00+09:00`);
const dayNum = day => Number(day.replaceAll('-', ''));
const numDay = n => `${String(n).slice(0, 4)}-${String(n).slice(4, 6)}-${String(n).slice(6, 8)}`;
const nextDay = day => dayText(cutOf(day) + DAY);
const prevDay = day => dayText(cutOf(day) - DAY);
/** 2.0 D4: Sunday 23:30 of the week that day belongs to (weeks run Monday–Sunday). */
const weekdayOf = day => new Date(`${day}T12:00:00+09:00`).getUTCDay(); // 0 = Sunday
export const sundayOf = day => dayText(cutOf(day) + ((7 - weekdayOf(day)) % 7) * DAY);
const weekCut = sunday => Date.parse(`${sunday}T${WEEK_CUT}:00+09:00`);
/** The diary day "today" belongs to for intentions: days turn over at 05:00, as for weather. */
const today = t => dayText(t - 5 * HOUR);

export function createDiary(lab) {
  const { db, ledger, clock } = lab;
  const writing = new Set(); // `${save}|${char}|${day}` queued and not done yet

  const hasRoutine = (saveId, charId) => lab.life.hasRoutine(saveId, charId);
  const live = (saveId, charId) => db.prepare("SELECT * FROM caches WHERE save_id = ? AND character_id = ? AND kind = 'diary' AND invalid = 0 ORDER BY day, created_at, rowid").all(saveId, charId).map(cacheRow);
  const ofDay = (saveId, charId, day) => live(saveId, charId).filter(d => d.day === day).at(-1) || null;

  /** Days whose 23:00 has passed and that have no diary pass yet (watermark = last day handled, as 20261020). */
  function dueDays(saveId, charId) {
    const now = clock.now(saveId);
    const wm = getWatermark(lab, saveId, charId, 'diary');
    const first = ledger.list(saveId, { limit: 1, all: true })[0];
    if (!first) return [];
    let day = wm ? nextDay(numDay(wm)) : first.t > cutOf(dayText(first.t)) ? nextDay(dayText(first.t)) : dayText(first.t);
    const out = [];
    while (cutOf(day) <= now) { out.push(day); day = nextDay(day); }
    return out.slice(-MAX_DAYS);
  }

  /** Sundays whose 23:30 has passed and that have no digest pass yet (watermark 'week'). */
  function dueWeeks(saveId, charId) {
    const now = clock.now(saveId);
    const wm = getWatermark(lab, saveId, charId, 'week');
    const first = ledger.list(saveId, { limit: 1, all: true })[0];
    if (!first) return [];
    let sunday = wm ? dayText(cutOf(numDay(wm)) + 7 * DAY) : sundayOf(dayText(first.t));
    const out = [];
    while (weekCut(sunday) <= now) { out.push(sunday); sunday = dayText(cutOf(sunday) + 7 * DAY); }
    return out.slice(-4);
  }

  /**
   * Enqueues the diaries and weekly digests that are due (on each character's jobs lane, diaries first, so a
   * Sunday's digest sees that Sunday's diary). Call after the clock moves.
   */
  function check(saveId) {
    for (const c of lab.scene(saveId).characters) {
      if (!hasRoutine(saveId, c.id)) continue;
      const jobsDue = [...dueDays(saveId, c.id).map(day => ['diary', day]), ...dueWeeks(saveId, c.id).map(day => ['week', day])];
      for (const [kind, day] of jobsDue) {
        const key = `${saveId}|${c.id}|${kind}|${day}`;
        if (writing.has(key)) continue;
        writing.add(key);
        lab.jobs.enqueue(saveId, c.id, kind, async () => {
          try { await (kind === 'diary' ? write(saveId, c.id, day) : writeWeek(saveId, c.id, day)); } finally { writing.delete(key); }
        });
      }
    }
  }

  const liveWeeks = (saveId, charId) => db.prepare("SELECT * FROM caches WHERE save_id = ? AND character_id = ? AND kind = 'week' AND invalid = 0 ORDER BY day, created_at, rowid").all(saveId, charId).map(cacheRow).map(w => ({ ...w, refs: JSON.parse(w.refs || '[]') }));
  /** The Monday–Sunday diaries of the week ending on sunday. */
  const weekDiaries = (saveId, charId, sunday) => {
    const from = dayText(cutOf(sunday) - 6 * DAY);
    return live(saveId, charId).filter(d => d.day >= from && d.day <= sunday);
  };

  /**
   * 2.0 D4: writes (or rewrites) the digest of the week ending on sunday from its diaries. refs point at diaries
   * (cache:…); derived_from = the events those diaries cite, so forgetting an event reaches the digest too.
   */
  async function writeWeek(saveId, charId, sunday) {
    const num = dayNum(sunday);
    const done = () => { if (getWatermark(lab, saveId, charId, 'week') < num) setWatermark(lab, saveId, charId, 'week', num); lab.jobs.recoverUpTo(saveId, charId, 'week', num); };
    const diaries = weekDiaries(saveId, charId, sunday);
    if (!diaries.length) { done(); return null; }
    const card = lab.scene(saveId).characters.find(c => c.id === charId);
    const allowed = new Set(diaries.map(d => `cache:${d.id}`));
    let out;
    try {
      out = await lab.llm.callChecked({
        purpose: 'digest', saveId, system: '你只输出 JSON。', maxTokens: 700,
        user: render('digest', { character_name: card.name, from: diaries[0].day, to: sunday, diaries: diaries.map(d => `[cache:${d.id}] ${d.day} ${d.text}`).join('\n') }),
        mockInput: { diaries }
      }, o => (o.refs || []).filter(r => !allowed.has(r)).map(r => `refs 里的 ${r} 不是这一周的日记`));
    } catch (e) { lab.jobs.fail(saveId, charId, 'week', num, num, e.message); e.recorded = true; throw e; }
    const still = new Set(live(saveId, charId).map(d => d.id));
    const cited = diaries.filter(d => out.refs.includes(`cache:${d.id}`) && still.has(d.id));
    if (!cited.length) { done(); return null; }
    const seqs = [...new Set(cited.flatMap(d => d.derived_from))].sort((a, b) => a - b);
    const old = liveWeeks(saveId, charId).filter(w => w.day === sunday);
    for (const w of old) db.prepare("UPDATE caches SET invalid = 1, invalid_reason = 'rewritten' WHERE id = ?").run(w.id);
    const id = newId('c');
    db.prepare("INSERT INTO caches (id, save_id, character_id, kind, text, priority, derived_from, from_seq, to_seq, generation, created_at, day, refs) VALUES (?, ?, ?, 'week', ?, 2, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, saveId, charId, out.text, j(seqs), Math.min(...cited.map(d => d.from_seq)), Math.max(...cited.map(d => d.to_seq)), lab.saves.getSave(saveId).generation, clock.now(saveId), sunday, j(cited.map(d => `cache:${d.id}`)));
    done();
    return id;
  }

  /** The day's input: perceived, admitted events in (23:00 the day before, 23:00 that day]. */
  function inputFor(saveId, charId, day) {
    const from = cutOf(prevDay(day)), to = cutOf(day);
    const scene = lab.scene(saveId);
    const events = lab.observe.visibleEvents(saveId, charId, 0)
      .filter(e => e.t > from && e.t <= to && TYPES.includes(e.type) && lab.admission.allowed(saveId, charId, `ev:${e.seq}`, 'context'));
    const who = id => (id === 'user' ? '用户' : nameOf(scene, id));
    const text = e => (e.overheard ? e.payload.text : e.type === 'user_said' ? `用户说：${e.payload.text}` : e.type === 'char_said' ? `${who(e.actor)}说：${e.payload.text}` : eventText(scene, e));
    const seqs = new Set(events.map(e => e.seq));
    const observations = lab.observe.live(saveId, charId, 'observation').filter(c => c.derived_from.some(s => seqs.has(s)));
    return { events: events.map(e => ({ seq: e.seq, t: e.t, text: text(e) })), observations };
  }

  /**
   * Writes (or rewrites) one day's diary. Returns the cache id, or null when there was nothing that day.
   * A failure is recorded in job_runs (kind 'diary', range = the day as yyyymmdd) and the watermark stays put.
   */
  async function write(saveId, charId, day) {
    const { events, observations } = inputFor(saveId, charId, day);
    const num = dayNum(day);
    const done = () => {
      if (getWatermark(lab, saveId, charId, 'diary') < num) setWatermark(lab, saveId, charId, 'diary', num);
      lab.jobs.recoverUpTo(saveId, charId, 'diary', num);
    };
    if (!events.length) { done(); return null; }
    const scene = lab.scene(saveId);
    const card = scene.characters.find(c => c.id === charId);
    const allowed = new Set(events.map(e => `ev:${e.seq}`));
    let out;
    try {
      out = await lab.llm.callChecked({
        purpose: 'diary', saveId, system: '你只输出 JSON。', maxTokens: 500,
        user: render('diary', {
          character_name: card.name, character_card: card.cardText, day,
          events: events.map(e => `[ev:${e.seq}] ${formatWorldTime(e.t)} ${e.text}`).join('\n'),
          observations: observations.map(c => `- ${c.text}`).join('\n') || '（无）'
        }),
        mockInput: { events }
      }, o => (o.refs || []).filter(r => !allowed.has(r)).map(r => `refs 里的 ${r} 不在今天的事里`));
    } catch (e) { lab.jobs.fail(saveId, charId, 'diary', num, num, e.message); e.recorded = true; throw e; }
    // Forgotten or deleted while the model wrote: write nothing that cites it (the next rebuild covers the day).
    const gone = lab.admission.forgottenSet(saveId, charId);
    const seqs = [...new Set(out.refs.map(r => Number(r.slice(3))))].sort((a, b) => a - b);
    if (seqs.some(s => gone.has(s) || !ledger.get(saveId, s)?.payload)) { done(); return null; }
    const save = lab.saves.getSave(saveId);
    const old = ofDay(saveId, charId, day);
    if (old) db.prepare("UPDATE caches SET invalid = 1, invalid_reason = 'rewritten' WHERE id = ?").run(old.id);
    const id = newId('c');
    db.prepare("INSERT INTO caches (id, save_id, character_id, kind, text, priority, derived_from, from_seq, to_seq, generation, created_at, day, intention) VALUES (?, ?, ?, 'diary', ?, 2, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, saveId, charId, out.text, j(seqs), events[0].seq, events.at(-1).seq, save.generation, clock.now(saveId), day, String(out.intention || '').slice(0, 60));
    done();
    return id;
  }

  /** Yesterday's intention ("把你说的那条溪画上"), or null. */
  function intention(saveId, charId) {
    const d = ofDay(saveId, charId, prevDay(today(clock.now(saveId))));
    return d?.intention || null;
  }

  return { check, write, writeWeek, intention, live, liveWeeks, weekDiaries, dueDays, dueWeeks, inputFor, sundayOf };
}
