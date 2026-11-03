import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.mjs';
import { foldWorld } from '../lib/world.mjs';

const said = (text, to = 'rin') => ({ type: 'user_said', actor: 'user', payload: { text, to } });

test('append assigns seq, t, room, perceivers, presence', () => {
  const { ledger, saveId, saves, clock } = freshDb();
  saves.setSession(saveId, 'sess1');
  ledger.append(saveId, { type: 'session_start', actor: 'host', payload: { gap_ms: 0 } });
  const ev = ledger.append(saveId, said('你好'));
  assert.equal(ev.seq, 2);
  assert.equal(ev.t, clock.now(saveId));
  assert.equal(ev.room, 'cabin');
  assert.deepEqual(ev.perceivers, ['rin']);
  assert.equal(ev.user_presence, 'present');
  assert.equal(ev.session_id, 'sess1');
});

test('invalid events are refused and take no seq', () => {
  const { ledger, saveId } = freshDb();
  assert.throws(() => ledger.append(saveId, { type: 'char_said', actor: 'user', payload: {} }), /事件不合法/);
  assert.throws(() => ledger.appendMany(saveId, [said('a'), { type: 'nope', actor: 'user' }]), /事件不合法/);
  assert.equal(ledger.lastSeq(saveId), 0);
  assert.equal(ledger.append(saveId, said('b')).seq, 1);
});

test('time cannot go backwards; offscreen events have no session', () => {
  const { ledger, saveId, clock } = freshDb();
  clock.advance(saveId, 10_000);
  ledger.append(saveId, said('a'));
  assert.throws(() => ledger.append(saveId, { ...said('b'), t: 0 }), /不能早于/);
  const ev = ledger.append(saveId, { type: 'char_action', actor: 'rin', action: 'clean', target: 'red_cup', outcome: 'ok', offscreen: true, payload: { args: {} } });
  assert.equal(ev.session_id, null);
  assert.equal(ev.user_presence, 'absent');
});

test('tombstone touches only payload and tombstone', () => {
  const { ledger, saveId } = freshDb();
  const ev = ledger.append(saveId, said('秘密'));
  ledger.tombstone(saveId, ev.seq, { job: 'fj_1', verb: 'delete', at: 1 });
  const got = ledger.get(saveId, ev.seq);
  assert.equal(got.payload, null);
  assert.deepEqual(got.tombstone, { job: 'fj_1', verb: 'delete', at: 1 });
  assert.equal(got.type, 'user_said');
});

test('cached world equals a fresh fold', () => {
  const { ledger, saveId, scene } = freshDb();
  ledger.appendMany(saveId, [
    said('拿杯子'),
    { type: 'char_action', actor: 'rin', action: 'pick_up', target: 'red_cup', outcome: 'ok', payload: { args: {} } },
    { type: 'char_moved', actor: 'rin', target: 'beach', payload: { from: 'cabin', to: 'beach' } }
  ]);
  const cached = ledger.world(saveId);
  assert.deepEqual(cached, foldWorld(scene, ledger.list(saveId, { all: true })));
  assert.equal(cached.characters.rin.room, 'beach');
  const ev = ledger.append(saveId, said('在海滩吗'));
  assert.equal(ev.room, 'beach');
});
