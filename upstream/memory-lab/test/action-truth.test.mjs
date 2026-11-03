// R2 / P0-01: the prompt names targets by id, the host maps unique names deterministically and refuses ambiguous
// ones, and a failed action never delivers the model's success line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshLab } from './helpers/lab.mjs';
import { resolveTarget, perceivable } from '../lib/arbiter.mjs';
import { pj } from '../lib/db.mjs';

const line = (say, name, target, extra = {}) => ({ say, action: name ? { name, target, args: {} } : null, used: [], self_claims: [], ...extra });
const lastSaid = (lab, saveId) => lab.ledger.list(saveId, { types: ['char_said'], all: true }).at(-1);
const turnRow = (lab, id) => { const t = lab.db.prepare('SELECT * FROM turns WHERE id = ?').get(id); return { output: pj(t.output_json), rejected: pj(t.rejected_json), sections: pj(t.sections_json) }; };

test('a unique name is mapped to its id and the action really happens (wear 新围巾)', async () => {
  const { lab, saveId, say } = await freshLab();
  lab.turns.act(saveId, { action: 'give', target: 'new_scarf', args: { to: 'rin' } });
  lab.llm.mock.enqueue('reply', line('我戴上了，好暖和。', 'wear', '新围巾'));
  const r = await say('把围巾戴上吧');
  assert.equal(r.reply.actionResult.ok, true);
  assert.equal(r.reply.action.target, 'new_scarf');
  assert.equal(r.reply.delivered, '我戴上了，好暖和。');
  assert.deepEqual(lab.ledger.world(saveId).characters.rin.wearing, ['new_scarf']);
  assert.deepEqual(turnRow(lab, r.turnId).rejected.mapped, { from: '新围巾', to: 'new_scarf' });
});

test('climbing stairs that do not exist: no success line, host line delivered and recorded', async () => {
  const { lab, saveId, say } = await freshLab();
  lab.llm.mock.enqueue('reply', line('我上去了！上面风好大。', 'walk_to', 'lighthouse'));
  await say('我们去灯塔吧');
  for (let i = 0; i < 2; i++) lab.llm.mock.enqueue('reply', line('我上去了！上面风好大。', 'climb', '旋转楼梯', { self_claims: ['我爬上过灯塔'] })); // twice: a refused action gets one retry (D9), the model insists
  const r = await say('你爬上楼梯看看');
  assert.equal(r.reply.actionResult.ok, false);
  assert.equal(lab.ledger.world(saveId).characters.rin.elevated, false);
  const said = lastSaid(lab, saveId);
  assert.doesNotMatch(said.payload.text, /上去了/);
  assert.match(said.payload.text, /^我想爬上.*没成功/);
  assert.equal(said.payload.host_line, true);
  assert.equal(r.reply.delivered, said.payload.text);
  const t = turnRow(lab, r.turnId);
  assert.equal(t.output.delivered, said.payload.text);
  assert.equal(t.rejected.withheld.say, '我上去了！上面风好大。');
  assert.equal(lab.selfCanon.list(saveId, 'rin').length, 0); // claims in a withheld line are not learned
  const failed = lab.ledger.list(saveId, { types: ['char_action'], all: true }).at(-1);
  assert.equal(failed.outcome, 'failed');
});

test('object not here, object moved away, wrong thing in hand: all refused with the reason, nothing changes', async () => {
  const { lab, saveId, say } = await freshLab();
  for (let i = 0; i < 2; i++) lab.llm.mock.enqueue('reply', line('拿到贝壳啦。', 'pick_up', 'shell')); // twice: a refused action gets one retry (D9), the model insists
  const a = await say('把贝壳拿来');
  assert.match(a.reply.delivered, /没成功：贝壳不在这里/);

  lab.turns.act(saveId, { action: 'move_object', target: 'red_cup', args: { room: 'beach' } });
  for (let i = 0; i < 2; i++) lab.llm.mock.enqueue('reply', line('杯子我收好了。', 'pick_up', '红杯子')); // twice: a refused action gets one retry (D9), the model insists
  const b = await say('把红杯子收好');
  assert.match(b.reply.delivered, /没成功：红杯子不在这里/);
  assert.equal(lab.ledger.world(saveId).characters.rin.holding, null);

  lab.turns.act(saveId, { action: 'give', target: 'new_scarf', args: { to: 'rin' } });
  for (let i = 0; i < 2; i++) lab.llm.mock.enqueue('reply', line('戴好了。', 'wear', 'red_cup')); // twice: a refused action gets one retry (D9), the model insists
  const c = await say('戴上吧');
  assert.match(c.reply.delivered, /没成功：手里没有红杯子/);
  assert.deepEqual(lab.ledger.world(saveId).characters.rin.wearing, []);
});

test('an ambiguous name is refused, never guessed', async () => {
  const { lab, saveId, scene } = await freshLab();
  const st = lab.ledger.world(saveId);
  st.objects.red_cup_2 = { ...st.objects.red_cup, id: 'red_cup_2' };
  assert.deepEqual(resolveTarget(st, scene, { name: 'pick_up', target: '红杯子' }).ambiguous.sort(), ['red_cup', 'red_cup_2']);
  assert.ok(resolveTarget(st, scene, { name: 'switch', target: '灯' }).ambiguous.length > 1);
  assert.deepEqual(resolveTarget(st, scene, { name: 'walk_to', target: '灯塔' }), { target: 'lighthouse', mapped: { from: '灯塔', to: 'lighthouse' } });
  assert.deepEqual(resolveTarget(st, scene, { name: 'pick_up', target: 'red_cup' }), { target: 'red_cup' });
  assert.deepEqual(resolveTarget(st, scene, { name: 'pick_up', target: '不存在的东西' }), { target: '不存在的东西' });
});

test('an ambiguous name in a real turn delivers the host line', async () => {
  const { lab, saveId, say } = await freshLab();
  for (let i = 0; i < 2; i++) lab.llm.mock.enqueue('reply', line('我去那边。', 'walk_to', '灯')); // twice: a refused action gets one retry (D9), the model insists
  const r = await say('去那边');
  assert.equal(r.reply.actionResult.ok, false);
  assert.match(r.reply.delivered, /不止一个/);
  assert.equal(lab.ledger.world(saveId).characters.rin.room, 'cabin');
});

test('a failed cosmetic action (look_at) keeps the line', async () => {
  const { lab, say } = await freshLab();
  lab.llm.mock.enqueue('reply', line('这里没有楼梯呀。', 'look_at', 'room'));
  const r = await say('你爬上楼梯看看');
  assert.equal(r.reply.actionResult.ok, false);
  assert.equal(r.reply.delivered, '这里没有楼梯呀。');
  assert.equal(r.reply.withheld, null);
});

test('the reply prompt lists perceivable entities as id｜名称｜位置｜可用动作, legal actions only', async () => {
  const { lab, saveId, say } = await freshLab();
  const r = await say('你好');
  const now = turnRow(lab, r.turnId).sections.find(s => s.name === 'now').text;
  assert.match(now, /red_cup｜红杯子｜小屋｜[^\n]*pick_up/);
  assert.match(now, /lighthouse｜灯塔｜房间｜walk_to/);
  assert.match(now, /user｜用户｜在你旁边/);
  const st = lab.ledger.world(saveId);
  st.characters.rin.room = 'lighthouse'; st.userRoom = 'lighthouse';
  const lamp = perceivable(st, lab.scene(saveId), 'rin').rows.find(x => x.id === 'lamp');
  assert.ok(lamp && !lamp.actions.includes('switch')); // too high until she has climbed
  st.characters.rin.elevated = true;
  assert.ok(perceivable(st, lab.scene(saveId), 'rin').rows.find(x => x.id === 'lamp').actions.includes('switch'));
});

test('compare-mode actions are recorded but never executed', async () => {
  const { lab, saveId, say } = await freshLab();
  for (let i = 0; i < 3; i++) lab.llm.mock.enqueue('reply', line(`去灯塔${i}`, 'walk_to', 'lighthouse'));
  const r = await say('去灯塔吧', 'rin', true);
  assert.equal(lab.ledger.list(saveId, { types: ['char_moved'], all: true }).length, 1);
  assert.equal(lab.ledger.list(saveId, { types: ['char_action'], all: true }).length, 1);
  assert.equal(r.compare.full.executed, false);
  assert.equal(r.compare.full.action.name, 'walk_to');
});

test('a line that claims an action without doing it is retried once with a host note', async () => {
  const { lab, saveId, say } = await freshLab();
  lab.turns.act(saveId, { action: 'give', target: 'new_scarf', args: { to: 'rin' } });
  lab.llm.mock.enqueue('reply', line('嗯……我把围巾戴上了。很暖和。', null, null)); // claims, no action
  lab.llm.mock.enqueue('reply', line('嗯，我戴上。', 'wear', 'new_scarf'));
  const r = await say('今天好冷啊');
  assert.equal(r.reply.delivered, '嗯，我戴上。');
  assert.deepEqual(lab.ledger.world(saveId).characters.rin.wearing, ['new_scarf']);
  const t = lab.db.prepare('SELECT rejected_json, prompt_json FROM turns WHERE id = ?').get(r.turnId);
  assert.deepEqual(JSON.parse(t.rejected_json).unbacked.claims, ['wear']);
  // Describing what is already true is fine: no retry.
  lab.llm.mock.enqueue('reply', line('围巾我戴上了，你看。', null, null));
  const before = lab.db.prepare("SELECT count(*) n FROM llm_calls WHERE purpose = 'reply'").get().n;
  await say('好看');
  assert.equal(lab.db.prepare("SELECT count(*) n FROM llm_calls WHERE purpose = 'reply'").get().n, before + 1);
});

test('up to 3 actions run in order: walk to the wardrobe, then put the cup on it', async () => {
  const { lab, saveId, say } = await freshLab();
  lab.llm.mock.enqueue('reply', line('我拿着。', 'pick_up', 'red_cup'));
  await say('收好这个杯子');
  lab.turns.act(saveId, { action: 'move_character', target: 'rin', args: { room: 'cabin' } });
  lab.llm.mock.enqueue('reply', { say: '放在衣柜上了。', action: [{ name: 'walk_to', target: 'wardrobe', args: {} }, { name: 'put_down', target: '衣柜', args: {} }], used: [], self_claims: [] });
  const r = await say('放衣柜上吧');
  assert.equal(r.reply.actionResult.ok, true);
  assert.equal(r.reply.actionResult.steps.length, 2);
  assert.deepEqual(r.reply.action.map(a => a.target), ['wardrobe', 'wardrobe']);
  assert.equal(lab.ledger.world(saveId).objects.red_cup.holder, null);
  assert.equal(r.reply.delivered, '放在衣柜上了。');
});

test('a failing step stops the sequence; what happened before it stands and is said', async () => {
  const { lab, saveId, say } = await freshLab();
  for (let i = 0; i < 2; i++) lab.llm.mock.enqueue('reply', { say: '我上来了，灯也亮了！', action: [{ name: 'walk_to', target: 'lighthouse', args: {} }, { name: 'climb', target: 'stairs', args: {} }, { name: 'switch', target: 'lamp', args: {} }], used: [], self_claims: [] }); // twice: a refused action gets one retry (D9), the model insists
  const r = await say('去灯塔爬上去开灯');
  assert.equal(r.reply.actionResult.ok, false);
  assert.equal(lab.ledger.world(saveId).characters.rin.room, 'lighthouse');
  assert.equal(lab.ledger.world(saveId).objects.lamp.state.on, false);
  assert.match(r.reply.delivered, /^我走到灯塔了；我想爬上.*没成功/);
  assert.equal(lab.ledger.list(saveId, { types: ['char_action'], all: true }).filter(e => e.action === 'switch').length, 0);
});

test('"放在衣柜上" while still holding the cup and doing nothing is an unbacked claim; "会放在" is not', async () => {
  const { unbackedClaims } = await import('../lib/arbiter.mjs');
  const { lab, saveId } = await freshLab();
  const st = structuredClone(lab.ledger.world(saveId));
  st.characters.rin.holding = 'red_cup';
  assert.deepEqual(unbackedClaims(st, 'rin', '在衣柜上呀，放在衣柜上了。', null), ['put_down']);
  assert.deepEqual(unbackedClaims(st, 'rin', '好，我会放在衣柜上。', null), []);
  assert.deepEqual(unbackedClaims(st, 'rin', '放在衣柜上吧？', null), []);
  assert.deepEqual(unbackedClaims(st, 'rin', '放好了。', [{ name: 'walk_to', target: 'wardrobe' }, { name: 'put_down', target: 'wardrobe' }]), []);
});

test('asking for what is already true is not a failure; where a thing rests is told and shown', async () => {
  const { lab, saveId, say } = await freshLab();
  lab.llm.mock.enqueue('reply', { say: '放好了。', action: [{ name: 'pick_up', target: 'red_cup', args: {} }, { name: 'put_down', target: 'wardrobe', args: {} }], used: [], self_claims: [] });
  await say('把杯子放衣柜上');
  assert.equal(lab.ledger.world(saveId).objects.red_cup.on, 'wardrobe');
  lab.llm.mock.enqueue('reply', { say: '已经在衣柜上啦。', action: [{ name: 'walk_to', target: 'wardrobe', args: {} }, { name: 'put_down', target: 'wardrobe', args: {} }], used: [], self_claims: [] });
  const r = await say('放衣柜上吧');
  assert.equal(r.reply.actionResult.ok, true);
  assert.equal(r.reply.delivered, '已经在衣柜上啦。');
  assert.equal(r.reply.actionResult.steps[1].noop, '已经放在那里了');
  assert.equal(lab.ledger.list(saveId, { types: ['char_action'], all: true }).filter(e => e.outcome === 'failed').length, 0);
  const next = await say('好');
  const sections = JSON.parse(lab.db.prepare('SELECT sections_json FROM turns WHERE id = ?').get(next.turnId).sections_json);
  assert.match(sections.find(s => s.name === 'world').text, /玲把红杯子放到了衣柜上（成功）/);
  assert.match(sections.find(s => s.name === 'now').text, /red_cup｜红杯子｜小屋，放在衣柜上/);
  lab.llm.mock.enqueue('reply', line('我拿起来看看。', 'pick_up', 'red_cup'));
  await say('拿起来看看');
  assert.equal(lab.ledger.world(saveId).objects.red_cup.on, null);
});

test('found live: "我一直戴着呢" without wearing, and "爬到一半" without climbing, are unbacked; "带着"/"没戴着" are not', async () => {
  const { unbackedClaims } = await import('../lib/arbiter.mjs');
  const { lab, saveId } = await freshLab();
  const st = structuredClone(lab.ledger.world(saveId));
  st.characters.rin.holding = 'new_scarf';
  assert.deepEqual(unbackedClaims(st, 'rin', '围巾，我一直戴着呢，很暖和。', null), ['wear']);
  assert.deepEqual(unbackedClaims(st, 'rin', '围巾我一直带着呢。', null), []);
  assert.deepEqual(unbackedClaims(st, 'rin', '我还没戴着呢。', null), []);
  assert.deepEqual(unbackedClaims(st, 'rin', '墙太滑，我连一半都没爬到。', null), []);
  assert.deepEqual(unbackedClaims(st, 'rin', '我爬到一半就停下来了。', null), ['climb']);
  st.characters.rin.wearing = ['new_scarf'];
  assert.deepEqual(unbackedClaims(st, 'rin', '我一直戴着呢。', null), []); // true: no retry
});

test('found live: a wrong-kind target is refused in plain words, never with a raw id', async () => {
  const { checkAction } = await import('../lib/arbiter.mjs');
  const { lab, saveId, scene } = await freshLab();
  const st = lab.ledger.world(saveId);
  assert.equal(checkAction(st, scene, 'rin', { name: 'climb', target: 'lighthouse' }).reason, '灯塔不能这样（爬上楼梯）');
  assert.equal(checkAction(st, scene, 'rin', { name: 'climb', target: '旋转楼梯' }).reason, '这里没有「旋转楼梯」');
  assert.equal(checkAction(st, scene, 'rin', { name: 'pick_up' }).reason, '不知道要对什么做');
});

test('a refused action gets one retry with the reason; a legal second choice is done and her line delivered (D9)', async () => {
  const { lab, saveId, say } = await freshLab();
  lab.llm.mock.enqueue('reply', line('拿到贝壳啦。', 'pick_up', 'shell'));
  lab.llm.mock.enqueue('reply', line('贝壳不在这儿，我拿杯子吧。', 'pick_up', 'red_cup'));
  const r = await say('拿点东西');
  assert.equal(r.reply.actionResult.ok, true);
  assert.equal(r.reply.delivered, '贝壳不在这儿，我拿杯子吧。');
  assert.equal(lab.ledger.world(saveId).characters.rin.holding, 'red_cup');
  const t = turnRow(lab, r.turnId);
  assert.equal(t.rejected.retried_action.first.target, 'shell');
  assert.match(t.rejected.retried_action.reason, /不在这里/);
  assert.equal(t.rejected.withheld, undefined);
  // The note to the model carries the reason; the definition in （） never reaches her line.
  const { failureLine } = await import('../lib/arbiter.mjs');
  assert.doesNotMatch(failureLine(lab.ledger.world(saveId), lab.scene(saveId), { name: 'put_down', target: 'beach' }, '海滩不能这样（把手里的东西放到台面上）'), /（/);
  // Nested brackets in the definition (draw_map's 「（比如杯子当墨碗）」) leave nothing behind either.
  assert.doesNotMatch(failureLine(lab.ledger.world(saveId), lab.scene(saveId), { name: 'walk_to', target: 'beach' }, '长凳不能这样（坐着画地图；可以用 args.with 指一件东西（比如杯子当墨碗））'), /[（）]/);
});
