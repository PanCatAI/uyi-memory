// R5 / P0-04: background failures are persisted, a poison line no longer blocks later lines, and an explicit retry
// after a restart recovers it exactly once — without reviving forgotten content or overriding a newer correction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLab } from '../lib/lab.mjs';
import { freshLab } from './helpers/lab.mjs';

process.env.LAB_QUIET = '1';
const BAD = { facts: 'broken', commitments: [] }; // wrong shape → each callChecked uses two of these
const failFacts = (lab, n) => { for (let i = 0; i < 2 * n; i++) lab.llm.mock.enqueue('facts', BAD); };
const names = (lab, saveId) => lab.facts.all(saveId, 'rin').filter(f => f.predicate === 'name').map(f => [f.object, f.status]);

async function withFileLab(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'memory-lab-jobs-'));
  try { await fn(path.join(dir, 'lab.sqlite')); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('three failures skip the line, later lines work, restart keeps the record, retry recovers it once', () => withFileLab(async file => {
  const lab = createLab({ file });
  const saveId = lab.saves.createSave({ name: '恢复' }).id;
  await lab.session.start(saveId);
  failFacts(lab, 3);
  const poison = await lab.turns.runTurn({ saveId, charId: 'rin', text: '我叫小岚' });
  await lab.jobs.idle(saveId);
  await lab.facts.run(saveId, 'rin');
  await lab.facts.run(saveId, 'rin');
  const [row] = lab.jobs.runs(saveId);
  assert.equal(row.kind, 'facts');
  assert.equal(row.from_seq, poison.userEvent.seq);
  assert.equal(row.attempts, 3);
  assert.equal(row.status, 'skipped');
  // A later healthy line is processed normally.
  await lab.turns.runTurn({ saveId, charId: 'rin', text: '我喜欢海边' });
  await lab.jobs.idle(saveId);
  assert.ok(lab.facts.active(saveId, 'rin').some(f => f.predicate === 'likes'));
  assert.deepEqual(names(lab, saveId), []);
  lab.db.close();

  const again = createLab({ file }); // restart: in-memory state gone
  assert.equal(again.jobs.runs(saveId, { open: true }).length, 1);
  assert.ok(again.jobs.errors(saveId).some(e => /已跳过/.test(e.message)));
  const [done] = await again.jobs.retry(saveId);
  assert.equal(done.status, 'recovered');
  assert.deepEqual(names(again, saveId), [['小岚', 'active']]);
  await again.jobs.retry(saveId, { id: done.id }); // idempotent
  await again.jobs.retry(saveId);
  assert.deepEqual(names(again, saveId), [['小岚', 'active']]);
  assert.equal(again.jobs.runs(saveId, { open: true }).length, 0);
  again.db.close();
}));

test('retry does not revive a forgotten line', async () => {
  const { lab, saveId, say } = await freshLab();
  failFacts(lab, 3);
  const a = await say('我叫秘密名字');
  await lab.jobs.idle(saveId);
  await lab.facts.run(saveId, 'rin'); await lab.facts.run(saveId, 'rin');
  const job = await lab.forget.propose(saveId, 'rin', { verb: 'forget', refs: [`ev:${a.userEvent.seq}`] });
  await lab.forget.confirm(job.id); await lab.jobs.idle(saveId);
  const [r] = await lab.jobs.retry(saveId);
  assert.equal(r.status, 'cancelled');
  assert.deepEqual(names(lab, saveId), []);
});

test('retry of an old line does not override a newer correction', async () => {
  const { lab, saveId, say } = await freshLab();
  failFacts(lab, 3);
  await say('我叫小岚');
  await lab.jobs.idle(saveId);
  await lab.facts.run(saveId, 'rin'); await lab.facts.run(saveId, 'rin');
  await say('我叫小澜');
  await lab.jobs.idle(saveId);
  assert.deepEqual(names(lab, saveId), [['小澜', 'active']]);
  const [r] = await lab.jobs.retry(saveId);
  assert.equal(r.status, 'recovered_empty');
  assert.deepEqual(names(lab, saveId), [['小澜', 'active']]);
  assert.ok(lab.db.prepare("SELECT 1 FROM rejected_facts WHERE save_id = ? AND reason = 'newer_value'").get(saveId));
});

test('an observe failure is recorded and marked recovered by the next successful run', async () => {
  const { lab, saveId, say } = await freshLab();
  lab.llm.mock.enqueue('observe', { observations: 'broken' });
  lab.llm.mock.enqueue('observe', { observations: 'broken' });
  await say('今天去海边了');
  await assert.rejects(lab.observe.run(saveId, 'rin', { force: true }));
  assert.equal(lab.jobs.runs(saveId, { open: true }).filter(r => r.kind === 'observe').length, 1);
  await lab.jobs.retry(saveId);
  assert.equal(lab.jobs.runs(saveId, { open: true }).length, 0);
  assert.ok(lab.observe.live(saveId, 'rin', 'observation').some(c => c.text.includes('海边')));
  assert.equal(lab.observe.live(saveId, 'rin', 'observation').filter(c => c.text.includes('海边')).length, 1);
});
