// Promises between the user and a character (PLAN §4.11).
import { newId } from '../ids.mjs';
import { j } from '../db.mjs';
import { DAY } from '../clock.mjs';
import { commitRow } from './common.mjs';

export function createCommitments(lab) {
  const { db } = lab;
  return {
    add(saveId, charId, { owner, text, dueAt = null, sourceSeqs, at }) {
      const id = newId('k');
      db.prepare('INSERT INTO commitments (id, save_id, character_id, owner, text, due_at, status, source_seqs, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, saveId, charId, owner, text, dueAt, 'open', j(sourceSeqs), at);
      return id;
    },
    list(saveId, charId, status) {
      const rows = status
        ? db.prepare('SELECT * FROM commitments WHERE save_id = ? AND character_id = ? AND status = ? ORDER BY created_at').all(saveId, charId, status)
        : db.prepare('SELECT * FROM commitments WHERE save_id = ? AND character_id = ? ORDER BY created_at').all(saveId, charId);
      return rows.map(commitRow);
    },
    /** refs like 'commit:k_1'; only open ones of this character become done. Returns ids marked. */
    markDone(saveId, charId, refs, seq) {
      const now = lab.clock.now(saveId);
      const done = [];
      for (const ref of refs || []) {
        const id = String(ref).replace(/^commit:/, '');
        const r = db.prepare("UPDATE commitments SET status = 'done', closed_at = ?, closed_seq = ? WHERE id = ? AND save_id = ? AND character_id = ? AND status = 'open'").run(now, seq, id, saveId, charId);
        if (r.changes) done.push(id);
      }
      return done;
    },
    /** Open commitments 3 days past due become dropped. */
    expire(saveId) {
      const now = lab.clock.now(saveId);
      db.prepare("UPDATE commitments SET status = 'dropped', closed_at = ? WHERE save_id = ? AND status = 'open' AND due_at IS NOT NULL AND due_at + ? <= ?").run(now, saveId, 3 * DAY, now);
    }
  };
}
