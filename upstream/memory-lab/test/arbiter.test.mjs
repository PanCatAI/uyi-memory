import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScene } from '../lib/scene.mjs';
import { foldWorld } from '../lib/world.mjs';
import { checkAction, actionEvents, createQueues } from '../lib/arbiter.mjs';

const scene = loadScene('island');
const stairs = { ...scene.palette.find(p => p.id === 'stairs'), room: 'lighthouse' };
const base = (extra = []) => foldWorld(scene, [{ type: 'session_start', actor: 'host', payload: { gap_ms: 0 } }, ...extra]);
const ok = (st, a) => checkAction(st, scene, 'rin', a);

test('checkAction: each condition passes and fails', () => {
  const st = base();
  assert.equal(ok(st, { name: 'dance' }).ok, false);
  assert.equal(ok(st, { name: 'pick_up', target: 'red_cup' }).ok, true);
  assert.match(ok(st, { name: 'pick_up', target: 'shell' }).reason, /不在这里/);                // same_room
  assert.match(ok(st, { name: 'pick_up', target: 'table' }).reason, /不能这样用/);              // tag
  const holding = base([{ type: 'char_action', actor: 'rin', action: 'pick_up', target: 'red_cup', outcome: 'ok', payload: { args: {} } }]);
  assert.match(ok(holding, { name: 'pick_up', target: 'red_cup' }).reason, /手里已经拿着红杯子/); // hands_free
  assert.match(ok(st, { name: 'put_down', target: 'table' }).reason, /什么都没拿/);              // holding
  assert.equal(ok(holding, { name: 'put_down', target: 'table' }).ok, true);
  assert.match(ok(holding, { name: 'wear', target: 'red_cup' }).reason, /不能这样用/);           // tag:wearable
  assert.equal(ok(holding, { name: 'give', target: 'user' }).ok, true);                          // user_present
  assert.match(checkAction(holding, scene, 'rin', { name: 'give', target: 'user' }, { userPresent: false }).reason, /用户不在/);
  assert.equal(ok(st, { name: 'wave' }).ok, true);
  assert.equal(ok(st, { name: 'wave', target: 'red_cup' }).ok, false);                           // target kind none
  assert.equal(ok(st, { name: 'walk_to', target: 'lighthouse' }).ok, true);
  assert.equal(ok(st, { name: 'walk_to', target: 'moon' }).ok, false);
});

test('lamp is too high until the stairs are climbed', () => {
  const there = base([{ type: 'object_created', actor: 'host', target: 'stairs', payload: { object: stairs } }, { type: 'char_moved', actor: 'rin', target: 'lighthouse', payload: { from: 'cabin', to: 'lighthouse' } }]);
  assert.match(ok(there, { name: 'switch', target: 'lamp' }).reason, /太高了/);
  const up = foldWorld(scene, [{ type: 'object_created', actor: 'host', target: 'stairs', payload: { object: stairs } }, { type: 'char_moved', actor: 'rin', target: 'lighthouse', payload: { from: 'cabin', to: 'lighthouse' } }, { type: 'char_action', actor: 'rin', action: 'climb', target: 'stairs', outcome: 'ok', payload: { args: {} } }]);
  assert.equal(ok(up, { name: 'switch', target: 'lamp' }).ok, true);
});

test('actionEvents: failures are recorded, walk_to moves rooms', () => {
  const st = base();
  const failed = actionEvents(st, scene, 'rin', { name: 'pick_up', target: 'shell' }, ok(st, { name: 'pick_up', target: 'shell' }));
  assert.equal(failed[0].outcome, 'failed');
  assert.match(failed[0].payload.reason, /贝壳不在这里/);
  const walk = actionEvents(st, scene, 'rin', { name: 'walk_to', target: 'bench' }, { ok: true });
  assert.deepEqual(walk.map(e => e.type), ['char_moved', 'char_action']);
  assert.equal(walk[0].payload.to, 'beach');
});

test('queues: serial per character, parallel across characters', async () => {
  const q = createQueues();
  const log = [];
  const wait = (ms, tag) => () => new Promise(r => setTimeout(() => { log.push(tag); r(tag); }, ms));
  const a = q.queue('s', 'rin', 'act', wait(30, 'rin1'));
  const b = q.queue('s', 'rin', 'act', wait(1, 'rin2'));
  const c = q.queue('s', 'qiao', 'act', wait(5, 'qiao'));
  assert.equal(q.pending('s'), 3);
  await Promise.all([a, b, c]);
  assert.deepEqual(log, ['qiao', 'rin1', 'rin2']);
  await q.idle('s');
  assert.equal(q.pending('s'), 0);
});
