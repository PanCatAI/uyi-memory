// 3.0 G2: the user goes scouting while away (booked from the god panel with the session closed). At 09:00 of the
// booked day the host rolls 1–2 finds for that direction from scenes/camp.scout.json (conditions, once, rand01) and
// writes user_action scout { dir, finds } that nobody perceives: she was not there. She learns a find only from the
// user's words, and puts it on her map with mark_map — sure only when the user's words this session named it.
import { rand01 } from './rand.mjs';
import { match } from './rules.mjs';
import { dayOf, addDays, atTime, minuteOf, hm } from './climate.mjs';

/** Which scouted find a mark_map is about: args.find when it is one, else the find whose keywords her note uses. */
export function mapFind(state, scene, args = {}) {
  const finds = state.scouted?.finds || [];
  const defs = scene.scout?.finds || [];
  const kw = id => defs.find(d => d.id === id)?.keywords || [];
  if (finds.includes(args.find)) return args.find;
  const note = String(args.note || '');
  return finds.find(id => kw(id).some(k => note.includes(k))) || (note ? null : finds.find(id => kw(id).some(k => (state.sessionText || '').includes(k)))) || null;
}
/** Did the user's words this session name the find (any of its keywords)? */
export const userNamed = (state, scene, id) => (scene.scout?.finds.find(d => d.id === id)?.keywords || []).some(k => (state.sessionText || '').includes(k));

/** The arbiter's check for mark_map (null = allowed). */
export function mapBlock(state, scene, action) {
  if (!state.scouted?.finds?.length) return '他还没去探过路';
  const f = mapFind(state, scene, action.args);
  if (!f) return '他没说过那儿有什么';
  if (action.args?.sure === true && !userNamed(state, scene, f)) return '他没说清楚那儿是什么（只能先打个问号：sure 填 false）';
  const had = (state.vars?.map || []).find(m => m.find === f);
  if (had && (had.sure || !action.args?.sure)) return '地图上已经画了';
  return null;
}

export function createScout(lab) {
  const { ledger, clock } = lab;
  const table = saveId => lab.scene(saveId).scout;
  const on = saveId => Boolean(lab.scene(saveId).rules && table(saveId)) && lab.features(saveId).scout;
  const dirs = saveId => [...new Set((table(saveId)?.finds || []).map(f => f.dir))];

  /** Why a direction cannot be scouted now (null = it can). */
  function blocked(saveId, dir) {
    const b = table(saveId)?.blocked?.[dir];
    if (!b) return null;
    const { reason, ...cond } = b;
    return match(cond, lab.rules.context(saveId, lab.scene(saveId).characters[0].id)) ? reason : null;
  }

  /** Books a scout for the next 09:00 (today's if it has not come yet). Only while the user is away. */
  function book(saveId, dir) {
    if (!on(saveId)) throw new Error('这个存档没开「探路和地图」');
    if (ledger.world(saveId).sessionOpen) throw new Error('先结束会话：你不在营地的时候才能去探路');
    if (!dirs(saveId).includes(dir)) throw new Error(`没有这个方向：${dir}`);
    const why = blocked(saveId, dir);
    if (why) throw new Error(`${dir}去不了：${why}`);
    const now = clock.now(saveId);
    const at = table(saveId).at || '09:00';
    const day = atTime(dayOf(now), at) > now ? dayOf(now) : addDays(dayOf(now), 1);
    return lab.worldsim.setVar(saveId, 'scout_plan', { dir, day }, `用户打算${day.slice(5)}去${dir}探路`, now);
  }

  /** The finds of a scout: 1, then a second with second_chance; conditions and once respected. */
  function roll(saveId, dir, day, forced = null) {
    if (forced) return forced;
    const ctx = lab.rules.context(saveId, lab.scene(saveId).characters[0].id);
    const before = new Set(ledger.list(saveId, { types: ['user_action'], all: true }).filter(e => e.action === 'scout').flatMap(e => e.payload?.args?.finds || []));
    const pool = table(saveId).finds.filter(f => f.dir === dir && (!f.when || match(f.when, ctx)) && !(f.once && before.has(f.id)));
    const out = [];
    if (!pool.length) return out;
    out.push(pool[Math.floor(rand01(saveId, 'scout', day, 1) * pool.length)].id);
    const rest = pool.filter(f => f.id !== out[0]);
    if (rest.length && rand01(saveId, 'scout', day, 'again') < (table(saveId).second_chance ?? 0.5)) out.push(rest[Math.floor(rand01(saveId, 'scout', day, 2) * rest.length)].id);
    return out;
  }

  /** The scout itself, at t: user_action scout { dir, finds }, perceived by nobody. */
  function go(saveId, dir, t, forced = null) {
    const day = dayOf(t);
    const finds = roll(saveId, dir, day, forced);
    const last = ledger.list(saveId, { desc: true, limit: 1 })[0]?.t ?? t;
    const ev = ledger.append(saveId, { type: 'user_action', actor: 'user', action: 'scout', target: null, room: null, perceivers: [], offscreen: !ledger.world(saveId).sessionOpen, t: Math.max(t, last), payload: { args: { dir, finds } } });
    return [ev, ...lab.worldsim.setVar(saveId, 'scout_plan', null, '探完回来了', ev.t)];
  }

  /** worldsim, every hour: a booked scout whose 09:00 this is. */
  function hour(saveId, H) {
    if (!on(saveId) || minuteOf(H) !== hm(table(saveId).at || '09:00')) return [];
    const plan = ledger.world(saveId).vars?.scout_plan;
    if (!plan || plan.day !== dayOf(H)) return [];
    return go(saveId, plan.dir, H, plan.finds || null); // finds: a scenario's fixed ones
  }

  /**
   * After her reply: a draw_map while something the user scouted is not on her map yet, and his words this turn name
   * it, is her drawing it: → mark_map { find, note, sure } (sure when he gave a distance). Anything else unchanged.
   */
  function fixAction(saveId, action, input) {
    if (!on(saveId) || !action) return action;
    const one = a => {
      if (a?.name !== 'draw_map') return a;
      const st = ledger.world(saveId);
      const marked = new Set((st.vars?.map || []).map(m => m.find));
      const seen = new Set(ledger.list(saveId, { types: ['user_action'], all: true }).filter(e => e.action === 'scout').flatMap(e => e.payload?.args?.finds || []));
      const def = (table(saveId)?.finds || []).find(f => seen.has(f.id) && !marked.has(f.id) && f.keywords.some(k => String(input).includes(k)));
      if (!def) return a;
      const note = def.keywords.find(k => String(input).includes(k));
      return { name: 'mark_map', target: null, args: { find: def.id, note, sure: /[一二三四五六七八九十两半\d]+\s*(里|米|步)/.test(String(input)) } };
    };
    return Array.isArray(action) ? action.map(one) : one(action);
  }

  /** What the user saw on the latest scout (for the card when they come back): [{ id, text, li, dir }]. */
  function latest(saveId) {
    const ev = ledger.list(saveId, { types: ['user_action'], desc: true, limit: 50 }).find(e => e.action === 'scout');
    if (!ev) return null;
    const defs = table(saveId)?.finds || [];
    return { seq: ev.seq, t: ev.t, dir: ev.payload.args.dir, finds: ev.payload.args.finds.map(id => defs.find(d => d.id === id)).filter(Boolean).map(d => ({ id: d.id, text: d.text, li: d.li, dir: d.dir })) };
  }

  return { book, go, hour, latest, blocked, dirs, on, fixAction };
}
