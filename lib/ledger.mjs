// The world ledger (AGENTS.md hard rules 1 and 2). append() is the only way rows get into `events`.
import { validateEvent } from '../contracts/events.mjs';
import { tx, j, pj } from './db.mjs';
import { loadScene, characterIds } from './scene.mjs';
import { applyEvent, foldWorld, roomOf } from './world.mjs';
import { perceiversFor, presenceFor } from './perception.mjs';

export function rowToEvent(r) {
  if (!r) return null;
  return {
    seq: r.seq, t: r.t, session_id: r.session_id, room: r.room, type: r.type, actor: r.actor,
    action: r.action, target: r.target, outcome: r.outcome,
    perceivers: pj(r.perceivers, []), user_presence: r.user_presence, offscreen: r.offscreen,
    payload: pj(r.payload_json, null), tombstone: pj(r.tombstone_json, null)
  };
}

/** Room an event happens in (PLAN §3). */
function defaultRoom(state, ev) {
  const p = ev.payload || {};
  if (ev.type === 'user_said') return state.characters[p.to]?.room ?? state.userRoom;
  if (state.characters[ev.actor]) return state.characters[ev.actor].room;
  if (ev.type === 'user_action') return p.args?.room ?? roomOf(state, ev.target) ?? state.userRoom;
  if (ev.type === 'object_created') return p.object?.room ?? null;
  if (ev.target) return roomOf(state, ev.target);
  return null;
}

export function createLedger({ db, clock, sceneOf = saveId => loadScene(db.prepare('SELECT scene_id FROM saves WHERE id = ?').get(saveId).scene_id) }) {
  const worlds = new Map(); // saveId → { seq, state }
  const listeners = new Set();
  const lastRow = db.prepare('SELECT seq, t FROM events WHERE save_id = ? ORDER BY seq DESC LIMIT 1');
  const insert = db.prepare(`INSERT INTO events (save_id, seq, t, session_id, room, type, actor, action, target, outcome, perceivers, user_presence, offscreen, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  function world(saveId) {
    const last = lastRow.get(saveId)?.seq ?? 0;
    let w = worlds.get(saveId);
    if (!w || w.seq !== last) {
      const scene = sceneOf(saveId);
      w = { seq: last, state: foldWorld(scene, ledger.list(saveId, { all: true })) };
      worlds.set(saveId, w);
    }
    return w.state;
  }

  function appendOne(saveId, input) {
    const scene = sceneOf(saveId);
    const save = db.prepare('SELECT session_id FROM saves WHERE id = ?').get(saveId);
    if (!save) throw new Error(`没有这个存档：${saveId}`);
    const errors = validateEvent(input, characterIds(scene));
    if (errors.length) throw new Error(`事件不合法：${errors.join('；')}`);
    const state = world(saveId);
    const last = lastRow.get(saveId);
    const t = input.t ?? clock.now(saveId);
    if (last && t < last.t) throw new Error('事件时间不能早于上一条事件');
    const offscreen = input.offscreen ? 1 : 0;
    const room = input.room !== undefined ? input.room : defaultRoom(state, input);
    const ev = {
      seq: (last?.seq ?? 0) + 1, t,
      session_id: offscreen ? null : (input.session_id !== undefined ? input.session_id : save.session_id),
      room, type: input.type, actor: input.actor,
      action: input.action ?? null, target: input.target ?? null, outcome: input.outcome ?? null,
      perceivers: input.perceivers ?? (room ? perceiversFor(state, room, scene) : []),
      user_presence: offscreen ? 'absent' : (input.user_presence ?? presenceFor(state, room, scene)),
      offscreen, payload: input.payload ?? {}, tombstone: null
    };
    insert.run(saveId, ev.seq, ev.t, ev.session_id, ev.room, ev.type, ev.actor, ev.action, ev.target, ev.outcome, j(ev.perceivers), ev.user_presence, ev.offscreen, j(ev.payload));
    applyEvent(state, scene, ev);
    worlds.get(saveId).seq = ev.seq;
    return ev;
  }

  const ledger = {
    /** Validates, assigns seq/t/room/perceivers/user_presence, writes, and updates the cached world state. */
    append(saveId, input) { return ledger.appendMany(saveId, [input])[0]; },
    appendMany(saveId, inputs) {
      let out;
      try { out = tx(db, () => inputs.map(ev => appendOne(saveId, ev))); }
      catch (e) { worlds.delete(saveId); throw e; } // rolled back: rebuild the cached state from the table next time
      for (const ev of out) for (const fn of listeners) fn(saveId, ev);
      return out;
    },
    /** { after, before, types, target, actor, limit, desc, all } */
    list(saveId, { after = 0, before, types, target, actor, limit = 500, desc = false, all = false } = {}) {
      const where = ['save_id = ?', 'seq > ?'], args = [saveId, after];
      if (before != null) { where.push('seq < ?'); args.push(before); }
      if (types?.length) { where.push(`type IN (${types.map(() => '?').join(',')})`); args.push(...types); }
      if (target) { where.push('target = ?'); args.push(target); }
      if (actor) { where.push('actor = ?'); args.push(actor); }
      const sql = `SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY seq ${desc ? 'DESC' : 'ASC'}${all ? '' : ` LIMIT ${Number(limit) | 0}`}`;
      return db.prepare(sql).all(...args).map(rowToEvent);
    },
    get(saveId, seq) { return rowToEvent(db.prepare('SELECT * FROM events WHERE save_id = ? AND seq = ?').get(saveId, seq)); },
    lastSeq(saveId) { return lastRow.get(saveId)?.seq ?? 0; },
    flags(saveId, seq) { return db.prepare('SELECT flag FROM event_flags WHERE save_id = ? AND seq = ?').all(saveId, seq).map(r => r.flag); },
    flagMap(saveId) {
      const m = new Map();
      for (const r of db.prepare('SELECT seq, flag FROM event_flags WHERE save_id = ?').all(saveId)) { if (!m.has(r.seq)) m.set(r.seq, new Set()); m.get(r.seq).add(r.flag); }
      return m;
    },
    addFlag(saveId, seq, flag, jobId, at) {
      db.prepare('INSERT OR IGNORE INTO event_flags (save_id, seq, flag, job_id, at) VALUES (?, ?, ?, ?, ?)').run(saveId, seq, flag, jobId, at);
    },
    /** The only UPDATE on events: drop the payload, keep a tombstone. */
    tombstone(saveId, seq, info) {
      db.prepare('UPDATE events SET payload_json = NULL, tombstone_json = ? WHERE save_id = ? AND seq = ?').run(j(info), saveId, seq);
    },
    world,
    forget(saveId) { worlds.delete(saveId); },
    onAppend(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  };
  return ledger;
}
