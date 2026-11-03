// Sessions and world time (PLAN §4.13).
import { newId } from './ids.mjs';
import { parseDuration } from './clock.mjs';
import { sessionInfo } from './memory/common.mjs';
import { CATCHUP_MIN_GAP } from './memory/catchup.mjs';

export function createSession(lab) {
  const { ledger, clock, saves } = lab;

  async function start(saveId) {
    const save = saves.getSave(saveId);
    if (save.session_id) return [];
    const now = clock.now(saveId);
    const lastEnd = sessionInfo(lab, saveId).previousEnd;
    const gap = lastEnd ? now - lastEnd.t : 0;
    const out = [];
    if (lab.scene(saveId).rules) out.push(...awayWithWorld(saveId, lastEnd, now));
    else for (const c of lab.scene(saveId).characters) {
      // 2.0 D1: a character with a 作息 lived through the slots the user missed (no model call, any gap).
      if (!lastEnd || !lab.life.hasRoutine(saveId, c.id)) continue;
      const lastT = ledger.list(saveId, { desc: true, limit: 1 })[0]?.t ?? now;
      out.push(...lab.life.catchup(saveId, c.id, { sinceT: lastEnd.t, fromT: lastT, toT: now }));
    }
    if (gap >= CATCHUP_MIN_GAP) {
      for (const c of lab.scene(saveId).characters) {
        if (lab.life.hasRoutine(saveId, c.id)) continue; // old cards without 作息 keep the 1.0 catch-up
        const lastT = ledger.list(saveId, { desc: true, limit: 1 })[0]?.t ?? now;
        try {
          // Called from inside a turn's 'act' queue too, so run directly instead of queueing (no deadlock).
          out.push(...await lab.catchup.run(saveId, c.id, { gap, fromT: lastT, toT: now }));
        } catch (e) { lab.jobs.reportError(saveId, `离屏补完失败（${c.name}）：${e.message}`); }
      }
    }
    out.push(...lab.environment.tick(saveId)); // weather and the fire, after any offscreen catch-up
    lab.diary.check(saveId); // 2.0 D3: diaries for the nights that passed (background)
    const id = newId('sess');
    saves.setSession(saveId, id);
    out.push(ledger.append(saveId, { type: 'session_start', actor: 'host', payload: { gap_ms: gap } }));
    for (const c of lab.scene(saveId).characters) lab.relationship.sync(saveId, c.id); // 2.0 D5 (days known move while away)
    return out;
  }

  /**
   * 3.0 F5: while the user was away the world ran hour by hour (weather, 量, incidents, her fixes) and her made-up
   * routine slots happen in between, each at its own time, so the ledger stays in time order.
   */
  function awayWithWorld(saveId, lastEnd, now) {
    const lastT = () => ledger.list(saveId, { desc: true, limit: 1 })[0]?.t ?? now;
    const plan = !lastEnd ? [] : lab.scene(saveId).characters.filter(c => lab.life.hasRoutine(saveId, c.id))
      .flatMap(c => lab.life.catchupPlan(saveId, c.id, { sinceT: lastEnd.t, fromT: lastT(), toT: now }).map(p => ({ ...p, charId: c.id })))
      .sort((a, b) => a.at - b.at);
    const runUntil = H => {
      const evs = [];
      while (plan.length && plan[0].at < H) {
        const p = plan.shift();
        evs.push(...lab.life.runSlot(saveId, p.charId, p.s, { t: Math.max(p.at, lastT()), offscreen: true }));
      }
      return evs;
    };
    return [...lab.worldsim.advance(saveId, { toT: now, between: runUntil }), ...runUntil(Infinity)];
  }

  function end(saveId) {
    const save = saves.getSave(saveId);
    if (!save.session_id) return [];
    const dropped = lab.practice.sessionEnd(saveId); // 3.0 G3: a practice not finished is abandoned
    const ev = ledger.append(saveId, { type: 'session_end', actor: 'host', payload: {} });
    saves.setSession(saveId, null);
    for (const c of lab.scene(saveId).characters) lab.jobs.enqueue(saveId, c.id, 'observe_force');
    return [...dropped, ev];
  }

  function advance(saveId, duration) {
    const from = clock.now(saveId);
    const ms = parseDuration(duration, from);
    if (!ms) throw new Error(`看不懂的时长：${duration}`);
    const out = end(saveId);
    // 3.0 G5: two skips in a row (a scenario's "1d" then "19:30"): the world and her day run through the first one
    // before the next skip is written, so their events keep their own hours.
    if (lab.scene(saveId).rules) out.push(...awayWithWorld(saveId, sessionInfo(lab, saveId).previousEnd, from));
    out.push(ledger.append(saveId, { type: 'time_skip', actor: 'host', payload: { from, to: from + ms } }));
    clock.set(saveId, from + ms);
    return out;
  }

  /**
   * 2.0 D1/D2: one tick in the first character's act lane: world +5 min and each character's routine, then (when the
   * user has been quiet a real minute) an idle moment each. now = real ms, for tests. → { events, skipped, idle }
   */
  function tick(saveId, { now } = {}) {
    const first = lab.scene(saveId).characters[0];
    return lab.queues.queue(saveId, first.id, 'act', async () => {
      const r = lab.life.tick(saveId);
      if (r.skipped === 'no_session') return { ...r, idle: [] };
      const idle = [];
      for (const c of lab.scene(saveId).characters) {
        try {
          const x = await lab.idle.run(saveId, c.id, { now });
          if (!x.skipped) { idle.push({ character: c.id, ...x }); r.events.push(...x.events); }
        } catch (e) { lab.jobs.reportError(saveId, `空闲想法失败（${c.name}）：${e.message}`); }
      }
      return { ...r, idle };
    });
  }

  return { start, end, advance, tick };
}
