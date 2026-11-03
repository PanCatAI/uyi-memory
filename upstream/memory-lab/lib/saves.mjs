import { newId } from './ids.mjs';
import { tx } from './db.mjs';
import { WORLD_START, realNow } from './clock.mjs';
import { loadScene } from './scene.mjs';

const TABLES_BY_SAVE = ['director_log', 'playtest_notes', 'card_versions', 'scenario_runs', 'turns', 'forget_jobs', 'suppressions', 'retrievals', 'mentions', 'watermarks', 'caches', 'self_canon', 'commitments', 'rejected_facts', 'user_facts', 'event_flags', 'events', 'llm_calls'];

export function createSaves(db) {
  return {
    createSave({ name, sceneId = 'island', userName = '你', id: fixedId = null } = {}) {
      loadScene(sceneId);
      const id = fixedId || newId('s'); // a fixed id: tests and seeded simulations (3.0 F: the world's chance is keyed by it)
      db.prepare('INSERT INTO saves (id, name, scene_id, user_name, clock_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, String(name || '新存档').slice(0, 60), sceneId, String(userName || '你').slice(0, 20), WORLD_START, realNow());
      return this.getSave(id);
    },
    listSaves() { return db.prepare('SELECT * FROM saves ORDER BY created_at DESC').all().map(row); },
    getSave(id) { const r = db.prepare('SELECT * FROM saves WHERE id = ?').get(id); return r ? row(r) : null; },
    deleteSave(id) {
      // Delete children explicitly too: some tables (llm_calls, event_flags) have no foreign key to saves.
      tx(db, () => {
        for (const t of TABLES_BY_SAVE) db.prepare(`DELETE FROM ${t} WHERE save_id = ?`).run(id);
        db.prepare('DELETE FROM saves WHERE id = ?').run(id);
      });
    },
    bumpGeneration(id) { db.prepare('UPDATE saves SET generation = generation + 1 WHERE id = ?').run(id); return this.getSave(id).generation; },
    setSession(id, sessionId) { db.prepare('UPDATE saves SET session_id = ? WHERE id = ?').run(sessionId, id); },
    // 2.0 D9: one line about how the day felt, keyed by the world day it was written on.
    addPlaytestNote(id, text) {
      const t = String(text ?? '').trim().slice(0, 500);
      if (!t) return null;
      const day = new Date(this.getSave(id).clock_ms + 9 * 3600_000).toISOString().slice(0, 10);
      db.prepare('INSERT INTO playtest_notes (save_id, day, text, created_at) VALUES (?, ?, ?, ?)').run(id, day, t, realNow());
      return { day, text: t };
    },
    playtestNotes(id) { return db.prepare('SELECT day, text, created_at FROM playtest_notes WHERE save_id = ? ORDER BY created_at, rowid').all(id).map(row); }
  };
}
const row = r => ({ ...r });
export { TABLES_BY_SAVE };
