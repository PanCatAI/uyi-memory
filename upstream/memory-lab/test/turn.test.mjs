import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshLab } from './helpers/lab.mjs';

test('a turn appends user_said and char_said; system prompt is stable', async () => {
  const { lab, saveId, say } = await freshLab();
  const r = await say('你好');
  const types = lab.ledger.list(saveId, { all: true }).map(e => e.type);
  assert.deepEqual(types, ['session_start', 'user_said', 'char_said']);
  const r2 = await say('今天天气不错');
  const sys = id => JSON.parse(lab.db.prepare('SELECT prompt_json FROM turns WHERE id = ?').get(id).prompt_json)[0].content;
  assert.equal(sys(r.turnId), sys(r2.turnId));
});

test('legal and illegal actions; the reply survives a refused action', async () => {
  const { lab, saveId, say } = await freshLab();
  lab.llm.mock.enqueue('reply', { say: '我拿着', action: { name: 'pick_up', target: 'red_cup' }, used: [], self_claims: [] });
  assert.equal((await say('拿起杯子')).reply.actionResult.ok, true);
  for (let i = 0; i < 2; i++) lab.llm.mock.enqueue('reply', { say: '好', action: { name: 'pick_up', target: 'shell' }, used: [], self_claims: [] }); // twice: a refused action gets one retry (D9), the model insists
  const r = await say('拿贝壳');
  assert.equal(r.reply.say, '好');
  assert.equal(r.reply.actionResult.ok, false);
  assert.equal(lab.ledger.list(saveId, { types: ['char_action'], all: true }).at(-1).outcome, 'failed');
});

test('compare adds two uncommitted turns and no ledger rows', async () => {
  const { lab, saveId, say } = await freshLab();
  const before = lab.ledger.lastSeq(saveId);
  const r = await say('你好', 'rin', true);
  assert.equal(lab.ledger.lastSeq(saveId), before + 2);
  assert.ok(r.compare.full.say && r.compare.none.say);
  assert.equal(lab.db.prepare('SELECT count(*) n FROM turns WHERE committed = 0 AND save_id = ?').get(saveId).n, 2);
});

test('banned phrases are retried, then stripped; used refs outside the context are dropped', async () => {
  const { lab, say } = await freshLab();
  lab.llm.mock.enqueue('reply', { say: '作为AI我不知道。', action: null, used: [], self_claims: [] });
  lab.llm.mock.enqueue('reply', { say: '根据我的记忆你喜欢猫。好久不见！', action: null, used: ['fact:nope'], self_claims: [] });
  const r = await say('你好');
  assert.equal(r.reply.say, '好久不见！');
  assert.deepEqual(r.reply.used, []);
});

test('self claims: conflicts with canon are kept aside', async () => {
  const { lab, saveId, say } = await freshLab();
  lab.llm.mock.enqueue('reply', { say: '我怕黑，也喜欢下雨', action: null, used: [], self_claims: ['我怕黑', '我喜欢下雨', '我喜欢下雨'] });
  await say('你怕什么');
  const rows = lab.selfCanon.list(saveId, 'rin').map(r => [r.text, r.status]);
  assert.deepEqual(rows, [['我怕黑', 'conflicts_canon'], ['我喜欢下雨', 'active']]);
});
