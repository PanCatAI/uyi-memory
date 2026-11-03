// 2.0 D1: the character lives by the 作息 in her card instead of a model guessing what she did off-screen.
// Each routine slot (e.g. "05:30–08:00｜篝火边｜生火、烧水｜walk_to campfire-1 → tend_fire campfire-1") gets at most one
// run of its steps per slot instance: the first candidate the arbiter allows, written to the ledger with
// payload.routine = true and payload.slot = "<day of the slot start>@<from>". No model calls: same save, same steps →
// same events.
import { DAY, HOUR } from '../clock.mjs';
import { checkAction, actionEvents, alreadyDone, COSMETIC_ACTIONS } from '../arbiter.mjs';
import { applyEvent } from '../world.mjs';

export const TICK_MS = 5 * 60_000;   // one tick in a session = 5 world minutes
export const QUIET_MS = 2 * 60_000;  // the user said something this recently → do not start a routine action
export const MAX_CATCHUP = 6;        // slots made up for when the user comes back
const TZ = 9 * HOUR;                 // Asia/Tokyo, as in environment.mjs
const SLOT_DELAY = 10 * 60_000;      // a made-up slot's action happens 10 minutes into the slot

const minuteOfDay = t => Math.floor((((t + TZ) % DAY) + DAY) % DAY / 60_000);
const dayStart = t => t - (((t + TZ) % DAY) + DAY) % DAY; // 00:00 Tokyo of t's day
const dayText = t => new Date(t + TZ).toISOString().slice(0, 10);

/** The slot instance that contains t: { slot, key, start, end } or null when the card has no routine. */
export function slotAt(routine, t) {
  if (!routine?.length) return null;
  const m = minuteOfDay(t);
  for (const slot of routine) {
    const len = (slot.toMin - slot.fromMin + 1440) % 1440 || 1440;
    const into = (m - slot.fromMin + 1440) % 1440;
    if (into >= len) continue;
    const start = t - (t - dayStart(t)) % 60_000 - into * 60_000; // whole minutes since the slot began
    return { slot, key: `${dayText(start)}@${slot.from}`, start, end: start + len * 60_000 };
  }
  return null;
}

/** Slot instances overlapping (fromT, toT], oldest first. */
export function slotsBetween(routine, fromT, toT) {
  const out = [];
  for (let s = slotAt(routine, fromT); s && s.start <= toT; s = slotAt(routine, s.end)) {
    if (s.end > fromT) out.push(s);
    if (out.length > 400) break; // a year of skipped time; the caller keeps the last few anyway
  }
  return out;
}

const STOP = new Set('的了在上下里我你他她它把那这一个和去来着走看'.split(''));
/** A slot fits an intention when its 做什么 shares a meaningful character with it (画图 ↔ 把那条溪画上). */
export const matchesWish = (slot, wish) => [...String(slot.doing)].some(ch => /\p{Script=Han}/u.test(ch) && !STOP.has(ch) && String(wish).includes(ch));

export function createLife(lab) {
  const { ledger, clock } = lab;
  const routineOf = (saveId, charId) => lab.scene(saveId).characters.find(c => c.id === charId)?.card?.routine || [];
  const done = (saveId, charId, key) => ledger.list(saveId, { types: ['char_action'], actor: charId, desc: true, limit: 60 }).some(e => e.payload?.routine && e.payload.slot === key);

  /** What the slot asks for, as candidates in order: as written, then without args.with (only if it is not here). */
  function candidates(state, scene, charId, slot) {
    // 3.0 F3: a step the scene has no action for (gather_wood without features.world) is left out.
    let steps = slot.steps.filter(s => scene.actions[s.name]).map(s => ({ name: s.name, target: s.target, args: { ...s.args } }));
    if (!steps.length) return [];
    const c = state.characters[charId];
    const last = steps.at(-1);
    // Already inside where the slot ends ("walk_to tent-1 → enter tent-1" while in the tent): nothing to do.
    if (last.name === 'enter' && state.objects[last.target]?.leads_to === c.room) return [];
    // Inside (the tent) and the slot is somewhere else: come out first.
    if (scene.rooms.find(r => r.id === c.room)?.exit_to && scene.actions.leave) steps = [{ name: 'leave', target: null, args: {} }, ...steps];
    const out = [steps];
    if (steps.some(s => s.args.with)) out.push(steps.map(s => ({ ...s, args: Object.fromEntries(Object.entries(s.args).filter(([k]) => k !== 'with')) })));
    return out;
  }

  /** Runs every step on a copy of the world; null when a non-cosmetic step fails, else the steps that do something. */
  function feasible(state, scene, charId, steps) {
    const sim = structuredClone(state);
    const run = [];
    for (const a of steps) {
      if (alreadyDone(sim, charId, a)) continue;
      const check = checkAction(sim, scene, charId, a, { userPresent: false });
      // A step the world's rules refuse right now (no wood to tend the fire with) is skipped; the rest of the slot still happens.
      if (!check.ok) { if (COSMETIC_ACTIONS.includes(a.name) || check.rule) continue; return null; }
      for (const ev of actionEvents(sim, scene, charId, a, check)) applyEvent(sim, scene, ev);
      run.push(a);
    }
    return run;
  }

  /** Does this slot's routine now (or at t for a made-up slot). Returns the new events ([] when nothing to do). */
  function runSlot(saveId, charId, s, { t, offscreen = false } = {}) {
    if (!s || done(saveId, charId, s.key)) return [];
    const scene = lab.scene(saveId);
    const state = ledger.world(saveId);
    let steps = null;
    for (const cand of candidates(state, scene, charId, s.slot)) if ((steps = feasible(state, scene, charId, cand))) break;
    if (!steps?.length) return [];
    const out = [];
    for (const a of steps) {
      const st = ledger.world(saveId);
      const check = checkAction(st, scene, charId, a, { userPresent: offscreen ? false : undefined });
      if (!check.ok) break; // cannot happen after feasible(), but never write an action the world refuses
      const evs = actionEvents(st, scene, charId, a, check, offscreen ? { offscreen: true, t } : t != null ? { t } : {})
        .map(e => (e.type === 'char_action' ? { ...e, payload: { ...e.payload, routine: true, slot: s.key } } : e));
      out.push(...ledger.appendMany(saveId, evs));
    }
    return out;
  }

  const hasRoutine = (saveId, charId) => routineOf(saveId, charId).length > 0;

  /** The user is around and just spoke: let them talk. */
  function chatting(saveId) {
    const st = ledger.world(saveId);
    if (!st.sessionOpen) return false;
    const last = ledger.list(saveId, { types: ['user_said'], desc: true, limit: 1 })[0];
    return Boolean(last && clock.now(saveId) - last.t < QUIET_MS);
  }

  /**
   * One tick in an open session: world time +5 minutes, weather/fire, then each character's current slot — unless the
   * user spoke in the 2 world minutes before this tick (then no new routine action: let them talk).
   * Returns { events, skipped } (skipped = 'no_session' | 'chatting' | null).
   */
  function tick(saveId) {
    if (!lab.saves.getSave(saveId).session_id) return { events: [], skipped: 'no_session' };
    const talking = chatting(saveId);
    clock.advance(saveId, TICK_MS);
    const events = [...lab.environment.tick(saveId)];
    lab.diary.check(saveId);
    if (talking) return { events, skipped: 'chatting' };
    for (const c of lab.scene(saveId).characters) {
      if (!hasRoutine(saveId, c.id)) continue;
      events.push(...runSlot(saveId, c.id, slotAt(routineOf(saveId, c.id), clock.now(saveId))));
    }
    return { events, skipped: null };
  }

  /**
   * Coming back: the slots crossed since the user left (at most one thing each, the last MAX_CATCHUP of them), each
   * at 10 minutes into its slot (kept inside (fromT, toT] and in order). Off-screen events.
   */
  function catchup(saveId, charId, opts) {
    const out = [];
    for (const { s, at } of catchupPlan(saveId, charId, opts)) out.push(...runSlot(saveId, charId, s, { t: at, offscreen: true }));
    return out;
  }

  /** The slots catchup() makes up and the time of each, without doing them (3.0 F5 interleaves them with the world). */
  function catchupPlan(saveId, charId, { sinceT, fromT, toT }) {
    const all = slotsBetween(routineOf(saveId, charId), sinceT, toT);
    let slots = all.slice(-MAX_CATCHUP);
    // 2.0 D3: what she wanted to do today (from last night's diary) is not dropped when there are too many slots.
    const wish = lab.diary?.intention(saveId, charId);
    const wanted = wish && all.slice(0, -MAX_CATCHUP).filter(s => matchesWish(s.slot, wish)).at(-1);
    if (wanted && !slots.some(s => matchesWish(s.slot, wish))) slots = [wanted, ...slots.slice(1)];
    const out = [];
    let at = fromT;
    for (const s of slots) {
      at = Math.min(toT, Math.max(at, s.start + SLOT_DELAY));
      out.push({ s, at });
    }
    return out;
  }

  /** What the character is supposed to be doing now: { doing, place, asleep } (asleep = in the tent at night). */
  function now(saveId, charId) {
    const s = slotAt(routineOf(saveId, charId), clock.now(saveId));
    if (!s) return null;
    const c = ledger.world(saveId).characters[charId];
    const inside = Boolean(lab.scene(saveId).rooms.find(r => r.id === c?.room)?.exit_to);
    return { doing: s.slot.doing, place: s.slot.place, from: s.slot.from, to: s.slot.to, asleep: inside && /睡/.test(s.slot.doing) };
  }

  return { tick, catchup, catchupPlan, runSlot, now, hasRoutine, slotAt: (saveId, charId, t) => slotAt(routineOf(saveId, charId), t ?? clock.now(saveId)) };
}
