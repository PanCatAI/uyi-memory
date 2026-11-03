// World state = scene + fold over ledger events (PLAN §3.1). Pure functions: no database, no clock.
import { roomCenter } from './scene.mjs';

export function initialState(scene) {
  const characters = {}, objects = {};
  for (const c of scene.characters) characters[c.id] = { id: c.id, name: c.name, room: c.room, pos: [...c.pos], holding: null, wearing: [], elevated: false, sitting: null };
  for (const o of scene.objects) {
    objects[o.id] = { ...structuredClone(o), holder: null, worn_by: o.worn_by ?? null, state: { ...(o.state || {}) } };
    if (o.worn_by && characters[o.worn_by]) { characters[o.worn_by].wearing.push(o.id); objects[o.id].room = characters[o.worn_by].room; }
  }
  // 3.0 F1: the camp's 量 start from the scene's rules (no rules → {}); weather, active incidents and the running
  // practice are folded from their events too, so every rule reads one state.
  return { userRoom: scene.user_room ?? scene.characters[0].room, sessionOpen: false, characters, objects,
    vars: structuredClone(scene.rules?.vars || {}), weather: null, sign: null, incidents: {}, incidentStarts: {}, practice: null };
}

/** Room an object is in: a held object is wherever its holder is. */
export function roomOf(state, id) {
  if (state.characters[id]) return state.characters[id].room;
  const o = state.objects[id];
  if (!o) return null;
  const by = o.worn_by || o.holder;
  if (by === 'user') return state.userRoom;
  if (by && state.characters[by]) return state.characters[by].room;
  return o.room;
}

function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  let cur = obj;
  for (const k of keys.slice(0, -1)) cur = cur[k] ??= {};
  cur[keys.at(-1)] = value;
}

function setHolder(state, objectId, to) {
  const o = state.objects[objectId];
  if (!o) return;
  const old = o.holder;
  if (old && state.characters[old] && state.characters[old].holding === objectId) state.characters[old].holding = null;
  o.holder = to ?? null;
  if (to) o.on = null; // picked up: no longer resting on anything
  if (to && state.characters[to]) state.characters[to].holding = objectId;
}

/** Applies one event to state in place and returns state. */
export function applyEvent(state, scene, ev) {
  const p = ev.payload || {};
  switch (ev.type) {
    case 'session_start': state.sessionOpen = true; state.sessionText = ''; break;
    case 'session_end': state.sessionOpen = false; break;
    case 'user_said':
      if (state.characters[p.to]) state.userRoom = state.characters[p.to].room;
      if (state.vars) state.sessionText = `${state.sessionText || ''}\n${p.text || ''}`.slice(-4000); // 3.0 G2: what the user said this session
      break;
    case 'user_action': if (ev.action === 'scout' && state.vars) state.scouted = { seq: ev.seq, dir: p.args?.dir, finds: p.args?.finds || [] }; break;
    case 'char_moved': {
      const c = state.characters[ev.actor];
      if (c) { c.room = p.to; c.pos = roomCenter(scene, p.to); c.elevated = false; c.sitting = null; }
      break;
    }
    case 'char_action': {
      if (ev.outcome !== 'ok') break;
      const c = state.characters[ev.actor];
      const o = state.objects[ev.target];
      if (!c) break;
      // 2.0 C4: a walked action leaves the character where the path ends (enter/leave below still pick the room).
      const end = p.path?.at(-1);
      if (end) { c.pos = [end[0], 0, end[1]]; c.sitting = null; }
      if (ev.action === 'pick_up' && o) setHolder(state, o.id, c.id);
      else if (ev.action === 'put_down' && c.holding) {
        const held = state.objects[c.holding];
        setHolder(state, held.id, null);
        if (o) { held.room = roomOf(state, o.id); held.pos = [o.pos[0], o.pos[1] + 0.5, o.pos[2]]; held.on = o.id; }
      } else if (ev.action === 'give' && c.holding) setHolder(state, c.holding, 'user');
      else if (ev.action === 'wear' && o) { setHolder(state, o.id, null); o.worn_by = c.id; o.room = c.room; if (!c.wearing.includes(o.id)) c.wearing.push(o.id); }
      else if (ev.action === 'sit' && o) c.sitting = o.id;
      else if (ev.action === 'climb') c.elevated = true;
      else if (ev.action === 'switch' && o) o.state.on = !o.state.on;
      else if (ev.action === 'tend_fire' && o) { o.state.lit = true; o.state.tended_at = ev.t ?? null; }
      else if (ev.action === 'enter' || ev.action === 'leave') {
        const to = ev.action === 'enter' ? o?.leads_to : scene.rooms.find(r => r.id === c.room)?.exit_to;
        if (to) { c.room = to; c.pos = roomCenter(scene, to); c.elevated = false; c.sitting = null; }
      }
      break;
    }
    case 'object_created': {
      const def = p.object;
      state.objects[def.id] = { ...structuredClone(def), holder: null, worn_by: null, state: { ...(def.state || {}) } };
      break;
    }
    case 'object_changed': {
      const o = state.objects[ev.target];
      if (!o) break;
      if (p.field === 'holder') setHolder(state, o.id, p.to);
      else { setPath(o, p.field, p.to); if (p.field === 'room') o.on = null; }
      break;
    }
    case 'fire_out': { const o = state.objects[ev.target]; if (o) o.state.lit = false; break; }
    // 3.0 F
    case 'var_changed': if (state.vars) state.vars[p.var] = structuredClone(p.to); break;
    case 'weather': state.weather = { day: p.day, am: p.kind, kind: p.kind, temp_hi: p.temp_hi ?? null, temp_lo: p.temp_lo ?? null, wind: p.wind ?? null, since: ev.t }; break;
    case 'weather_change': if (state.weather) state.weather = { ...state.weather, kind: p.kind, since: ev.t, forced: Boolean(p.cause) }; break;
    case 'sky_sign': state.sign = { sign: p.sign, day: p.day, seq: ev.seq }; break;
    case 'incident': {
      if (!state.incidents) break;
      if (p.phase === 'start') {
        state.incidentStarts[p.incident] = ev.t;
        if (p.lasting) state.incidents[p.incident] = { id: p.incident, seq: ev.seq, t: ev.t, sev: p.sev, target: ev.target ?? null, deadline: p.deadline ?? null };
      } else delete state.incidents[p.incident];
      break;
    }
    case 'bet': state.bet = p.phase === 'made' ? { ...p, seq: ev.seq } : null; break;
    case 'practice': state.practice = p.phase === 'start' || p.phase === 'step' ? { id: p.practice, step: p.step ?? 0, since: p.phase === 'start' ? ev.t : state.practice?.since ?? ev.t } : null; break;
    case 'world_edit': {
      if (p.op === 'add' && p.object?.id) state.objects[p.object.id] = { ...structuredClone(p.object), holder: null, worn_by: null, state: { ...(p.object.state || {}) } };
      const o = state.objects[ev.target];
      if (!o) break;
      if (p.op === 'remove') {
        for (const c of Object.values(state.characters)) if (c.sitting === o.id) c.sitting = null;
        delete state.objects[ev.target];
      } else if (p.op === 'move' && p.to) { o.room = p.to.room; o.pos = [...p.to.pos]; o.on = null; if (p.to.sit) { o.sit = [...p.to.sit]; o.facing = p.to.facing; } }
      break;
    }
    case 'object_removed': {
      const o = state.objects[ev.target];
      if (o) { setHolder(state, o.id, null); delete state.objects[ev.target]; }
      break;
    }
  }
  return state;
}

export function foldWorld(scene, events) {
  const state = initialState(scene);
  for (const ev of events) applyEvent(state, scene, ev);
  return state;
}
