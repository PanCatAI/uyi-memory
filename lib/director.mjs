// 3.0 F4 (contracts/world.md): the director decides when the camp's incidents happen, RimWorld-storyteller style:
// a per-day budget of severity points, a minimum gap, a rest after a big one, and more chance after a quiet spell.
// Incidents that follow straight from the weather (check on_weather) skip budget and gap, only their cooldown holds.
// Every check is logged to director_log. It also resolves incidents (an action matching `resolve`, a condition in
// `resolve_when`, `auto_resolve_h`), expires them at their deadline, and has her do an incident's auto_fix.
// Only with features.world and features.director. Chance comes from rand01(save, incident, hour): no model, no clock.
import { HOUR, DAY } from './clock.mjs';
import { rand01 } from './rand.mjs';
import { dayOf, minuteOf, hm } from './climate.mjs';
import { match } from './rules.mjs';
import { checkAction, actionEvents, alreadyDone } from './arbiter.mjs';
import { applyEvent } from './world.mjs';
import { stageIndex } from './card.mjs';

export const PACE = {
  平静: { budget: 2, gap_h: 6, rest_h: 36, quiet_boost: 1.5 },
  起伏: { budget: 4, gap_h: 3, rest_h: 24, quiet_boost: 2 },
  热闹: { budget: 6, gap_h: 1, rest_h: 12, quiet_boost: 2 }
};
export const TOGETHER_MS = 30 * 60_000;  // the user's 搭把手 and her fix this close together → solved together
const QUIET_MS = 2 * DAY;

/** Does an incident stay open (something to solve, a deadline, or an end condition)? */
export const lasting = inc => Boolean(inc.resolve?.length || inc.deadline_h || inc.resolve_when || inc.auto_resolve_h);

export function createDirector(lab) {
  const { ledger, db } = lab;
  const on = saveId => Boolean(lab.scene(saveId).rules) && lab.features(saveId).director;
  const incidentsOf = saveId => lab.scene(saveId).incidents || [];
  const byId = (saveId, id) => incidentsOf(saveId).find(i => i.id === id);
  const log = (saveId, t, incident, decision, reason) => db.prepare('INSERT INTO director_log (save_id, t, incident, decision, reason) VALUES (?, ?, ?, ?, ?)').run(saveId, t, incident, decision, reason);
  const starts = saveId => ledger.list(saveId, { types: ['incident'], desc: true, limit: 300 }).filter(e => e.payload?.phase === 'start');
  const firstChar = saveId => lab.scene(saveId).characters[0].id;
  const sim = () => lab.worldsim;

  /** The hunter's news: the highest stage line at or below hers that was not said yet. */
  function news(saveId, inc, stage) {
    const said = new Set(starts(saveId).filter(e => e.payload.incident === inc.id).map(e => e.payload.news));
    const lines = Object.entries(inc.news).filter(([s]) => stageIndex(s) <= stageIndex(stage)).sort((x, y) => stageIndex(y[0]) - stageIndex(x[0]));
    return lines.map(([, text]) => text).find(text => !said.has(text)) ?? null;
  }

  /** Starts an incident now: the start event, then its effects. by: 'director' | 'debug'. */
  function start(saveId, inc, t, { why = '' } = {}) {
    const scene = lab.scene(saveId);
    const ctx = lab.rules.context(saveId, firstChar(saveId), { t });
    const extra = {};
    if (inc.news) {
      const n = news(saveId, inc, ctx.stage);
      if (!n) { log(saveId, t, inc.id, 'when', '猎人没有新消息了'); return []; }
      extra.news = n;
    }
    const ev = sim().host(saveId, t, {
      type: 'incident', target: inc.target ?? null, room: inc.target ? undefined : scene.user_room, perceivers: scene.characters.map(c => c.id),
      payload: { incident: inc.id, phase: 'start', sev: inc.sev, lasting: lasting(inc), ...(inc.deadline_h ? { deadline: t + inc.deadline_h * HOUR } : {}), ...extra }
    });
    log(saveId, t, inc.id, 'start', why || '开始');
    return [ev, ...sim().applyEffects(saveId, inc.effects, inc.name, t)];
  }

  function end(saveId, inc, t, phase, { by, how } = {}) {
    const st = ledger.world(saveId);
    const open = st.incidents?.[inc.id];
    if (!open) return [];
    const ev = sim().host(saveId, t, { type: 'incident', target: open.target, room: open.target ? undefined : lab.scene(saveId).user_room, perceivers: lab.scene(saveId).characters.map(c => c.id),
      payload: { incident: inc.id, phase, sev: inc.sev, ...(by ? { by } : {}), ...(how ? { how } : {}) } });
    const after = phase === 'expired' ? inc.on_expire : inc.on_resolve;
    return [ev, ...sim().applyEffects(saveId, after, phase === 'expired' ? `${inc.name}没人管` : `${inc.name}解决了`, t)];
  }

  /** Why the director will not start a random incident now (null = it may), from the pace table. */
  function paced(saveId, inc, t, past) {
    const pace = PACE[lab.features(saveId).pace] || PACE.起伏;
    const random = past.filter(e => byId(saveId, e.payload.incident)?.check !== 'on_weather');
    const today = dayOf(t);
    const spent = random.filter(e => dayOf(e.t) === today).reduce((a, e) => a + (e.payload.sev || 0), 0);
    if (spent + inc.sev > pace.budget) return ['budget', `今天已用 ${spent} 点，预算 ${pace.budget}`];
    const last = random[0];
    if (last && t - last.t < pace.gap_h * HOUR) return ['gap', `离上一次意外不到 ${pace.gap_h} 小时`];
    const big = random.find(e => e.payload.sev >= 3);
    if (inc.sev >= 2 && big && t - big.t < pace.rest_h * HOUR) return ['rest', `大事之后休息 ${pace.rest_h} 小时`];
    return null;
  }

  /**
   * One check at world time t: hourly incidents, daily@HH:MM ones whose hour this is; with onWeather, the on_weather
   * ones instead (the weather just turned). Returns the new events.
   */
  function check(saveId, t, { onWeather = false } = {}) {
    if (!on(saveId)) return [];
    const out = [];
    if (!onWeather) out.push(...scheduled(saveId, t));
    const f = lab.features(saveId);
    const pace = PACE[f.pace] || PACE.起伏;
    const hourNow = Math.floor(minuteOf(t) / 60);
    for (const inc of incidentsOf(saveId)) {
      const kind = String(inc.check);
      if (onWeather ? kind !== 'on_weather' : kind === 'on_weather') continue;
      if (kind.startsWith('daily@') && Math.floor(hm(kind.slice(6)) / 60) !== hourNow) continue;
      if (f.director_random === false && inc.p < 1) continue; // scenarios: only what follows from the rules
      const st = ledger.world(saveId);
      if (st.incidents?.[inc.id]) continue; // still going: not a new check
      const past = starts(saveId);
      const mine = past.find(e => e.payload.incident === inc.id);
      if (mine && inc.cooldown_days && t - mine.t < inc.cooldown_days * DAY) continue; // cooling down: not worth a log line every hour
      const ctx = lab.rules.context(saveId, firstChar(saveId), { t });
      if (!match(inc.when, ctx)) continue;
      let p = inc.p;
      if (!onWeather) {
        const no = paced(saveId, inc, t, past);
        if (no) { log(saveId, t, inc.id, no[0], no[1]); continue; }
        if (!past.length || t - past[0].t >= QUIET_MS) p *= pace.quiet_boost;
        // 3.0 G3: keeping watch together, the night's small things are more likely to be shared.
        const prac = ledger.world(saveId).practice && (lab.scene(saveId).practices || []).find(x => x.id === ledger.world(saveId).practice.id);
        if (prac?.night_boost?.incidents.includes(inc.id)) p *= prac.night_boost.p_times;
      }
      const r = rand01(saveId, inc.id, Math.floor(t / HOUR));
      if (r >= p) { log(saveId, t, inc.id, 'roll', `掷 ${r.toFixed(2)} ≥ ${Math.min(1, p).toFixed(2)}`); continue; }
      out.push(...start(saveId, inc, t, { why: `掷 ${r.toFixed(2)} < ${Math.min(1, p).toFixed(2)}` }));
    }
    if (!onWeather) out.push(...closeByTime(saveId, t));
    return out;
  }

  /** Deadlines, auto_resolve_h, resolve_when, and a 搭把手 nobody followed up within TOGETHER_MS. */
  function closeByTime(saveId, t) {
    const out = [];
    for (const open of Object.values(ledger.world(saveId).incidents || {})) {
      const inc = byId(saveId, open.id);
      if (!inc) continue;
      const ctx = lab.rules.context(saveId, firstChar(saveId), { t });
      if (inc.resolve_when && match(inc.resolve_when, ctx)) out.push(...end(saveId, inc, t, 'resolved', { by: 'host', how: '自己好了' }));
      else if (inc.auto_resolve_h && t - open.t >= inc.auto_resolve_h * HOUR) out.push(...end(saveId, inc, t, 'resolved', { by: 'host', how: '过去了' }));
      else if (helpPending(saveId, inc.id, open) && t - helpPending(saveId, inc.id, open).t >= TOGETHER_MS && inc.resolve.some(r => r.by === 'user' && r.action === 'help')) out.push(...end(saveId, inc, t, 'resolved', { by: 'user', how: '用户搭了把手' }));
      else if (open.deadline && t >= open.deadline) out.push(...end(saveId, inc, t, 'expired'));
    }
    return out;
  }
  const helpPending = (saveId, id, open) => ledger.list(saveId, { types: ['user_action'], desc: true, limit: 30 }).find(e => e.action === 'help' && e.payload?.args?.incident === id && e.seq > open.seq);

  /** An action just written: does it solve an open incident? (her char_action ok, or the user's user_action) */
  function onAction(saveId, ev) {
    if (!on(saveId)) return [];
    const out = [];
    for (const open of Object.values(ledger.world(saveId).incidents || {})) {
      const inc = byId(saveId, open.id);
      const isUser = ev.type === 'user_action';
      // 搭把手: she comes and does the fix with the user now if she can (then it is solved together); otherwise it
      // waits for her doing it within TOGETHER_MS, or counts as the user's after that (closeByTime).
      if (isUser && ev.action === 'help') { if (ev.payload?.args?.incident === open.id) out.push(...fixes(saveId, ev.t, { only: open.id })); continue; }
      if (!isUser && ev.outcome !== 'ok') continue;
      const hit = (inc?.resolve || []).find(r => r.action === ev.action && (!r.target || r.target === ev.target) && (r.by === 'either' || r.by === (isUser ? 'user' : 'char')));
      if (!hit) continue;
      const help = !isUser && helpPending(saveId, inc.id, open);
      const by = help && ev.t - help.t <= TOGETHER_MS ? 'together' : isUser ? 'user' : 'char';
      out.push(...end(saveId, inc, ev.t, 'resolved', { by, how: ev.action }));
    }
    return out;
  }

  /**
   * auto_fix: she does the incident's fix herself, after_h hours in, when the world lets her (the arbiter decides).
   * Asleep (her 作息 says 睡 and she is in the tent) only a sev ≥ 2 incident gets her up, and that costs sleep.
   */
  function fixes(saveId, t, { only = null } = {}) {
    if (!on(saveId)) return [];
    const out = [];
    const scene = lab.scene(saveId);
    for (const open of Object.values(ledger.world(saveId).incidents || {})) {
      if (only && open.id !== only) continue;
      const inc = byId(saveId, open.id);
      const fix = inc?.auto_fix;
      if (!fix || (!only && t - open.t < fix.after_h * HOUR)) continue;
      for (const c of scene.characters) {
        if (!ledger.world(saveId).incidents?.[open.id]) break;
        const st = ledger.world(saveId);
        const slot = lab.life.slotAt(saveId, c.id, t);
        const asleep = Boolean(slot && /睡/.test(slot.slot.doing) && scene.rooms.find(r => r.id === st.characters[c.id].room)?.exit_to);
        if (asleep && inc.sev < 2) continue;
        const steps = plan(st, scene, c.id, fix);
        if (!steps) { log(saveId, t, inc.id, 'auto_fix', `${c.name}做不了`); continue; }
        if (asleep) out.push(...sim().addVar(saveId, 'lan_tired', 1, `半夜爬起来处理${inc.name}`, t));
        const off = !st.sessionOpen;
        for (const a of steps) {
          const now = ledger.world(saveId);
          const ok = checkAction(now, scene, c.id, a, { userPresent: off ? false : undefined });
          if (!ok.ok) break;
          const evs = actionEvents(now, scene, c.id, a, ok, { t: Math.max(t, ledger.list(saveId, { desc: true, limit: 1 })[0]?.t ?? t), ...(off ? { offscreen: true } : {}) })
            .map(e => (e.type === 'char_action' ? { ...e, payload: { ...e.payload, routine: true, incident: inc.id } } : e));
          out.push(...ledger.appendMany(saveId, evs));
        }
        log(saveId, t, inc.id, 'auto_fix', `${c.name}自己去${fix.action}`);
      }
    }
    return out;
  }

  /** Steps to do fix.action on fix.target from where she is: out of the tent, walk there, do it. null if not possible. */
  function plan(state, scene, charId, fix) {
    const s = structuredClone(state);
    const c = s.characters[charId];
    const steps = [];
    const room = s.objects[fix.target]?.room ?? fix.target;
    if (scene.rooms.find(r => r.id === c.room)?.exit_to && room !== c.room) steps.push({ name: 'leave', target: null, args: {} });
    steps.push({ name: 'walk_to', target: fix.target, args: {} }, { name: fix.action, target: fix.target ?? null, args: {} });
    const run = [];
    for (const a of steps) {
      if (alreadyDone(s, charId, a)) continue;
      const ok = checkAction(s, scene, charId, a, { userPresent: false });
      if (!ok.ok) return null;
      for (const ev of actionEvents(s, scene, charId, a, ok)) applyEvent(s, scene, ev);
      run.push(a);
    }
    return run;
  }

  /** F6 调试: start one incident now, whatever the conditions and the budget. */
  function force(saveId, id, t = lab.clock.now(saveId)) {
    const inc = byId(saveId, id);
    if (!inc) throw new Error(`没有这个意外：${id}`);
    if (ledger.world(saveId).incidents?.[id]) throw new Error(`${inc.name}正在进行`);
    log(saveId, t, id, 'debug', '调试：直接开始');
    return start(saveId, inc, t, { why: '调试' });
  }

  /** 3.0 G5: a scenario's force_incident for a later hour (vars.incident_schedule [{ id, t }]), started when it comes. */
  function schedule(saveId, id, at) {
    if (!byId(saveId, id)) throw new Error(`没有这个意外：${id}`);
    const list = [...(ledger.world(saveId).vars?.incident_schedule || []), { id, t: at }];
    return sim().setVar(saveId, 'incident_schedule', list, `剧本：${id}`, lab.clock.now(saveId));
  }
  function scheduled(saveId, t) {
    const list = ledger.world(saveId).vars?.incident_schedule || [];
    const due = list.filter(x => x.t <= t);
    if (!due.length) return [];
    const out = sim().setVar(saveId, 'incident_schedule', list.filter(x => x.t > t), '剧本：到点了', t);
    for (const x of due) if (!ledger.world(saveId).incidents?.[x.id]) out.push(...force(saveId, x.id, t));
    return out;
  }

  const recentLog = (saveId, limit = 30) => db.prepare('SELECT t, incident, decision, reason FROM director_log WHERE save_id = ? ORDER BY t DESC, rowid DESC LIMIT ?').all(saveId, limit);

  return { check, onAction, fixes, force, schedule, start, recentLog, incidents: incidentsOf };
}
