import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScene } from '../lib/scene.mjs';
import { foldWorld, roomOf } from '../lib/world.mjs';

const scene = loadScene('island');
const scarf = { ...scene.palette.find(p => p.id === 'new_scarf'), room: 'cabin', pos: [-4, 0, 1] };
const stairs = { ...scene.palette.find(p => p.id === 'stairs'), room: 'lighthouse' };
const act = (actor, action, target) => ({ type: 'char_action', actor, action, target, outcome: 'ok', payload: { args: {} } });

test('give scarf, wear it', () => {
  const s = foldWorld(scene, [
    { type: 'object_created', actor: 'host', target: 'new_scarf', payload: { object: scarf } },
    { type: 'object_changed', actor: 'host', target: 'new_scarf', payload: { field: 'holder', from: null, to: 'rin' } },
    act('rin', 'wear', 'new_scarf')
  ]);
  assert.equal(s.objects.new_scarf.worn_by, 'rin');
  assert.equal(s.characters.rin.holding, null);
  assert.deepEqual(s.characters.rin.wearing, ['new_scarf']);
});

test('build stairs, walk, climb, switch twice', () => {
  const evs = [
    { type: 'object_created', actor: 'host', target: 'stairs', payload: { object: stairs } },
    { type: 'char_moved', actor: 'rin', target: 'lighthouse', payload: { from: 'cabin', to: 'lighthouse' } },
    act('rin', 'climb', 'stairs'),
    act('rin', 'switch', 'lamp')
  ];
  let s = foldWorld(scene, evs);
  assert.equal(s.characters.rin.room, 'lighthouse');
  assert.equal(s.characters.rin.elevated, true);
  assert.equal(s.objects.lamp.state.on, true);
  s = foldWorld(scene, [...evs, act('rin', 'switch', 'lamp')]);
  assert.equal(s.objects.lamp.state.on, false);
});

test('held object is in its holder\'s room; failed actions change nothing', () => {
  const s = foldWorld(scene, [
    act('rin', 'pick_up', 'red_cup'),
    { type: 'char_moved', actor: 'rin', target: 'beach', payload: { from: 'cabin', to: 'beach' } },
    { type: 'char_action', actor: 'rin', action: 'climb', target: 'bench', outcome: 'failed', payload: { args: {}, reason: 'x' } }
  ]);
  assert.equal(s.characters.rin.holding, 'red_cup');
  assert.equal(roomOf(s, 'red_cup'), 'beach');
  assert.equal(s.characters.rin.elevated, false);
});

test('user_said moves the user to the addressee\'s room; sessions open and close', () => {
  const s = foldWorld(scene, [
    { type: 'session_start', actor: 'host', payload: { gap_ms: 0 } },
    { type: 'user_said', actor: 'user', payload: { text: 'hi', to: 'qiao' } }
  ]);
  assert.equal(s.userRoom, 'beach');
  assert.equal(s.sessionOpen, true);
});
