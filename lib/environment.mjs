// 2.0 C5: what the camp is like right now — sky from the world clock, a deterministic weather per world day, and the
// campfire burning out 3 world hours after it was last tended. Only for scenes marked `outdoor`.
// The host writes `weather` (once per world day, when its 05:00 has passed) and `fire_out` events; nothing here
// calls a model.
import { HOUR, DAY } from './clock.mjs';
import { visibility } from './perception.mjs';
import { fnv } from './rand.mjs';
import { morning, afternoon, temps, tempAt, dayOf, dayStartT, addDays, daysBetween, minuteOf } from './climate.mjs';

export const FIRE_HOURS = 3;
export const WEATHER = ['晴', '阴', '小雨', '起雾'];
const TZ = 9 * HOUR; // Asia/Tokyo, no daylight saving

export const hourOf = t => Math.floor((((t + TZ) % DAY) + DAY) % DAY / HOUR);
/** 清晨 05–08 / 白天 08–17 / 黄昏 17–19 / 夜里 19–05. */
export function skyOf(t) {
  const h = hourOf(t);
  return h >= 5 && h < 8 ? '清晨' : h >= 8 && h < 17 ? '白天' : h >= 17 && h < 19 ? '黄昏' : '夜里';
}
/** The world day a time belongs to for weather: days turn over at 05:00 (so 02:00 is still yesterday). '2026-10-20'. */
export function weatherDay(t) {
  return new Date(t + TZ - 5 * HOUR).toISOString().slice(0, 10);
}
/** Same save, same day → same weather, always (FNV-1a of "save|day"). */
export const weatherFor = (saveId, day) => WEATHER[fnv(`${saveId}|${day}`) % WEATHER.length];

export function createEnvironment(lab) {
  const { ledger, clock } = lab;
  const fires = state => Object.values(state.objects).filter(o => (o.tags || []).includes('fire'));
  /** When a lit fire started burning: its last tend, else the first event of the save (an import starts it lit). */
  const litSince = (saveId, o) => o.state.tended_at ?? ledger.list(saveId, { limit: 1, all: true })[0]?.t ?? clock.now(saveId);

  /**
   * Writes what time passing has made true: today's weather (once a day) and fire_out for a fire left alone for 3
   * hours. Call after the clock moves and before new events at that time. Returns the new events.
   */
  function tick(saveId) {
    if (!lab.scene(saveId).outdoor) return [];
    if (lab.scene(saveId).rules) return lab.worldsim.advance(saveId); // 3.0 F: features.world
    const now = clock.now(saveId);
    const out = [];
    const day = weatherDay(now);
    const had = ledger.list(saveId, { types: ['weather'], desc: true, limit: 1, all: true })[0];
    // A day counts once its 05:00 has passed in this save (the first day starts at 09:00, so it has one too).
    if (had?.payload?.day !== day) out.push(ledger.append(saveId, { type: 'weather', actor: 'host', payload: { kind: weatherFor(saveId, day), day } }));
    const state = ledger.world(saveId);
    for (const o of fires(state)) {
      if (!o.state.lit) continue;
      const since = litSince(saveId, o);
      if (now - since >= FIRE_HOURS * HOUR) out.push(ledger.append(saveId, { type: 'fire_out', actor: 'host', target: o.id, payload: { since } }));
    }
    return out;
  }

  /** { sky, weather, fires: [{ id, name, lit }] } for the now section and the 3D column; null indoors. */
  function now(saveId) {
    if (!lab.scene(saveId).outdoor) return null;
    const t = clock.now(saveId);
    if (lab.scene(saveId).rules) {
      const c = climate(saveId, t);
      const st = ledger.world(saveId);
      return { sky: c.sky, weather: c.kind, am: c.am, pm: c.pm, temp: c.temp, lo: c.lo, hi: c.hi, wind: c.wind, day: c.day, date: c.date,
        sign: st.sign?.day === c.date ? st.sign : null, vars: st.vars, incidents: Object.values(st.incidents || {}),
        fires: fires(st).map(o => ({ id: o.id, name: o.name, lit: Boolean(o.state.lit) })) };
    }
    const day = weatherDay(t);
    const ev = ledger.list(saveId, { types: ['weather'], desc: true, limit: 1, all: true })[0];
    return {
      sky: skyOf(t), weather: ev?.payload?.day === day ? ev.payload.kind : weatherFor(saveId, day),
      fires: fires(ledger.world(saveId)).map(o => ({ id: o.id, name: o.name, lit: Boolean(o.state.lit) }))
    };
  }

  /** hints rule fire_out_night: at night, the fire this character saw go out (newest first). */
  function fireOutRefs(saveId, charId) {
    const env = now(saveId);
    if (!env || env.sky !== '夜里') return [];
    const state = ledger.world(saveId);
    return ledger.list(saveId, { types: ['fire_out'], desc: true, all: true })
      .filter(e => state.objects[e.target] && !state.objects[e.target].state.lit && visibility(e, charId) === 'full')
      .map(e => `ev:${e.seq}`);
  }

  // 3.0 F2: the save's weather days, from its first event (day 1, morning fixed by the rules).
  const chains = new Map(); // saveId → { first, am: [] }
  function chain(saveId) {
    if (!chains.has(saveId)) {
      const t0 = ledger.list(saveId, { limit: 1 })[0]?.t ?? clock.now(saveId);
      chains.set(saveId, { first: dayOf(t0), am: [] });
    }
    return chains.get(saveId);
  }
  /** Day index (1 = the save's first weather day) of t. */
  const dayIndex = (saveId, t) => daysBetween(chain(saveId).first, dayOf(t)) + 1;
  /** The planned weather of a day, as the rules make it: { am, pm } (what the host will write; debug writes can differ). */
  function planned(saveId, date) {
    const w = lab.scene(saveId).rules.weather;
    const ch = chain(saveId);
    const i = daysBetween(ch.first, date) + 1;
    // 3.0 G5: a scenario's force_weather for a coming morning (vars.weather_overrides { date: kind }) holds all day.
    const forced = ledger.world(saveId).vars?.weather_overrides?.[date];
    if (forced) return { am: forced, pm: forced, i };
    const am = morning(saveId, w, ch.first, i, ch.am);
    return { am, pm: afternoon(saveId, w, date, am), i };
  }
  /**
   * The weather at t, as the world has it: the written weather event of that day when there is one (and the turns
   * written since), else the plan. Temperatures from the rules table.
   */
  function climate(saveId, t = clock.now(saveId)) {
    const w = lab.scene(saveId).rules.weather;
    const date = dayOf(t);
    const plan = planned(saveId, date);
    const st = ledger.world(saveId);
    const written = st.weather?.day === date ? st.weather : null;
    const minute = (minuteOf(t) - 300 + 1440) % 1440; // since 05:00
    const am = written?.am ?? plan.am;
    const kind = written ? written.kind : minute >= 9 * 60 ? plan.pm : plan.am;
    const today = temps(w, am, plan.i), tomorrow = temps(w, planned(saveId, addDays(date, 1)).am, plan.i + 1);
    const yest = plan.i > 1 ? planned(saveId, addDays(date, -1)) : null;
    return { date, day: plan.i, am, pm: plan.pm, kind, sky: skyOf(t), temp: Math.round(tempAt(today, tomorrow, minute)), hi: today.hi, lo: Math.min(today.lo, tomorrow.lo),
      wind: temps(w, kind, plan.i).wind, dayStart: dayStartT(date), yesterday: yest ? [yest.am, yest.pm] : [] };
  }

  return { tick, now, fireOutRefs, climate, planned, dayIndex };
}
