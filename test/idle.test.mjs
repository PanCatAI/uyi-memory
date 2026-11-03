// 2.0 D2: idle thoughts — she may speak up when the user is quiet, within urge, budget and spacing rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshLab } from './helpers/lab.mjs';
import { realNow } from '../lib/clock.mjs';
import { IDLE_BUDGET } from '../lib/memory/relationship.mjs';

const later = (s = 61) => realNow() + s * 1000; // past the real minute of quiet
const idleAnswer = (urge, say, ref = null) => ({ thought: '火有点小了', urge, say, ref, action: null });
const bench = { id: 'log-bench-3', name: '新的长凳', room: 'fireside', pos: [0, 0.22, 2.4], shape: 'box', size: [0.45, 0.44, 1.6], color: '#7b5a3c', tags: ['sittable'] };

async function quietCamp() {
  const t = await freshLab({ sceneId: 'camp' });
  t.lab.ledger.append(t.saveId, { type: 'world_edit', actor: 'user', target: bench.id, room: 'fireside', payload: { op: 'add', object: bench, by: 'creator', to: { room: 'fireside', pos: bench.pos } } });
  return t;
}
const idleTurns = (lab, saveId) => lab.db.prepare("SELECT * FROM turns WHERE save_id = ? AND mode = 'idle' ORDER BY rowid").all(saveId);
const spoken = (lab, saveId) => lab.ledger.list(saveId, { types: ['char_said'], all: true }).filter(e => e.payload.idle);

test('not before a real minute of quiet; then urge 0.4 stays quiet and 0.8 speaks, and the thought is kept either way', async () => {
  const { lab, saveId } = await quietCamp();
  assert.deepEqual(await lab.idle.run(saveId, 'lan'), { skipped: 'not_quiet' });
  lab.llm.mock.enqueue('idle', idleAnswer(0.4, '要不要添点柴？'));
  const low = await lab.idle.run(saveId, 'lan', { now: later() });
  assert.equal(low.spoke, false);
  assert.match(low.why, /劲不够/);
  assert.equal(spoken(lab, saveId).length, 0);
  const ref = `ev:${lab.ledger.list(saveId, { types: ['world_edit'] })[0].seq}`;
  lab.llm.mock.enqueue('idle', idleAnswer(0.8, '那边多了张长凳，你搭的？', ref));
  const high = await lab.idle.run(saveId, 'lan', { now: later() });
  assert.equal(high.spoke, true);
  const said = spoken(lab, saveId);
  assert.equal(said.length, 1);
  assert.deepEqual(said[0].payload.used, [ref]);
  assert.equal(said[0].payload.proactive, true);
  assert.ok(!JSON.stringify(said[0].payload).includes('火有点小了'), 'the thought is not in the ledger');
  assert.deepEqual(idleTurns(lab, saveId).map(r => r.thought), ['火有点小了', '火有点小了']);
  // Shown → mentioned (the receipt is the same as for replies).
  assert.equal(lab.db.prepare('SELECT count(*) n FROM mentions WHERE save_id = ?').get(saveId).n, 0);
  lab.proactive.recordDelivered(high.turnId);
  const m = lab.db.prepare('SELECT * FROM mentions WHERE save_id = ?').all(saveId);
  assert.equal(m.length, 1);
  assert.equal(m[0].memory_ref, ref);
  assert.equal(m[0].proactive, 1);
  // The side panel sees both: the one she said and the one she only thought.
  const panel = lab.idle.recentThoughts(saveId, 'lan');
  assert.deepEqual(panel.map(x => Boolean(x.said)), [true, false]);
});

test('the 5-minute spacing and the stage budget hold her back', async () => {
  const { lab, saveId } = await quietCamp();
  assert.equal(IDLE_BUDGET[lab.relationship.compute(saveId, 'lan').stage], 1, '初识: once per session');
  const ask = async say => { lab.llm.mock.enqueue('idle', idleAnswer(0.9, say)); return lab.idle.run(saveId, 'lan', { now: later() }); };
  assert.equal((await ask('风停了。')).spoke, true);
  // A new session has a new budget, but not within 5 world minutes of the last idle line.
  lab.session.end(saveId);
  await lab.session.start(saveId);
  const soon = await ask('你回来了。');
  assert.equal(soon.spoke, false);
  assert.match(soon.why, /不到 5 分钟/);
  lab.clock.advance(saveId, 10 * 60_000);
  assert.equal((await ask('你冷不冷？')).spoke, true);
  lab.clock.advance(saveId, 10 * 60_000);
  const over = await ask('火要灭了。');
  assert.equal(over.spoke, false);
  assert.match(over.why, /已经 1 次/);
});

test('no idle call without a session or past 20 calls an hour; tick runs it after a quiet minute', async () => {
  const { lab, saveId } = await quietCamp();
  const calls = () => lab.db.prepare("SELECT count(*) n FROM llm_calls WHERE purpose = 'idle'").get().n;
  for (let i = 0; i < 25; i++) await lab.idle.run(saveId, 'lan', { now: later() });
  assert.equal(calls(), 20, 'at most 20 an hour');
  assert.equal(lab.idle.blocked(saveId, 'lan', later()), 'hour_cap');
  lab.session.end(saveId);
  assert.equal(lab.idle.blocked(saveId, 'lan', later()), 'no_session');
  // Through the tick: life first, then the idle moment.
  const fresh = await quietCamp();
  const r = await fresh.lab.session.tick(fresh.saveId, { now: later() });
  assert.equal(r.idle.length, 1);
  assert.equal(r.idle[0].spoke, false, 'the mock default urge is 0.3');
  assert.equal((await fresh.lab.session.tick(fresh.saveId)).idle.length, 0, 'the user only just opened the session');
});
