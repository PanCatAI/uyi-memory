import { test } from 'node:test';
import assert from 'node:assert/strict';
import { worldLab } from './helpers/world.mjs';

const fullContext = (lab, saveId) => { const c = lab.context.build({ mode: 'memory', saveId, charId: 'lan', input: '嗯', inputSeq: lab.ledger.lastSeq(saveId) }); return `${c.system}\n${c.user}`; };

test('G2: a scout booked while away happens at 09:00 next day, nobody perceives it, and her context does not have it', async () => {
  const { lab, saveId, goTo, evs } = await worldLab({ id: 's_sc1', features: { director: false } });
  assert.throws(() => lab.scout.book(saveId, '北坡脚'), /先结束会话/);
  goTo('2026-10-20T20:00:00');
  lab.session.end(saveId);
  lab.scout.book(saveId, '北坡脚');
  assert.equal(lab.ledger.world(saveId).vars.scout_plan.day, '2026-10-21');
  goTo('2026-10-21T08:00:00');
  assert.equal(evs('user_action', e => e.action === 'scout').length, 0);
  goTo('2026-10-21T10:00:00');
  const sc = evs('user_action', e => e.action === 'scout')[0];
  assert.equal(sc.payload.args.dir, '北坡脚');
  assert.deepEqual(sc.perceivers, []);
  assert.ok(sc.payload.args.finds.length >= 1);
  assert.ok(!sc.payload.args.finds.includes('north_old_fire'), 'the old fire needs 熟悉');
  await lab.session.start(saveId);
  const text = fullContext(lab, saveId);
  for (const f of lab.scout.latest(saveId).finds) assert.ok(!text.includes(f.text), `her context has no 「${f.text}」`);
  assert.match(text, /他出去探过路/);
  assert.equal(lab.topics.pick(saveId, 'lan')?.id, 't_scout_back');
});

test('G2: told clearly → she can draw it sure; not told → sure is refused, a question mark is fine; a clue drawn sure is a clue', async () => {
  const { lab, saveId, say, goTo } = await worldLab({ id: 's_sc2', features: { director: false } });
  goTo('2026-10-20T20:00:00');
  lab.session.end(saveId);
  lab.scout.go(saveId, '北坡脚', lab.clock.now(saveId), ['north_old_fire', 'north_snow_marker']);
  await lab.session.start(saveId);
  lab.llm.mock.enqueue('reply', { say: '雪线那儿？画个问号。', action: { name: 'mark_map', target: null, args: { note: '雪线石头', sure: true } }, used: [], self_claims: [] });
  lab.llm.mock.enqueue('reply', { say: '雪线那儿？画个问号。', action: { name: 'mark_map', target: null, args: { note: '雪线石头', sure: false } }, used: [], self_claims: [] });
  await say('我今天出去走了走。');
  let map = lab.ledger.world(saveId).vars.map;
  assert.deepEqual(map.map(m => [m.find, m.sure]), [['north_snow_marker', false]], 'sure refused, then drawn with a question mark');
  lab.llm.mock.enqueue('reply', { say: '五里，石圈，灰是干的。我画上。', action: { name: 'mark_map', target: null, args: { note: '旧火堆，五里', sure: true } }, used: [], self_claims: [] });
  await say('北坡脚下有个旧火堆，离营地大概五里，灰是干的。');
  map = lab.ledger.world(saveId).vars.map;
  assert.ok(map.some(m => m.find === 'north_old_fire' && m.sure));
  assert.equal(lab.ledger.world(saveId).vars.clues, 1);
  assert.equal(lab.topics.pick(saveId, 'lan')?.id, 't_map_clue');
  assert.match(lab.context.build({ mode: 'memory', saveId, charId: 'lan', input: '嗯', inputSeq: lab.ledger.lastSeq(saveId) }).sections.find(s => s.name === 'map').text, /北坡脚：旧火堆，五里（确定）/);
});

test('G2: the creek is up → the south valley cannot be booked', async () => {
  const { lab, saveId } = await worldLab({ id: 's_sc3' });
  lab.session.end(saveId);
  lab.director.force(saveId, 'creek_rise');
  assert.throws(() => lab.scout.book(saveId, '南边溪谷'), /溪水涨了/);
  assert.doesNotThrow(() => lab.scout.book(saveId, '东边林子'));
});

test('G2/G6: a draw_map right after he names what he scouted is her drawing it (mark_map); cover_wood goes to the wood crate whatever she named', async () => {
  const { lab, saveId, say, goTo, evs } = await worldLab({ id: 's_sc5', features: { director: false } });
  goTo('2026-10-20T20:00:00');
  lab.session.end(saveId);
  lab.scout.go(saveId, '北坡脚', lab.clock.now(saveId), ['north_old_fire', 'north_snow_marker']);
  await lab.session.start(saveId);
  lab.llm.mock.enqueue('reply', { say: '我画上。', action: { name: 'draw_map', target: null, args: {} }, used: [], self_claims: [] });
  await say('北坡脚下有个旧火堆，离营地大概五里，灰是干的。');
  assert.deepEqual(lab.ledger.world(saveId).vars.map.map(m => [m.find, m.sure]), [['north_old_fire', true]]);
  lab.llm.mock.enqueue('reply', { say: '画个问号。', action: { name: 'draw_map', target: null, args: {} }, used: [], self_claims: [] });
  await say('雪线那块石头我也看见了，大概在半山腰。');
  assert.deepEqual(lab.ledger.world(saveId).vars.map.map(m => [m.find, m.sure]).sort(), [['north_old_fire', true], ['north_snow_marker', false]]);
  lab.llm.mock.enqueue('reply', { say: '画会儿图。', action: { name: 'draw_map', target: null, args: {} }, used: [], self_claims: [] });
  await say('你在干嘛');
  assert.ok(evs('char_action', e => e.action === 'draw_map').length >= 1, 'nothing scouted named: a plain draw_map');

  lab.llm.mock.enqueue('reply', { say: '盖上了。', action: [{ name: 'walk_to', target: 'wood-crate-1', args: {} }, { name: 'cover_wood', target: 'supply', args: {} }], used: [], self_claims: [] });
  await say('把柴盖上吧');
  assert.equal(lab.ledger.world(saveId).vars.wood_covered, true);
});
