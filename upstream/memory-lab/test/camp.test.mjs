import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScene, inRoom, roomBox, roomCenter, sameArea, validateScene } from '../lib/scene.mjs';
import { foldWorld, roomOf } from '../lib/world.mjs';
import { perceiversFor, presenceFor } from '../lib/perception.mjs';
import { checkAction, actionEvents, perceivable, planActions } from '../lib/arbiter.mjs';

const scene = loadScene('camp');
const start = (extra = []) => foldWorld(scene, [{ type: 'session_start', actor: 'host', payload: { gap_ms: 0 } }, ...extra]);
const act = (action, target = null, args = {}) => ({ type: 'char_action', actor: 'lan', action, target, outcome: 'ok', payload: { args } });
const ok = (st, a) => checkAction(st, scene, 'lan', a);

test('camp loads: studio ids, lan card, user at fireside, sword worn', () => {
  for (const id of ['campfire-1', 'tent-1', 'log-bench-1', 'log-bench-2', 'wood-crate-1', 'barrel-1', 'lantern-1', 'cup', 'backpack', 'sword']) assert.ok(scene.objects.some(o => o.id === id), id);
  assert.deepEqual(scene.palette.map(p => p.id), ['pine-nuts', 'wildflower']);
  const lan = scene.characters[0];
  assert.equal(lan.id, 'lan');
  assert.equal(lan.card.lore.length, 10);
  const st = start();
  assert.equal(st.userRoom, 'fireside');
  assert.equal(st.objects.sword.worn_by, 'lan');
  assert.deepEqual(st.characters.lan.wearing, ['sword']);
  assert.equal(roomOf(st, 'sword'), 'fireside');
});

test('point in polygon / box: 6 cases', () => {
  assert.equal(inRoom(scene, 'fireside', 0, 0.45), true);      // the fire
  assert.equal(inRoom(scene, 'fireside', -2, 1.1), true);      // west bench
  assert.equal(inRoom(scene, 'fireside', 1.65, -1.9), false);  // crate is in the supply corner
  assert.equal(inRoom(scene, 'supply', 1.65, -1.9), true);
  assert.equal(inRoom(scene, 'tent', -0.2, -2.25), true);      // box room still works
  assert.equal(inRoom(scene, 'path', 0, 3.5), true);
  assert.equal(inRoom(scene, 'path', 2, 3.5), false);
  assert.deepEqual(roomBox(scene, 'supply'), [1, -2.6, 3, -1]);
  assert.deepEqual(roomCenter(scene, 'supply'), [2, 0, -1.8]);
  assert.deepEqual(roomCenter(scene, 'fireside'), [0, 0, 1.2]);  // explicit center
});

test('groups: open ground sees and hears, the tent has walls', () => {
  assert.equal(sameArea(scene, 'fireside', 'supply'), true);
  assert.equal(sameArea(scene, 'path', 'supply'), true);
  assert.equal(sameArea(scene, 'tent', 'fireside'), false);
  assert.equal(sameArea(scene, 'tent', 'tent'), true);
  const moved = start([{ type: 'char_moved', actor: 'lan', target: 'supply', payload: { from: 'fireside', to: 'supply' } }]);
  assert.equal(moved.characters.lan.room, 'supply');
  assert.deepEqual(perceiversFor(moved, 'fireside', scene), ['lan']);
  assert.equal(presenceFor(moved, 'supply', scene), 'present');
  const inside = start([act('enter', 'tent-1')]);
  assert.equal(inside.characters.lan.room, 'tent');
  assert.deepEqual(perceiversFor(inside, 'fireside', scene), []);
  assert.equal(presenceFor(inside, 'tent', scene), 'maybe');
  assert.deepEqual(perceiversFor(inside, 'fireside'), [], 'without scene: per-room as in 1.0');
  // the user nearby (same group, other zone) counts as present for give
  const holding = start([{ type: 'char_moved', actor: 'lan', target: 'supply', payload: { from: 'fireside', to: 'supply' } }, act('pick_up', 'backpack')]);
  assert.equal(ok(holding, { name: 'give', target: 'user' }).ok, true);
  assert.equal(perceivable(holding, scene, 'lan').rows.find(r => r.id === 'user').where, '在附近（篝火边）');
  assert.ok(!perceivable(start(), scene, 'lan').free.includes('leave'), 'free actions are only the legal ones');
  assert.ok(perceivable(inside, scene, 'lan').free.includes('leave'));
});

test('arbiter: new actions pass and fail', () => {
  const st = start();
  // tend_fire
  assert.equal(ok(st, { name: 'tend_fire', target: 'campfire-1' }).ok, true);
  assert.match(ok(st, { name: 'tend_fire', target: 'log-bench-1' }).reason, /不能这样用/);
  const lit = start([{ ...act('tend_fire', 'campfire-1'), t: 1234 }]);
  assert.equal(lit.objects['campfire-1'].state.lit, true);
  assert.equal(lit.objects['campfire-1'].state.tended_at, 1234);
  // enter
  assert.equal(ok(st, { name: 'enter', target: 'tent-1' }).ok, true);
  assert.match(ok(st, { name: 'enter', target: 'campfire-1' }).reason, /不能这样用/);
  const inside = start([act('enter', 'tent-1')]);
  assert.match(ok(inside, { name: 'enter', target: 'tent-1' }).reason, /不在这里/);
  // leave
  assert.match(ok(st, { name: 'leave' }).reason, /本来就在外面/);
  assert.equal(ok(inside, { name: 'leave' }).ok, true);
  assert.equal(start([act('enter', 'tent-1'), act('leave')]).characters.lan.room, 'fireside');
  // draw_map
  assert.match(ok(st, { name: 'draw_map' }).reason, /得先坐下来/);
  const seated = start([act('sit', 'log-bench-1')]);
  assert.equal(ok(seated, { name: 'draw_map' }).ok, true);
  assert.equal(ok(seated, { name: 'draw_map', args: { with: 'cup' } }).ok, true);
  assert.match(ok(seated, { name: 'draw_map', args: { with: 'backpack' } }).reason, /不在这里/);
  assert.match(ok(seated, { name: 'draw_map', args: { with: 'inkpot' } }).reason, /没有「inkpot」/);
  // D9 live: "draw_map log-bench-1" (the bench she sits on as a target) is done without the target, not refused.
  const plan = planActions(seated, scene, 'lan', { name: 'draw_map', target: 'log-bench-1' });
  assert.equal(plan.failed, null);
  assert.equal(plan.steps[0].action.target, null);
  // failed events are recorded with the reason
  const evs = actionEvents(st, scene, 'lan', { name: 'draw_map' }, ok(st, { name: 'draw_map' }));
  assert.equal(evs[0].outcome, 'failed');
  // same_room stays per zone: the crate corner is open ground but you still walk there to pick things up
  assert.match(ok(st, { name: 'pick_up', target: 'backpack' }).reason, /不在这里/);
});

test('validateScene accepts poly, rejects a room with neither box nor poly', () => {
  const bad = { id: 'x', rooms: [{ id: 'a', name: 'A' }], objects: [], characters: [{ id: 'c', room: 'a' }], actions: {} };
  assert.throws(() => validateScene(bad), /要有 box/);
  const good = { ...bad, rooms: [{ id: 'a', name: 'A', poly: [[0, 0], [1, 0], [1, 1]] }] };
  assert.equal(validateScene(good), good);
});
