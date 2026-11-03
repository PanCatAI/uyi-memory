import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScene } from '../lib/scene.mjs';
import { initialState } from '../lib/world.mjs';
import { visibility, presenceFor, perceiversFor, overheardText } from '../lib/perception.mjs';

const scene = loadScene('island');

test('visibility rules', () => {
  const said = (to, perceivers) => ({ type: 'user_said', actor: 'user', perceivers, payload: { text: '秘密', to } });
  assert.equal(visibility({ type: 'char_action', actor: 'rin', perceivers: [] }, 'rin'), 'full');
  assert.equal(visibility({ type: 'time_skip', actor: 'host', perceivers: [] }, 'qiao'), 'full');
  assert.equal(visibility(said('rin', ['rin']), 'qiao'), 'none');
  assert.equal(visibility(said('rin', ['rin', 'qiao']), 'qiao'), 'overheard');
  assert.equal(visibility({ type: 'char_said', actor: 'rin', perceivers: ['rin', 'qiao'], payload: { to: 'user' } }, 'qiao'), 'overheard');
  assert.equal(visibility(said('qiao', ['rin', 'qiao']), 'qiao'), 'full');
  assert.equal(visibility({ type: 'user_action', actor: 'user', perceivers: ['qiao'], payload: { args: {} } }, 'qiao'), 'full');
});

test('presence and perceivers', () => {
  const s = initialState(scene);
  assert.equal(presenceFor(s, 'cabin'), 'absent');
  s.sessionOpen = true;
  assert.equal(presenceFor(s, 'cabin'), 'present');
  assert.equal(presenceFor(s, 'beach'), 'maybe');
  assert.deepEqual(perceiversFor(s, 'cabin'), ['rin']);
});

test('overheard rewrite has no original words', () => {
  const t = overheardText({ type: 'user_said', actor: 'user', payload: { text: '生日礼物', to: 'rin' } }, scene);
  assert.equal(t, '用户和玲说了几句话（你没有细听）');
});
