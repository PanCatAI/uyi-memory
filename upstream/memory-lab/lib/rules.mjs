// 3.0 F1 (contracts/world.md): conditions over the world, written as data. match(cond, ctx) is true when every key
// holds; a condition's specificity is its number of keys (the most specific topic wins in G1). ctx is built once per
// check by createRules(lab).context(): world state, weather, temperature, stage, incidents, commitments.
import { stageIndex } from './card.mjs';
import { minuteOf, hm } from './climate.mjs';
import { sameArea } from './scene.mjs';
import { mapBlock } from './scout.mjs';

export const KEYS = ['weather_in', 'sky_in', 'hour_between', 'day_gte', 'temp_lte', 'temp_gte', 'var', 'object', 'stage_gte',
  'user_present', 'char_outdoors', 'incident_active', 'incident_not_active', 'incident_recent_h', 'has_untold', 'sign_today',
  'practice_active', 'commitment_due_today', 'user_scouted_today', 'bet_resolved_today',
  // custom keys for the incident table (contracts/world.md): yesterday's weather, a time-valued var still in the future
  'yesterday_weather_in', 'var_future', 'not',
  // G1: named checks the keys above cannot say (CUSTOM below)
  'custom'];
/** 3.0 G1: the named conditions, each worked out in context(). */
export const CUSTOM = ['snow_up', 'snow_down', 'map_clue', 'nuts_ready'];

export const specificity = cond => Object.keys(cond || {}).length;

/** A var or object field against a test: a plain value is equality; { eq, ne, gte, lte, gt, lt }; "$name" is another var, "$now" is t. */
export function compare(v, test, ctx) {
  const val = x => (typeof x === 'string' && x.startsWith('$') ? (x === '$now' ? ctx.t : ctx.vars?.[x.slice(1)]) : x);
  const eq = (a, b) => (typeof b === 'boolean' ? Boolean(a) === b : (a ?? null) === (b ?? null));
  if (test === null || typeof test !== 'object' || Array.isArray(test)) return eq(v, val(test));
  for (const [op, raw] of Object.entries(test)) {
    const x = val(raw);
    if (op === 'eq' && !eq(v, x)) return false;
    if (op === 'ne' && eq(v, x)) return false;
    if (['gte', 'lte', 'gt', 'lt'].includes(op)) {
      if (typeof v !== 'number' || typeof x !== 'number') return false;
      if ((op === 'gte' && !(v >= x)) || (op === 'lte' && !(v <= x)) || (op === 'gt' && !(v > x)) || (op === 'lt' && !(v < x))) return false;
    }
  }
  return true;
}

const field = (o, k) => (o?.state && k in o.state ? o.state[k] : o?.[k]);
export function inHours(minute, [from, to]) {
  const a = hm(from), b = hm(to);
  return a <= b ? minute >= a && minute < b : minute >= a || minute < b;
}

/** Is cond true in ctx? Unknown keys are false (a typo never passes silently). */
export function match(cond, ctx) {
  for (const [k, want] of Object.entries(cond || {})) {
    let ok;
    switch (k) {
      case 'weather_in': ok = want.includes(ctx.weather); break;
      case 'yesterday_weather_in': ok = (ctx.yesterday || []).some(x => want.includes(x)); break;
      case 'sky_in': ok = want.includes(ctx.sky); break;
      case 'hour_between': ok = inHours(minuteOf(ctx.t), want); break;
      case 'day_gte': ok = ctx.day >= want; break;
      case 'temp_lte': ok = ctx.temp != null && ctx.temp <= want; break;
      case 'temp_gte': ok = ctx.temp != null && ctx.temp >= want; break;
      case 'var': ok = Object.entries(want).every(([name, test]) => compare(ctx.vars?.[name], test, ctx)); break;
      case 'not': ok = !match(want, ctx); break;
      case 'custom': ok = Boolean(ctx.custom?.[want]); break;
      case 'var_future': ok = typeof ctx.vars?.[want] === 'number' && ctx.vars[want] > ctx.t; break;
      case 'object': ok = Object.entries(want).every(([id, fields]) => ctx.objects?.[id] && Object.entries(fields).every(([f, test]) => compare(field(ctx.objects[id], f), test, ctx))); break;
      case 'stage_gte': ok = stageIndex(ctx.stage) >= stageIndex(want); break;
      case 'user_present': ok = Boolean(ctx.userPresent) === want; break;
      case 'char_outdoors': ok = Boolean(ctx.charOutdoors) === want; break;
      case 'incident_active': ok = Boolean(ctx.active?.[want]); break;
      case 'incident_not_active': ok = !ctx.active?.[want]; break;
      case 'incident_recent_h': ok = ctx.starts?.[want.id] != null && ctx.t - ctx.starts[want.id] <= want.h * 3_600_000; break;
      case 'has_untold': ok = (ctx.untold || []).includes(want); break;
      case 'sign_today': ok = Boolean(ctx.sign) && want.includes(ctx.sign); break;
      case 'practice_active': ok = (ctx.practice ?? null) === want; break;
      case 'commitment_due_today': ok = (ctx.dueToday || []).some(text => text.includes(want)); break;
      case 'user_scouted_today': ok = Boolean(ctx.scoutedToday) === want; break;
      case 'bet_resolved_today': ok = Boolean(ctx.betResolvedToday) === want; break;
      default: ok = false;
    }
    if (!ok) return false;
  }
  return true;
}

/**
 * The world scene with features.world on: its rules and incidents attached, and the rules' extra actions
 * (gather_wood, cover_wood, …) added to the action table the model and the arbiter use.
 */
export function worldScene(scene) {
  const rules = scene.worldFiles.rules;
  const extra = Object.fromEntries(Object.entries(rules.actions || {}).filter(([n, a]) => a.spec && !scene.actions[n]).map(([n, a]) => [n, a.spec]));
  const f = scene.worldFiles;
  return { ...scene, rules, incidents: f.incidents?.incidents || [], topics: f.topics?.topics || [], scout: f.scout || null, practices: f.practices?.practices || [], actions: { ...scene.actions, ...extra } };
}

/** Why an action's rule blocks it right now (null = allowed). state.vars and the room come from the world fold. */
export function ruleBlock(state, scene, charId, action) {
  const rule = scene.rules?.actions?.[action.name];
  if (!rule) return null;
  if (rule.target && action.target !== rule.target) return `只能对${state.objects[rule.target]?.name || rule.target}这样做`;
  const c = state.characters[charId];
  if (rule.map) { const why = mapBlock(state, scene, action); if (why) return why; } // 3.0 G2 mark_map
  for (const r of rule.requires || []) {
    if (r.in && c.room !== r.in) return r.reason;
    if (r.var && !compare(state.vars?.[r.var], Object.fromEntries(Object.entries(r).filter(([k]) => ['eq', 'ne', 'gte', 'lte', 'gt', 'lt'].includes(k))), { vars: state.vars })) return r.reason;
    if (r.once_per_day && state.weather?.day && state.vars?.[r.once_per_day] === state.weather.day) return r.reason;
  }
  return null;
}

export function createRules(lab) {
  const { ledger, clock } = lab;
  /**
   * Everything a condition can ask, at t (default now), as seen by charId. A character's ctx is the host's view:
   * which of it reaches her prompt is the caller's business (the now section only shows what she knows).
   */
  function context(saveId, charId, { t = clock.now(saveId) } = {}) {
    const st = ledger.world(saveId);
    const scene = lab.scene(saveId);
    const c = st.characters[charId] || Object.values(st.characters)[0];
    const env = lab.environment.climate(saveId, t);
    const since = env.dayStart;
    const today = types => ledger.list(saveId, { types, desc: true, limit: 50 }).filter(e => e.t >= since);
    const inside = Boolean(scene.rooms.find(r => r.id === c?.room)?.exit_to);
    const due = c ? lab.commitments.list(saveId, c.id, 'open').filter(k => k.due_at != null && k.due_at >= since && k.due_at < since + 86_400_000).map(k => k.text) : [];
    // G1 custom: how her look at the snowline today compares with the one before; a clue drawn on the map in the last
    // hour; pine nuts in her hands or by the fire.
    const seen = today(['var_changed']).find(e => e.payload?.var === 'snowline_seen');
    const delta = seen && typeof seen.payload.from === 'number' ? seen.payload.to - seen.payload.from : 0;
    const clue = ledger.list(saveId, { types: ['var_changed'], desc: true, limit: 30 }).find(e => e.payload?.var === 'clues' && e.payload.to > (e.payload.from ?? 0));
    const nuts = st.objects['pine-nuts'];
    const custom = { snow_up: delta > 0, snow_down: delta < 0, map_clue: Boolean(clue && t - clue.t <= 3_600_000), nuts_ready: Boolean(nuts && (nuts.holder === c?.id || (!nuts.holder && nuts.room === 'fireside'))) };
    return {
      t, saveId, charId: c?.id, custom, day: env.day, date: env.date, weather: env.kind, yesterday: env.yesterday, sky: env.sky, temp: env.temp,
      vars: st.vars || {}, objects: st.objects, stage: c ? lab.relationship.compute(saveId, c.id).stage : '初识',
      userPresent: Boolean(st.sessionOpen && c && sameArea(scene, st.userRoom, c.room)),
      charOutdoors: !inside, active: st.incidents || {}, starts: st.incidentStarts || {},
      untold: lab.topics?.untold ? lab.topics.untold(saveId, c?.id) : [],
      sign: st.sign?.day === env.date ? st.sign.sign : null, practice: st.practice?.id ?? null, dueToday: due,
      scoutedToday: today(['user_action']).some(e => e.action === 'scout'),
      betResolvedToday: today(['bet']).some(e => e.payload?.phase === 'resolved')
    };
  }
  return { context, match, specificity };
}
