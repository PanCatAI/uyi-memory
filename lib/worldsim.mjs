// 3.0 F2/F3/F5: the camp runs on its own (contracts/world.md). advance() walks every whole world hour from the
// save's world watermark to now and writes, in time order, what the rules make true: the morning weather and the
// 14:00 turn, the evening sky sign, the 量 (柴, 口粮, 雪线, 阿砾, 累), the fire burning out, then the director's
// checks and her fixing what she can. Only with features.world (lab.scene(saveId).rules); no model calls.
// Every action's effect on the 量 is written here too, from the ledger's onAppend: var_changed right after the action.
import { HOUR, DAY } from './clock.mjs';
import { rand01 } from './rand.mjs';
import { dayOf, minuteOf, hm, atTime } from './climate.mjs';
import { setWatermark, getWatermark, nameOf } from './memory/common.mjs';
import { mapFind } from './scout.mjs';

export const SIM_HOURS = 72;          // coming back after longer: only the daily 量 for the older part, no incidents
const WATERMARK = ['host', 'world'];

export function createWorldSim(lab) {
  const { ledger, clock } = lab;
  const rulesOf = saveId => lab.scene(saveId).rules;
  const on = saveId => Boolean(rulesOf(saveId));
  const lastT = saveId => ledger.list(saveId, { desc: true, limit: 1 })[0]?.t ?? clock.now(saveId);
  const offscreen = saveId => !ledger.world(saveId).sessionOpen;
  /** Host event at t (never before the last event), off-screen when the user is away. */
  function host(saveId, t, ev) {
    const off = offscreen(saveId);
    return ledger.append(saveId, { actor: 'host', ...ev, t: Math.max(t, lastT(saveId)), ...(off ? { offscreen: true } : {}) });
  }
  const everyone = saveId => lab.scene(saveId).characters.map(c => c.id);
  const outdoors = saveId => {
    const st = ledger.world(saveId), scene = lab.scene(saveId);
    return Object.values(st.characters).filter(c => !scene.rooms.find(r => r.id === c.room)?.exit_to).map(c => c.id);
  };

  /** var_changed when the value really changes. numbers are clamped by the rules (wood ≤ wood_max, ≥ 0). */
  function setVar(saveId, name, to, cause, t) {
    const st = ledger.world(saveId);
    const from = st.vars?.[name] ?? null;
    if (JSON.stringify(from) === JSON.stringify(to)) return [];
    return [host(saveId, t, { type: 'var_changed', perceivers: everyone(saveId), room: lab.scene(saveId).user_room, payload: { var: name, from, to, cause } })];
  }
  function addVar(saveId, name, n, cause, t) {
    const r = rulesOf(saveId);
    const from = Number(ledger.world(saveId).vars?.[name] ?? 0);
    let to = from + n;
    if (name === 'wood') to = Math.min(r.wood_max ?? Infinity, to);
    to = Math.max(0, Math.round(to * 100) / 100);
    return setVar(saveId, name, to, cause, t);
  }
  /** effects: { set, add, until_days, fire_out, object } (contracts/world.md). */
  function applyEffects(saveId, effects, cause, t) {
    const out = [];
    if (!effects) return out;
    for (const [k, v] of Object.entries(effects.set || {})) out.push(...setVar(saveId, k, v, cause, t));
    for (const [k, v] of Object.entries(effects.add || {})) out.push(...addVar(saveId, k, v, cause, t));
    for (const [k, d] of Object.entries(effects.until_days || {})) out.push(...setVar(saveId, k, Math.max(t, lastT(saveId)) + d * DAY, cause, t));
    if (effects.fire_out) {
      const o = ledger.world(saveId).objects[effects.fire_out];
      if (o?.state?.lit) out.push(host(saveId, t, { type: 'fire_out', target: o.id, payload: { since: o.state.tended_at ?? t } }));
    }
    for (const [id, fields] of Object.entries(effects.object || {})) {
      for (const [f, v] of Object.entries(fields)) {
        const o = ledger.world(saveId).objects[id];
        if (!o) continue;
        if (f.startsWith('pos.')) {
          const pos = [...o.pos]; pos[Number(f.slice(4))] = v;
          out.push(host(saveId, t, { type: 'object_changed', target: id, payload: { field: 'pos', from: o.pos, to: pos } }));
        } else {
          const from = f.startsWith('state.') ? o.state?.[f.slice(6)] ?? null : o[f] ?? null;
          if (from !== v) out.push(host(saveId, t, { type: 'object_changed', target: id, payload: { field: f, from, to: v } }));
        }
      }
    }
    return out;
  }

  // ── what an action does to the 量 (her char_action ok, the user's user_action) ──────────────────────────────
  function onAction(saveId, ev) {
    const r = rulesOf(saveId);
    const out = [];
    const t = ev.t;
    if (ev.type === 'char_action' && ev.outcome === 'ok') {
      const rule = r.actions?.[ev.action];
      const who = nameOf(lab.scene(saveId), ev.actor);
      const cause = `${who}${rule?.cause || ev.action}`;
      if (rule?.map) out.push(...markMap(saveId, ev, cause));
      else if (rule?.effects?.chance) {
        const ch = rule.effects.chance, day = dayOf(t);
        const once = rule.requires?.find(q => q.once_per_day)?.once_per_day;
        const hit = rand01(saveId, ev.action, day) < ch.p;
        if (once) out.push(...setVar(saveId, once, day, hit ? cause : `${cause}，${ch.miss || '没成'}`, t));
        if (hit) for (const [k, v] of Object.entries(ch.add || {})) out.push(...addVar(saveId, k, v, cause, t));
      } else if (rule?.effects) out.push(...applyEffects(saveId, rule.effects, cause, t));
      // 3.0 F3: her look at the north slope in the early-morning slot is how she learns the snowline.
      if (ev.action === 'look_at' && ev.target === 'path') {
        const m = minuteOf(t);
        if (m >= hm('05:30') && m < hm('08:00')) out.push(...setVar(saveId, 'snowline_seen', ledger.world(saveId).vars.snowline, `${who}早上看了一眼北坡`, t));
      }
    }
    if (ev.type === 'user_action') {
      const gift = ev.action === 'give' && r.gifts?.[ev.target];
      if (gift) out.push(...applyEffects(saveId, gift, gift.cause, t));
      const ua = r.user_actions?.[ev.action];
      if (ua?.effects) out.push(...applyEffects(saveId, ua.effects, ua.cause, t));
    }
    out.push(...lab.director.onAction(saveId, ev));
    return out;
  }
  /** 3.0 G2: a mark on her map; a clue drawn sure for the first time is one more clue. */
  function markMap(saveId, ev, cause) {
    const scene = lab.scene(saveId), st = ledger.world(saveId);
    const find = mapFind(st, scene, ev.payload?.args);
    const def = scene.scout?.finds.find(d => d.id === find);
    if (!def) return [];
    const args = ev.payload.args || {};
    const sure = args.sure === true;
    const had = (st.vars.map || []).find(m => m.find === find);
    const entry = { find, dir: def.dir, note: String(args.note || def.keywords[0]).slice(0, 40), sure };
    const out = setVar(saveId, 'map', [...(st.vars.map || []).filter(m => m.find !== find), entry], cause, ev.t);
    if (def.kind === 'clue' && sure && !had?.sure) out.push(...addVar(saveId, 'clues', 1, `${cause}：像是师父留下的`, ev.t));
    return out;
  }

  // Effects are host events, never actions, so this does not recurse beyond a fix the user's 搭把手 sets off.
  ledger.onAppend((saveId, ev) => {
    if (['char_action', 'user_action'].includes(ev.type) && on(saveId)) onAction(saveId, ev);
  });

  // ── weather ────────────────────────────────────────────────────────────────────────────────────────────────
  const isRain = (saveId, kind) => (rulesOf(saveId).rain || []).includes(kind);
  /** The weather just became kind: the director's on_weather incidents first, then the plain rules they cover. */
  function weatherTurned(saveId, kind, t) {
    const out = [...lab.director.check(saveId, t, { onWeather: true })];
    const st = ledger.world(saveId);
    if (isRain(saveId, kind) && !st.vars.wood_covered && !st.vars.wood_wet) out.push(...setVar(saveId, 'wood_wet', true, '下雨了，柴没盖', t));
    if (kind === '大雨') for (const o of fires(st)) if (o.state.lit) out.push(host(saveId, t, { type: 'fire_out', target: o.id, payload: { since: o.state.tended_at ?? t } }));
    return out;
  }
  function morningWeather(saveId, date, t) {
    const st = ledger.world(saveId);
    if (st.weather?.day === date) return [];
    const c = lab.environment.climate(saveId, t);
    const p = lab.environment.planned(saveId, date);
    const ev = host(saveId, t, { type: 'weather', payload: { kind: p.am, day: date, temp_hi: c.hi, temp_lo: c.lo, wind: c.wind } });
    return [ev, ...weatherTurned(saveId, p.am, t)];
  }
  function afternoonWeather(saveId, date, t) {
    const st = ledger.world(saveId);
    const p = lab.environment.planned(saveId, date);
    if (st.weather?.day !== date || st.weather.kind === p.pm || st.weather.forced) return []; // a forced turn stays for the day
    const ev = host(saveId, t, { type: 'weather_change', payload: { kind: p.pm, from: st.weather.kind } });
    return [ev, ...weatherTurned(saveId, p.pm, t)];
  }
  function skySign(saveId, date, t) {
    const st = ledger.world(saveId);
    if (st.sign?.day === date) return [];
    const w = rulesOf(saveId).weather;
    const tomorrow = lab.environment.planned(saveId, dayOf(t + DAY)).am;
    const pick = Object.entries(w.signs?.[tomorrow] || { 天边发灰: 1 });
    const total = pick.reduce((a, [, x]) => a + x, 0);
    let x = rand01(saveId, 'sign', date) * total, sign = pick.at(-1)[0];
    for (const [k, n] of pick) { if (x < n) { sign = k; break; } x -= n; }
    return [host(saveId, t, { type: 'sky_sign', perceivers: outdoors(saveId), room: lab.scene(saveId).user_room, payload: { sign, day: date } })];
  }

  // ── the 量 over time ──────────────────────────────────────────────────────────────────────────────────────
  const fires = st => Object.values(st.objects).filter(o => (o.tags || []).includes('fire'));
  function snowline(saveId, date, t) {
    const r = rulesOf(saveId), st = ledger.world(saveId);
    const y = lab.environment.climate(saveId, t).yesterday[0];
    if (!y) return [];
    const [lo, hi] = r.snowline_range || [1600, 2600];
    const to = Math.max(lo, Math.min(hi, (st.vars.snowline ?? 1900) + (r.snowline_delta?.[y] ?? 0)));
    const out = setVar(saveId, 'snowline', to, `昨天${y}`, t);
    if (to >= (st.vars.pass_height ?? 2200) && !st.vars.pass_open) out.push(...setVar(saveId, 'pass_open', true, '雪线过了山口', t));
    return out;
  }
  function aliBack(saveId, t) {
    const st = ledger.world(saveId);
    if (lab.environment.dayIndex(saveId, t) !== 1 + Number(st.vars.ali_eta_days ?? Infinity)) return [];
    return [...addVar(saveId, 'food', 10, '阿砾带补给回来，又下山去送货了', t), ...addVar(saveId, 'ali_eta_days', 10, '阿砾又下山了', t)];
  }
  function sleepNight(saveId, t) {
    const out = [];
    const scene = lab.scene(saveId), st = ledger.world(saveId);
    for (const c of Object.values(st.characters)) {
      if (!('lan_tired' in st.vars)) break;
      const inside = Boolean(scene.rooms.find(r => r.id === c.room)?.exit_to);
      if (st.vars.tent_down) out.push(...addVar(saveId, 'lan_tired', 1, '帐篷塌了，在外面凑合了一夜', t));
      // A night she was got up in (tiredness went up in the last 10 hours) is no rest.
      else if (inside && st.vars.lan_tired > 0 && !ledger.list(saveId, { types: ['var_changed'], after: 0, desc: true, limit: 60 }).some(e => e.payload?.var === 'lan_tired' && e.payload.to > (e.payload.from ?? 0) && t - e.t < 10 * HOUR)) out.push(...addVar(saveId, 'lan_tired', -1, '在帐篷里睡了一整夜', t));
    }
    return out;
  }
  /** When the rain last stopped (the first non-rain weather after the last rain), or null while it rains. */
  function dryFrom(saveId) {
    const evs = ledger.list(saveId, { types: ['weather', 'weather_change', 'var_changed'], desc: true, limit: 200 });
    let from = null;
    for (const e of evs) {
      if (e.type === 'var_changed') { if (e.payload?.var === 'wood_wet' && e.payload.to === true) return Math.max(from ?? e.t, e.t); continue; }
      if (isRain(saveId, e.payload?.kind)) return from;
      from = e.t;
    }
    return from;
  }
  function drying(saveId, t) {
    const st = ledger.world(saveId), r = rulesOf(saveId);
    if (!st.vars.wood_wet || isRain(saveId, lab.environment.climate(saveId, t).kind)) return [];
    const from = dryFrom(saveId);
    const need = (fires(st).some(o => o.state.lit) ? r.wood_dry_hours?.fire_lit ?? 6 : r.wood_dry_hours?.no_fire ?? 12) * HOUR;
    if (from == null || t - from < need) return [];
    return setVar(saveId, 'wood_wet', false, '柴晾干了', t);
  }
  /** A lit fire left alone burns out: 3 hours, 1.5 in light rain (the 2.0 rule with the rain added). */
  function fireOut(saveId, t) {
    const out = [];
    const st = ledger.world(saveId);
    const kind = lab.environment.climate(saveId, t).kind;
    const hours = kind === '小雨' ? rulesOf(saveId).light_rain_fire_hours ?? 1.5 : 3;
    for (const o of fires(st)) {
      if (!o.state.lit) continue;
      const since = o.state.tended_at ?? ledger.list(saveId, { limit: 1 })[0]?.t ?? t;
      if (t - since >= hours * HOUR) out.push(host(saveId, since + hours * HOUR, { type: 'fire_out', target: o.id, payload: { since } }));
    }
    return out;
  }

  /** One whole world hour H. quick: only the daily 量 (the part of a long absence older than SIM_HOURS). */
  function hour(saveId, H, { quick = false } = {}) {
    const r = rulesOf(saveId);
    const m = minuteOf(H), date = dayOf(H);
    const out = [];
    if (m === hm('05:00')) {
      out.push(...morningWeather(saveId, date, H), ...snowline(saveId, date, H));
      if (!quick) out.push(...sleepNight(saveId, H), ...lab.bets.settle(saveId, H));
    }
    if (!quick && m === hm('14:00')) out.push(...afternoonWeather(saveId, date, H));
    if (!quick && m === hm(r.weather?.signs_at || '17:00')) out.push(...skySign(saveId, date, H));
    if (m === hm(r.ali_back_at || '18:00')) out.push(...aliBack(saveId, H));
    if (m === hm(r.food_per_day_at || '19:00')) out.push(...addVar(saveId, 'food', -1, '晚饭', H));
    if (quick) return out;
    out.push(...fireOut(saveId, H), ...drying(saveId, H), ...lab.director.check(saveId, H), ...lab.director.fixes(saveId, H), ...lab.scout.hour(saveId, H));
    return out;
  }

  /**
   * Walks the world from its watermark to toT (default now). between(H) runs before hour H (life's made-up routine
   * slots, so her day and the world's hours interleave in time order). The first call for a save starts at toT and
   * writes the day's weather. Returns the new events.
   */
  function advance(saveId, { toT = clock.now(saveId), between = null } = {}) {
    if (!on(saveId)) return [];
    const out = [];
    let wm = getWatermark(lab, saveId, ...WATERMARK) || null;
    if (wm == null || wm > toT) {
      out.push(...morningWeather(saveId, dayOf(toT), toT));
      setWatermark(lab, saveId, ...WATERMARK, toT);
      return out;
    }
    const full = toT - SIM_HOURS * HOUR;
    for (let H = Math.floor(wm / HOUR) * HOUR + HOUR; H <= toT; H += HOUR) {
      if (between) out.push(...between(H));
      out.push(...hour(saveId, H, { quick: H < full }));
    }
    out.push(...fireOut(saveId, toT));
    if (ledger.world(saveId).weather?.day !== dayOf(toT)) out.push(...morningWeather(saveId, dayOf(toT), toT));
    setWatermark(lab, saveId, ...WATERMARK, toT);
    return out;
  }

  /** F6 调试 / scenario force_weather: the weather turns to kind now (until the next morning). */
  function forceWeather(saveId, kind, cause = '调试') {
    const w = rulesOf(saveId)?.weather;
    if (!w) throw new Error('这个存档没开「天气和营地的量」');
    if (!w.kinds.includes(kind)) throw new Error(`没有这种天气：${kind}`);
    const out = advance(saveId);
    const t = clock.now(saveId);
    const from = ledger.world(saveId).weather?.kind ?? lab.environment.climate(saveId, t).kind;
    out.push(host(saveId, t, { type: 'weather_change', payload: { kind, from, cause } }), ...weatherTurned(saveId, kind, t));
    return out;
  }

  return { advance, forceWeather, setVar, addVar, applyEffects, host, onAction, atTime };
}
