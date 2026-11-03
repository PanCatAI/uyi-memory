// Who perceives what (PLAN §4.4). Room-level: everyone in the room perceives an event; speech meant for someone
// else is only "overheard" (they know a conversation happened, not what was said).
// Rooms with the same `group` are open to each other (a camp clearing); a room without one has walls (a tent).
import { sameArea } from './scene.mjs';

export const perceiversFor = (state, room, scene) => Object.values(state.characters).filter(c => (scene ? sameArea(scene, c.room, room) : c.room === room)).map(c => c.id);

export function presenceFor(state, room, scene) {
  if (!state.sessionOpen) return 'absent';
  return (scene ? sameArea(scene, room, state.userRoom) : room === state.userRoom) ? 'present' : 'maybe';
}

const TIME_EVENTS = ['session_start', 'session_end', 'time_skip'];

/** 'full' | 'overheard' | 'none' for character charId looking at event ev. */
export function visibility(ev, charId) {
  if (ev.actor === charId) return 'full';
  if (TIME_EVENTS.includes(ev.type)) return 'full';
  if (!(ev.perceivers || []).includes(charId)) return 'none';
  const to = ev.payload?.to;
  if (ev.type === 'user_said' && to !== charId) return 'overheard';
  if (ev.type === 'char_said' && to !== charId) return 'overheard';
  return 'full';
}

/** The rewrite shown instead of overheard speech: no original words. */
export function overheardText(ev, scene) {
  const name = id => (id === 'user' ? '用户' : scene.characters.find(c => c.id === id)?.name || id);
  const to = ev.payload?.to;
  return ev.type === 'user_said'
    ? `用户和${name(to)}说了几句话（你没有细听）`
    : `${name(ev.actor)}和${name(to)}说了几句话（你没有细听）`;
}

/**
 * 2.0 C2: a world_edit add this character did not see happen, but whose object now stands in the character's area.
 * Seeing the thing is how the character learns about it, so it counts as perceived from then on.
 */
export function discovered(ev, charId, state, scene) {
  if (ev.type !== 'world_edit' || ev.payload?.op !== 'add') return false;
  const o = state.objects[ev.target], c = state.characters[charId];
  return Boolean(o && c && !o.holder && !o.worn_by && sameArea(scene, c.room, o.room));
}
