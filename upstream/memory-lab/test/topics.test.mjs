import { test } from 'node:test';
import assert from 'node:assert/strict';
import { worldLab } from './helpers/world.mjs';

const reply = (say, used = []) => ({ say, action: null, used, self_claims: [] });
const topicOf = (lab, saveId) => lab.context.build({ mode: 'memory', saveId, charId: 'lan', input: '嗯', inputSeq: lab.ledger.lastSeq(saveId) }).sections.find(s => s.name === 'topic');

test('G1: wet wood at night with the fire out → the more specific topic wins', async () => {
  const { lab, saveId, goTo } = await worldLab({ id: 's_top1', features: { director: false } });
  lab.worldsim.setVar(saveId, 'wood_wet', true, '测试', lab.clock.now(saveId));
  assert.equal(lab.topics.pick(saveId, 'lan').id, 't_wet_wood', 'daytime: the plain one');
  lab.worldsim.forceWeather(saveId, '阴'); // a clear night would rather teach the stars (4 keys)
  goTo('2026-10-20T23:00:00');
  lab.worldsim.setVar(saveId, 'wood_wet', true, '测试', lab.clock.now(saveId)); // (it dried out on the way: 12 hours without rain)
  const tp = lab.topics.pick(saveId, 'lan');
  assert.equal(tp.id, 't_wet_wood_night');
  assert.ok(tp.candidates.includes('t_wet_wood'));
  assert.match(topicOf(lab, saveId).text, /^\[topic:t_wet_wood_night\] 你心里正惦记着：柴湿了火又灭了/);
});

test('G1: said (used) → cools down for its turns; not said → stays; once_per_session comes back next session', async () => {
  const { lab, saveId, say } = await worldLab({ id: 's_top2', features: { director: false } });
  lab.worldsim.setVar(saveId, 'wood_wet', true, '测试', lab.clock.now(saveId));
  lab.llm.mock.enqueue('reply', reply('火不好生。'));
  await say('怎么了');
  assert.equal(lab.topics.pick(saveId, 'lan').id, 't_wet_wood', 'not said: still there');
  lab.llm.mock.enqueue('reply', reply('柴湿透了，烦。', ['topic:t_wet_wood']));
  await say('柴呢');
  assert.equal(lab.topics.pick(saveId, 'lan'), null, 'said: cooling down');
  assert.match(lab.topics.resting(saveId, 'lan', lab.scene(saveId).topics.find(t => t.id === 't_wet_wood')), /冷却中/);
  for (let i = 0; i < 8; i++) { lab.llm.mock.enqueue('reply', reply('嗯。')); await say(`第${i}句`); }
  assert.equal(lab.topics.pick(saveId, 'lan').id, 't_wet_wood', 'back after 8 user turns');

  lab.worldsim.setVar(saveId, 'wood_wet', false, '测试', lab.clock.now(saveId));
  lab.worldsim.setVar(saveId, 'food', 1, '测试', lab.clock.now(saveId));
  assert.equal(lab.topics.pick(saveId, 'lan').id, 't_food_low');
  lab.llm.mock.enqueue('reply', reply('口粮就剩一天了。', ['topic:t_food_low']));
  await say('还有吃的吗');
  for (let i = 0; i < 9; i++) { lab.llm.mock.enqueue('reply', reply('嗯。')); await say(`又${i}`); }
  assert.equal(lab.topics.pick(saveId, 'lan'), null, 'once per session');
  lab.session.end(saveId);
  await lab.session.start(saveId);
  assert.equal(lab.topics.pick(saveId, 'lan')?.id, 't_food_low', 'a new session');
});

test('G1: an idle line can say the topic; untold incidents; without the feature there is no topic section', async () => {
  const { lab, saveId, say } = await worldLab({ id: 's_top3', features: { director: true } });
  lab.session.end(saveId);
  lab.director.force(saveId, 'ali_letter');
  await lab.session.start(saveId);
  assert.deepEqual(lab.topics.untold(saveId, 'lan'), ['ali_letter']);
  assert.equal(lab.topics.pick(saveId, 'lan').id, 't_letter');
  lab.llm.mock.enqueue('reply', reply('回来了。'));
  await say('我回来了');
  lab.llm.mock.enqueue('idle', { thought: '想', urge: 0.9, intent: '分享', say: '阿砾捎信了，要晚两天。', ref: 'topic:t_letter', action: null });
  const out = await lab.idle.run(saveId, 'lan', { now: Date.now() + 120_000 });
  assert.equal(out.spoke, true);
  assert.deepEqual(lab.topics.untold(saveId, 'lan'), [], 'told');
  lab.setFeatures(saveId, { topics: false });
  lab.worldsim.setVar(saveId, 'food', 1, '测试', lab.clock.now(saveId));
  assert.ok(!topicOf(lab, saveId));
});
