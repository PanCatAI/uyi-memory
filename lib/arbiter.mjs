// One arbiter per character (PLAN §4.5): a serial queue per (save, character, lane), plus the legality check
// that every model-proposed action passes before the host executes it.
import { roomOf, applyEvent } from './world.mjs';
import { roomName, sameArea } from './scene.mjs';
import { planWalk, standPoint } from './nav.mjs';
import { ruleBlock } from './rules.mjs';

export function createQueues() {
  const tails = new Map();
  const pending = new Map(); // saveId → count
  return {
    /** Runs fn after everything queued before it on the same (save, character, lane). lane: 'act' | 'jobs'. */
    queue(saveId, charId, lane, fn) {
      const key = `${saveId}|${charId}|${lane}`;
      pending.set(saveId, (pending.get(saveId) || 0) + 1);
      const run = (tails.get(key) || Promise.resolve()).then(() => fn());
      const tail = run.catch(() => {}).finally(() => {
        pending.set(saveId, pending.get(saveId) - 1);
        if (tails.get(key) === tail) tails.delete(key);
      });
      tails.set(key, tail);
      return run;
    },
    pending: saveId => pending.get(saveId) || 0,
    /** Resolves when nothing is queued for this save (including work queued while waiting). */
    async idle(saveId) {
      for (;;) {
        const mine = [...tails.entries()].filter(([k]) => k.startsWith(`${saveId}|`)).map(([, p]) => p);
        if (!mine.length) return;
        await Promise.all(mine);
      }
    }
  };
}

const NAME = (state, scene, id) => state.objects[id]?.name || state.characters[id]?.name || roomName(scene, id);

/** { ok: true } | { ok: false, reason } */
export function checkAction(state, scene, charId, action, { userPresent } = {}) {
  const c = state.characters[charId];
  if (!c) return { ok: false, reason: '没有这个角色' };
  const spec = scene.actions[action?.name];
  if (!spec) return { ok: false, reason: `不会做这个动作：${action?.name}` };
  const target = action.target ?? null;
  const kinds = String(spec.target).split('|');
  const isRoom = scene.rooms.some(r => r.id === target);
  const isObject = Boolean(state.objects[target]);
  const kindOk = (kinds.includes('none') && !target) || (kinds.includes('room') && isRoom) || (kinds.includes('object') && isObject) || (kinds.includes('user') && target === 'user');
  if (!kindOk) {
    // Said in words a player understands: the thing by its name, or "不在这里/没有" when it does not exist at all.
    const known = isRoom || isObject || target === 'user';
    return { ok: false, reason: !target ? '不知道要对什么做' : known ? `${target === 'user' ? '你' : NAME(state, scene, target)}不能这样（${spec.desc}）` : `这里没有「${target}」` };
  }
  const o = state.objects[target];
  const present = userPresent ?? (state.sessionOpen && sameArea(scene, state.userRoom, c.room));
  for (const need of spec.needs || []) {
    if (need === 'same_room' && roomOf(state, target) !== c.room) return { ok: false, reason: `${NAME(state, scene, target)}不在这里` };
    if (need.startsWith('tag:') && !(o?.tags || []).includes(need.slice(4))) return { ok: false, reason: `${NAME(state, scene, target)}不能这样用` };
    if (need === 'hands_free' && c.holding) return { ok: false, reason: `手里已经拿着${NAME(state, scene, c.holding)}了` };
    if (need === 'holding' && !c.holding) return { ok: false, reason: '手里什么都没拿' };
    if (need === 'held_target' && c.holding !== target) return { ok: false, reason: `手里没有${NAME(state, scene, target)}` };
    if (need === 'user_present' && !present) return { ok: false, reason: '用户不在旁边' };
    if (need === 'reachable' && (o?.tags || []).includes('high') && !c.elevated) return { ok: false, reason: `${NAME(state, scene, target)}太高了，够不着` };
    if (need === 'sitting' && !c.sitting) return { ok: false, reason: '得先坐下来' };
    if (need === 'inside' && !scene.rooms.find(r => r.id === c.room)?.exit_to) return { ok: false, reason: '本来就在外面' };
  }
  const blocked = ruleBlock(state, scene, charId, { ...action, target }); // 3.0 F3: 没柴了, 柴是湿的, 得先走到小路…
  if (blocked) return { ok: false, reason: blocked, rule: true };
  const w = action.args?.with;
  if (w != null && spec.with) {
    if (!state.objects[w]) return { ok: false, reason: `这里没有「${w}」` };
    if (roomOf(state, w) !== c.room) return { ok: false, reason: `${NAME(state, scene, w)}不在这里` };
  }
  return { ok: true };
}

/** Events the host appends for a proposed action (failed actions are recorded too). */
export function actionEvents(state, scene, charId, action, check, extra = {}) {
  const base = { type: 'char_action', actor: charId, action: action.name, target: action.target ?? null, ...extra };
  if (!check.ok) return [{ ...base, outcome: 'failed', payload: { args: action.args || {}, reason: check.reason } }];
  const c = state.characters[charId];
  const evs = [];
  if (action.name === 'walk_to') {
    const dest = scene.rooms.some(r => r.id === action.target) ? action.target : roomOf(state, action.target);
    if (dest && dest !== c.room) evs.push({ type: 'char_moved', actor: charId, target: dest, payload: { from: c.room, to: dest }, ...extra });
  }
  const held = ['put_down', 'give'].includes(action.name) ? c.holding : null;
  // 2.0 C4: in an imported camp the walk there is part of the action; the browser plays this path.
  const walk = planWalk(scene, state, charId, action);
  if (walk && !walk.ok && !process.env.LAB_QUIET) console.warn(`[nav] 没找到路，直线走：${charId} ${action.name} → ${action.target}`);
  const out = action.name === 'leave' && scene.studio ? leavePath(scene, state, charId) : null;
  evs.push({ ...base, outcome: 'ok', payload: { args: action.args || {}, ...(held ? { held } : {}), ...(walk ? { path: walk.path } : {}), ...(out ? { path: out } : {}) } });
  return evs;
}

/** Coming out of the tent: from its door to the door's stand point. */
function leavePath(scene, state, charId) {
  const room = state.characters[charId].room;
  const door = Object.values(state.objects).find(o => o.leads_to === room);
  if (!door) return null;
  const fire = Object.values(state.objects).find(o => (o.tags || []).includes('fire'));
  return [standPoint(scene, state, door, fire ? [fire.pos[0], fire.pos[2]] : [0, 0])];
}

/** Action list for prompts: "- walk_to（目标：room|object）：走到某个房间或物件旁边". */
export const actionsText = scene => Object.entries(scene.actions).map(([n, a]) => `- ${n}（目标：${a.target}）：${a.desc}`).join('\n');

const KIND_OF = (state, scene, id) => (id === 'user' ? 'user' : scene.rooms.some(r => r.id === id) ? 'room' : state.objects[id] ? 'object' : null);

/**
 * Maps a model-written target to a scene id, deterministically (no model call). An existing id is kept. Otherwise a
 * name is matched among the targets this action accepts: exact name first, then a unique partial name. Two or more
 * matches is ambiguous and refused — the host never guesses one.
 * → { target, mapped?: { from, to } } | { target, ambiguous: [ids] } | { target } (unchanged; the check will fail)
 */
export function resolveTarget(state, scene, action, { userName } = {}) {
  const target = action?.target;
  const spec = scene.actions[action?.name];
  if (target == null || target === '' || !spec || KIND_OF(state, scene, target)) return { target: target ?? null };
  const kinds = String(spec.target).split('|');
  const t = String(target).trim();
  const pool = [];
  if (kinds.includes('object')) for (const o of Object.values(state.objects)) pool.push([o.id, o.name]);
  if (kinds.includes('room')) for (const r of scene.rooms) pool.push([r.id, r.name]);
  if (kinds.includes('user') && ['用户', '你', userName].filter(Boolean).includes(t)) return { target: 'user', mapped: { from: t, to: 'user' } };
  const pick = list => [...new Set(list.map(([id]) => id))];
  let hits = pick(pool.filter(([, name]) => name === t));
  if (!hits.length) hits = pick(pool.filter(([, name]) => name.includes(t) || t.includes(name)));
  if (hits.length === 1) return { target: hits[0], mapped: { from: t, to: hits[0] } };
  if (hits.length > 1) return { target: t, ambiguous: hits };
  return { target: t };
}

// Actions with no lasting effect: when one fails, the line can still be delivered as is.
export const COSMETIC_ACTIONS = ['look_at', 'wave', 'idle'];
const TRY = { walk_to: n => `走到${n}`, pick_up: n => `拿起${n}`, put_down: n => `把东西放到${n}上`, give: () => '把东西递给你', wear: n => `戴上${n}`, clean: n => `擦一擦${n}`, sit: n => `坐到${n}上`, climb: n => `爬上${n}`, switch: n => `开${n}`, tend_fire: n => `给${n}添柴`, enter: n => `进${n}`, leave: () => '出去', draw_map: () => '画图' };

/** The short line the host delivers instead of the model's when an action did not happen. First person, no guessing. */
export function failureLine(state, scene, action, reason, done = []) {
  const what = a => (TRY[a.name] || (() => scene.actions[a.name]?.desc || a.name))(a.target ? (NAME(state, scene, a.target) || `「${a.target}」`) : '');
  const before = done.filter(a => !COSMETIC_ACTIONS.includes(a.name)).map(what);
  return `${before.length ? `我${before.join('，')}了；` : ''}我想${what(action)}，可是没成功：${String(reason).replace(/（.*）/g, '').replace(/用户/g, '你')}。`; // the action's definition in （） is for the model, not for her line
}

/**
 * Perceivable targets for the reply prompt, each with the actions that would pass the check right now:
 * rooms (to walk to), objects in this room or on this character, and the user when present.
 */
export function perceivable(state, scene, charId) {
  const c = state.characters[charId];
  const rows = [];
  const legal = (kind, id) => Object.entries(scene.actions)
    .filter(([, a]) => String(a.target).split('|').includes(kind))
    .filter(([name]) => checkAction(state, scene, charId, { name, target: id }).ok).map(([name]) => name);
  for (const r of scene.rooms) rows.push({ id: r.id, name: r.name, where: r.id === c.room ? '房间（你在这里）' : '房间', actions: legal('room', r.id) });
  for (const o of Object.values(state.objects)) {
    const mine = o.holder === charId || o.worn_by === charId;
    if (!mine && (roomOf(state, o.id) !== c.room || o.holder || o.worn_by)) continue;
    const where = o.holder === charId ? '在你手里' : o.worn_by === charId ? '你戴着' : `${roomName(scene, c.room)}${o.on ? `，放在${NAME(state, scene, o.on)}上` : ''}${(o.tags || []).includes('high') ? '，高处' : ''}${o.state?.on ? '，亮着' : ''}${o.state?.lit ? '，火烧着' : ''}`;
    rows.push({ id: o.id, name: o.name, where, actions: legal('object', o.id) });
  }
  if (state.sessionOpen && sameArea(scene, state.userRoom, c.room)) rows.push({ id: 'user', name: '用户', where: state.userRoom === c.room ? '在你旁边' : `在附近（${roomName(scene, state.userRoom)}）`, actions: legal('user', 'user') });
  const free = Object.entries(scene.actions).filter(([, a]) => String(a.target).split('|').includes('none'))
    .filter(([n]) => checkAction(state, scene, charId, { name: n }).ok).map(([n]) => n);
  return { rows, free };
}

// "我戴上了" with no action: the line says something happened that the host never did. Completed-action phrases per
// action, and whether the world already shows it (then the line is just describing the present, which is fine).
const DONE = {
  wear: [/(戴上了|戴好了|围上了|系上了|(?<![没不])(一直)?戴着)/, (st, c) => c.wearing.length > 0],
  climb: [/(爬上来了|爬上去了|爬到顶了|上来了|到顶了|爬到一半|爬了一半|上到一半)/, (st, c) => c.elevated],
  switch: [/(点亮了|打开了|灯亮了|开了灯|关掉了|关了灯)/, () => false],
  put_down: [/(放好了|放下了|收好了|(?<![会要想去就先])放在.{1,6}上(?![吧吗]))/, (st, c) => !c.holding],
  pick_up: [/(拿起来了|捡起来了|拿到了)/, (st, c) => Boolean(c.holding)],
  sit: [/(坐下了|坐好了)/, (st, c) => Boolean(c.sitting)]
};
/** Action names the line claims as done that neither this turn's action nor the current world backs up. */
export function unbackedClaims(state, charId, say, action) {
  const c = state.characters[charId];
  if (!c) return [];
  const doing = new Set(actionList(action).map(a => a.name));
  return Object.entries(DONE).filter(([name, [re, already]]) => re.test(String(say)) && !doing.has(name) && !already(state, c)).map(([name]) => name);
}

export const MAX_ACTIONS = 3;
/** The model's action field as a list: null → [], one object → [it], an array → its first MAX_ACTIONS items. */
export const actionList = a => (Array.isArray(a) ? a.slice(0, MAX_ACTIONS) : a ? [a] : []).filter(x => x && typeof x.name === 'string');

/**
 * Checks a short sequence of actions in order on a copy of the world, so "walk_to wardrobe, then put_down wardrobe"
 * is judged after the walk. Stops at the first failure that is not cosmetic. Nothing is written.
 * → { steps: [{ action, check, mapped? }], failed: step | null }
 */
export function planActions(state, scene, charId, proposed, { userName } = {}) {
  const sim = structuredClone(state);
  const steps = [];
  let failed = null;
  for (const p of actionList(proposed)) {
    const res = resolveTarget(sim, scene, p, { userName });
    // An action that takes no target ("draw_map log-bench-1" after sitting there) is done without one.
    const action = { name: p.name, target: scene.actions[p.name]?.target === 'none' ? null : res.target ?? null, args: p.args || {} };
    const already = alreadyDone(sim, charId, action);
    const check = already ? { ok: true, noop: already } : res.ambiguous ? { ok: false, reason: `「${res.target}」不止一个，不知道是哪一个` } : checkAction(sim, scene, charId, action);
    steps.push({ action, check, ...(res.mapped ? { mapped: res.mapped } : {}) });
    if (check.noop) continue;
    if (check.ok) for (const ev of actionEvents(sim, scene, charId, action, check)) applyEvent(sim, scene, ev);
    else if (!COSMETIC_ACTIONS.includes(action.name)) { failed = steps.at(-1); break; }
  }
  return { steps, failed };
}

/**
 * When the world is already the way the action would leave it ("put it on the wardrobe" right after she did), it is
 * not a failure: there is nothing to do. Returns a short reason, or null.
 */
export function alreadyDone(state, charId, action) {
  const c = state.characters[charId];
  const o = state.objects[action.target];
  if (!c) return null;
  if (action.name === 'pick_up' && c.holding && c.holding === action.target) return '已经拿在手里了';
  if (action.name === 'put_down' && !c.holding && Object.values(state.objects).some(x => x.on === action.target && !x.holder)) return '已经放在那里了';
  if (action.name === 'wear' && c.wearing.includes(action.target)) return '已经戴着了';
  if (action.name === 'climb' && c.elevated) return '已经在上面了';
  if (action.name === 'sit' && o && c.sitting === o.id) return '已经坐着了';
  return null;
}
