// Background work per character on the 'jobs' lane (PLAN §4.11). Never blocks a reply.
// Failures of the structured jobs (facts / observe / reflect) are kept in job_runs, so they survive a restart and
// can be retried explicitly; other errors (forget, catchup) are only shown until the app restarts.
import { realNow } from '../clock.mjs';
import { newId } from '../ids.mjs';

export const MAX_ATTEMPTS = 3;
const OPEN = ['failed', 'skipped', 'retrying'];

export function createJobs(lab) {
  const { db } = lab;
  const errors = new Map(); // saveId → [{ at, message }] (unstructured, in memory)
  const KINDS = {
    facts: (saveId, charId) => lab.facts.run(saveId, charId),
    observe: (saveId, charId) => lab.observe.run(saveId, charId),
    observe_force: (saveId, charId) => lab.observe.run(saveId, charId, { force: true })
  };
  const row = id => db.prepare('SELECT * FROM job_runs WHERE id = ?').get(id);
  const find = (saveId, charId, kind, from, to) => db.prepare('SELECT * FROM job_runs WHERE save_id = ? AND character_id = ? AND kind = ? AND from_seq = ? AND to_seq = ?').get(saveId, charId, kind, from, to);
  const log = message => { if (!process.env.LAB_QUIET) console.error(`[jobs] ${message}`); };

  const jobs = {
    /** kind: facts | observe | observe_force | any name with fn given. Returns the job's promise (errors are reported, not thrown). */
    enqueue(saveId, charId, kind, fn) {
      const work = fn || (() => KINDS[kind](saveId, charId));
      return lab.queues.queue(saveId, charId, 'jobs', async () => {
        try { return await work(); }
        catch (e) { if (!e.recorded) jobs.reportError(saveId, `${kind}：${e.message}`); return null; } // recorded = already in job_runs
      });
    },
    reportError(saveId, message) {
      if (!errors.has(saveId)) errors.set(saveId, []);
      const list = errors.get(saveId);
      list.push({ at: realNow(), message });
      if (list.length > 20) list.shift();
      log(message);
    },

    /** Records one failed attempt for a range. Returns the row (attempts counts every failure, across restarts). */
    fail(saveId, charId, kind, from, to, message) {
      const now = realNow(), gen = lab.saves.getSave(saveId).generation;
      const old = find(saveId, charId, kind, from, to);
      if (old) db.prepare("UPDATE job_runs SET attempts = attempts + 1, last_error = ?, status = CASE WHEN status = 'skipped' THEN 'skipped' ELSE 'failed' END, generation = ?, updated_at = ? WHERE id = ?").run(String(message).slice(0, 300), gen, now, old.id);
      else db.prepare("INSERT INTO job_runs (id, save_id, character_id, kind, from_seq, to_seq, status, attempts, last_error, generation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'failed', 1, ?, ?, ?, ?)")
        .run(newId('jr'), saveId, charId, kind, from, to, String(message).slice(0, 300), gen, now, now);
      log(`${kind} ${from}–${to}：${message}`);
      return find(saveId, charId, kind, from, to);
    },
    /** Sets the status of a recorded range (no row = nothing failed there = nothing to do). */
    mark(saveId, charId, kind, from, to, status) {
      db.prepare('UPDATE job_runs SET status = ?, updated_at = ? WHERE save_id = ? AND character_id = ? AND kind = ? AND from_seq = ? AND to_seq = ?').run(status, realNow(), saveId, charId, kind, from, to);
    },
    /** Open failures of a kind whose range ends at or before seq (a later success covered them). */
    recoverUpTo(saveId, charId, kind, seq) {
      db.prepare("UPDATE job_runs SET status = 'recovered', updated_at = ? WHERE save_id = ? AND character_id = ? AND kind = ? AND status IN ('failed', 'retrying') AND to_seq <= ?").run(realNow(), saveId, charId, kind, seq);
    },
    runs: (saveId, { open = false } = {}) => db.prepare(`SELECT * FROM job_runs WHERE save_id = ?${open ? ` AND status IN (${OPEN.map(() => '?').join(',')})` : ''} ORDER BY updated_at DESC, rowid DESC`).all(saveId, ...(open ? OPEN : [])),

    /**
     * Explicit retry of open failures (one by id, or all of a save). Runs on the character's jobs lane, re-checks that
     * the source still exists and is not forgotten, and is idempotent: a range that is already recovered is left alone.
     */
    async retry(saveId, { id } = {}) {
      const targets = id ? [row(id)].filter(r => r && r.save_id === saveId) : jobs.runs(saveId, { open: true });
      if (id && !targets.length) throw new Error('没有这个后台任务记录');
      const out = [];
      for (const r of targets) {
        out.push(await lab.queues.queue(saveId, r.character_id, 'jobs', async () => {
          const cur = row(r.id);
          if (!OPEN.includes(cur.status)) return cur;
          db.prepare("UPDATE job_runs SET status = 'retrying', updated_at = ? WHERE id = ?").run(realNow(), cur.id);
          try {
            if (cur.kind === 'facts') await lab.facts.retrySeq(saveId, cur.character_id, cur.from_seq);
            else if (cur.kind === 'observe') { await lab.observe.run(saveId, cur.character_id, { force: true }); jobs.mark(saveId, cur.character_id, 'observe', cur.from_seq, cur.to_seq, 'recovered'); }
            else if (cur.kind === 'diary' || cur.kind === 'week') { const d = String(cur.from_seq); const day = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`; await (cur.kind === 'diary' ? lab.diary.write(saveId, cur.character_id, day) : lab.diary.writeWeek(saveId, cur.character_id, day)); }
            else if (cur.kind === 'reflect') { await lab.observe.reflect(saveId, cur.character_id); jobs.mark(saveId, cur.character_id, 'reflect', cur.from_seq, cur.to_seq, 'recovered'); }
          } catch (e) { jobs.fail(saveId, cur.character_id, cur.kind, cur.from_seq, cur.to_seq, e.message); }
          // Still 'retrying' means nothing settled it: count it as failed, not as recovered.
          db.prepare("UPDATE job_runs SET status = 'failed' WHERE id = ? AND status = 'retrying'").run(cur.id);
          return row(cur.id);
        }));
      }
      return out;
    },

    /** Open structured failures (persisted) followed by unstructured in-memory ones. */
    errors: saveId => [
      ...jobs.runs(saveId, { open: true }).map(r => ({ at: r.updated_at, message: `${r.kind}（第 ${r.from_seq}${r.to_seq !== r.from_seq ? `–${r.to_seq}` : ''} 条）${r.status === 'skipped' ? '已跳过，可补跑' : '失败'}：${r.last_error || ''}`, id: r.id, kind: r.kind, status: r.status, attempts: r.attempts })),
      ...(errors.get(saveId) || [])
    ],
    idle: saveId => lab.queues.idle(saveId),
    pending: saveId => lab.queues.pending(saveId)
  };
  return jobs;
}
