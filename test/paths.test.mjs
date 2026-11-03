// R9 / P1-02: proactive cooldown follows content, not ids; transient actions are not told as lasting changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshLab } from './helpers/lab.mjs';
import { pj } from '../lib/db.mjs';

test('a fact and an observation of the same sentence share one cooldown', async () => {
  const { lab, saveId, say } = await freshLab();
  await say('这个红杯子是我奶奶留下的');
  await lab.jobs.idle(saveId);
  await lab.observe.run(saveId, 'rin', { force: true });
  const fact = lab.facts.active(saveId, 'rin').find(f => f.predicate === 'relation_to_object');
  const obs = lab.observe.live(saveId, 'rin', 'observation').find(c => c.derived_from.includes(fact.source_seqs[0]));
  assert.ok(fact && obs);
  assert.equal(lab.admission.check(saveId, 'rin', `cache:${obs.id}`, 'hint').ok, true);
  // She actually says the fact (delivery receipt).
  lab.llm.mock.enqueue('reply', { say: '那个杯子我收好了。', action: null, used: [`fact:${fact.id}`], self_claims: [] });
  const r = await say('嗯');
  lab.proactive.recordDelivered(r.turnId);
  assert.deepEqual(lab.admission.check(saveId, 'rin', `cache:${obs.id}`, 'hint'), { ok: false, reason: 'mentioned_recently_same_content' });
  assert.equal(lab.admission.check(saveId, 'rin', `cache:${obs.id}`, 'context').ok, true); // still known, just not pushed
});

test('clean / look_at are shown as momentary in the world section; sitting shows where', async () => {
  const { lab, say } = await freshLab();
  lab.llm.mock.enqueue('reply', { say: '我擦一擦。', action: { name: 'clean', target: 'red_cup', args: {} }, used: [], self_claims: [] });
  await say('杯子有点脏');
  lab.llm.mock.enqueue('reply', { say: '我坐会儿。', action: { name: 'sit', target: 'chair', args: {} }, used: [], self_claims: [] });
  await say('坐下歇歇');
  const r = await say('现在呢');
  const t = lab.db.prepare('SELECT sections_json FROM turns WHERE id = ?').get(r.turnId);
  const sections = pj(t.sections_json);
  const world = sections.find(s => s.name === 'world').text;
  assert.match(world, /玲擦了红杯子（一时的动作，没有留下变化）/);
  assert.match(world, /玲坐到了椅子（成功）/);
  assert.match(sections.find(s => s.name === 'now').text, /坐在椅子上/);
});

test('别再提 drops the pronoun so third-person memories match the topic', async () => {
  const { detect } = await import('../lib/memory/forget.mjs');
  assert.deepEqual(detect('以后别再提我奶奶的事了'), { verb: 'suppress', topic: '奶奶' });
  assert.deepEqual(detect('别再提那个红杯子了'), { verb: 'suppress', topic: '红杯子' });
});

test('back at a place, the hint is what happened there (stairs, climb), not a chat line; glances are skipped', async () => {
  const { lab, saveId, say } = await freshLab();
  const go = (s, name, target) => { lab.llm.mock.enqueue('reply', { say: s, action: { name, target, args: {} }, used: [], self_claims: [] }); };
  go('走吧。', 'walk_to', 'lighthouse'); await say('去灯塔吧');
  lab.turns.act(saveId, { action: 'build', target: 'stairs', args: { room: 'lighthouse' } });
  go('我上来了。', 'climb', 'stairs'); await say('灯呢？点亮它吧');
  lab.session.end(saveId); lab.session.advance(saveId, '3d');
  lab.llm.mock.enqueue('catchup', { actions: [{ name: 'look_at', target: 'lamp', args: {}, why: '看看' }] });
  await lab.session.start(saveId);
  const first = lab.proactive.hints({ saveId, charId: 'rin', turnIndex: 1, inputSeq: lab.ledger.lastSeq(saveId) });
  assert.ok(!first.some(h => h.rule === 'session_open' && /看了看/.test(lab.admission.lookup(saveId, h.ref)?.text || '')), 'a glance is not a hint');
  const r = await say('今天风好大');
  const h = JSON.parse(lab.db.prepare('SELECT sections_json FROM turns WHERE id = ?').get(r.turnId).sections_json).find(s => s.name === 'hints');
  const ev = lab.admission.lookup(saveId, h.refs[0]);
  assert.ok(ev, 'there is a hint');
  assert.doesNotMatch(ev.text, /灯呢/); // not the chat line
  assert.match(ev.text, /楼梯|爬上/);
});
