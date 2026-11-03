import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, tx } from '../lib/db.mjs';

const TABLES = ['saves', 'events', 'event_flags', 'user_facts', 'rejected_facts', 'commitments', 'self_canon', 'caches', 'watermarks', 'mentions', 'retrievals', 'suppressions', 'forget_jobs', 'turns', 'llm_calls', 'scenario_runs'];

function withEvent() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO saves (id, name, scene_id, clock_ms, created_at) VALUES ('s1', 'x', 'island', 0, 0)").run();
  db.prepare("INSERT INTO events (save_id, seq, t, type, actor, payload_json) VALUES ('s1', 1, 0, 'user_said', 'user', '{}')").run();
  return db;
}

test('all tables exist and user_version is 1', () => {
  const db = openDb(':memory:');
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name);
  for (const t of TABLES) assert.ok(names.includes(t), t);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
});

test('event header is immutable, payload is not', () => {
  const db = withEvent();
  assert.throws(() => db.exec("UPDATE events SET type = 'x'"), /event header is immutable/);
  assert.throws(() => db.exec('UPDATE events SET t = 5'), /event header is immutable/);
  db.exec("UPDATE events SET payload_json = NULL, tombstone_json = '{}'");
  assert.equal(db.prepare('SELECT payload_json FROM events').get().payload_json, null);
});

test('tx rolls back on error', () => {
  const db = withEvent();
  assert.throws(() => tx(db, () => { db.exec("UPDATE saves SET name = 'y'"); throw new Error('boom'); }), /boom/);
  assert.equal(db.prepare('SELECT name FROM saves').get().name, 'x');
  tx(db, () => tx(db, () => db.exec("UPDATE saves SET name = 'z'")));
  assert.equal(db.prepare('SELECT name FROM saves').get().name, 'z');
});
