// R3 / P0-02: real host events reach the next prompt directly from the ledger (even when observe fails), tagged
// with outcome and whether the user was there; self-claims about world events need a matching successful event.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshLab } from './helpers/lab.mjs';
import { pj } from '../lib/db.mjs';

const line = (say, name, target, extra = {}) => ({ say, action: name ? { name, target, args: {} } : null, used: [], self_claims: [], ...extra });
const section = (lab, turnId, name) => pj(lab.db.prepare('SELECT sections_json FROM turns WHERE id = ?').get(turnId).sections_json).find(s => s.name === name);
const prompt = (lab, turnId) => pj(lab.db.prepare('SELECT prompt_json FROM turns WHERE id = ?').get(turnId).prompt_json).map(m => m.content).join('\n');

test('a failed climb with the user and an off-screen success are told apart, with observe broken', async () => {
  const { lab, saveId, say } = await freshLab();
  // Observe is broken for the whole test: every observe answer has the wrong shape.
  for (let i = 0; i < 20; i++) lab.llm.mock.enqueue('observe', { observations: 'broken' });
  lab.llm.mock.enqueue('reply', line('好呀。', 'walk_to', 'lighthouse'));
  await say('我们去灯塔吧');
  for (let i = 0; i < 2; i++) lab.llm.mock.enqueue('reply', line('我上去了！', 'climb', '旋转楼梯')); // twice: a refused action gets one retry (D9), the model insists
  await say('爬上楼梯看看');
  // Said twice: the first answer triggers the unbacked-claim retry (R9), the model insists, so it is delivered and
  // flagged — and the self-claim gate below is what keeps it out of active memory.
  for (let i = 0; i < 2; i++) lab.llm.mock.enqueue('reply', line('我上到一半就停下来了。我喜欢画画。', null, null, { self_claims: ['我爬上过灯塔顶', '我上到一半就停下来了', '我喜欢画画'] }));
  await say('刚才怎么样？');
  const sc = Object.fromEntries(lab.selfCanon.list(saveId, 'rin').map(r => [r.text, r.status]));
  assert.equal(sc['我爬上过灯塔顶'], 'no_event'); // nothing in the ledger backs it
  assert.equal(sc['我上到一半就停下来了'], 'no_event');
  assert.equal(sc['我喜欢画画'], 'active'); // free self-description still works

  lab.turns.act(saveId, { action: 'build', target: 'stairs', args: { room: 'lighthouse' } });
  lab.session.end(saveId);
  lab.session.advance(saveId, '1d');
  lab.llm.mock.enqueue('catchup', { actions: [{ name: 'climb', target: 'stairs', args: {}, why: '想试试新楼梯' }] });
  await lab.session.start(saveId);
  await lab.jobs.idle(saveId);
  assert.ok(lab.jobs.errors(saveId).some(e => /observe/.test(e.message)), 'observe really failed');
  assert.equal(lab.db.prepare("SELECT count(*) n FROM caches WHERE save_id = ? AND kind = 'observation'").get(saveId).n, 0);

  const r = await say('你还记得爬楼梯的事吗？');
  const world = section(lab, r.turnId, 'world');
  assert.ok(world, 'world section exists');
  const lines = world.text.split('\n');
  const failed = lines.find(l => /爬上/.test(l) && /没成功/.test(l));
  const offscreen = lines.find(l => /爬上/.test(l) && /（成功）/.test(l));
  assert.match(failed, /用户在场/);
  assert.match(offscreen, /用户不在，你自己做的/);
  const qiaoLine = lines.find(l => /阿乔/.test(l) && /用户不在/.test(l));
  if (qiaoLine) assert.doesNotMatch(qiaoLine, /你自己做的/);
  assert.ok(world.refs.every(ref => prompt(lab, r.turnId).includes(`[${ref}]`)));

  // Now the claim has a matching successful event.
  lab.llm.mock.enqueue('reply', line('嗯，我自己爬上去了。', null, null, { self_claims: ['我自己爬上了灯塔'] }));
  await say('后来呢？');
  assert.equal(lab.selfCanon.list(saveId, 'rin').find(x => x.text === '我自己爬上了灯塔').status, 'active');
  assert.ok(!section(lab, r.turnId, 'self')?.text.includes('我爬上过灯塔顶'));
});

test('another character does not see events it did not perceive; forgotten events leave the world section', async () => {
  const { lab, saveId, say } = await freshLab();
  lab.llm.mock.enqueue('reply', line('我拿着。', 'pick_up', 'red_cup'));
  await say('拿着这个杯子');
  const a = await say('拿好了吗');
  assert.match(section(lab, a.turnId, 'world').text, /玲拿起了红杯子（成功）｜用户在场/);
  const q = await say('你好', 'qiao');
  assert.doesNotMatch(section(lab, q.turnId, 'world')?.text || '', /红杯子/);

  const seq = lab.ledger.list(saveId, { types: ['char_action'], all: true }).at(-1).seq;
  lab.ledger.addFlag(saveId, seq, 'forgotten', 'job_test', lab.clock.now(saveId));
  const b = await say('刚才怎么了');
  assert.doesNotMatch(section(lab, b.turnId, 'world')?.text || '', /红杯子/);
});
