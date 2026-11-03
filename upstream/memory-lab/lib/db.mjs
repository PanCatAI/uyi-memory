import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const SCHEMA = readFileSync(new URL('../contracts/schema.sql', import.meta.url), 'utf8');

// Columns added after version 1. CREATE TABLE IF NOT EXISTS leaves old tables alone, so existing databases
// get them here; new databases already have them from schema.sql. Indexes on added columns live here too.
const ADDED_COLUMNS = [
  ['llm_calls', 'finish_reason', 'TEXT'], ['llm_calls', 'stage', 'TEXT'], ['llm_calls', 'logical_id', 'TEXT'],
  ['llm_calls', 'attempt', 'INTEGER'], ['llm_calls', 'usage_known', 'INTEGER'], ['llm_calls', 'cache_reported', 'INTEGER'],
  ['scenario_runs', 'request_id', 'TEXT'], ['turns', 'thought', 'TEXT'], ['turns', 'card_version', 'INTEGER'],
  ['caches', 'day', 'TEXT'], ['caches', 'intention', 'TEXT'], ['caches', 'refs', 'TEXT'],
  ['saves', 'relationship_floor', 'TEXT'], ['user_facts', 'known_how', 'TEXT'],
  ['saves', 'reply_mode', 'TEXT'], ['scenario_runs', 'arm', 'TEXT'], ['scenario_runs', 'arm_group', 'TEXT'],
  ['saves', 'features_json', 'TEXT'], ['turns', 'intent', 'TEXT'], ['turns', 'topic', 'TEXT']
];
const ADDED_INDEXES = [
  'CREATE UNIQUE INDEX IF NOT EXISTS scenario_runs_request ON scenario_runs(request_id) WHERE request_id IS NOT NULL'
];
/** Opens (or creates) the lab database, applies contracts/schema.sql and the column migrations. file may be ':memory:'. */
export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  for (const [table, column, decl] of ADDED_COLUMNS) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
  for (const sql of ADDED_INDEXES) db.exec(sql);
  // user_version stays 1: migrations are keyed on the columns themselves, so they are idempotent.
  if (db.prepare('PRAGMA user_version').get().user_version === 0) db.exec('PRAGMA user_version = 1');
  return db;
}

/** Runs fn inside BEGIN/COMMIT; rolls back and rethrows on error. fn must be synchronous. Nested calls join the outer one. */
export function tx(db, fn) {
  if (db.isTransaction) return fn();
  db.exec('BEGIN');
  try { const out = fn(); db.exec('COMMIT'); return out; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

export const j = v => JSON.stringify(v ?? null);
export function pj(text, fallback = null) {
  if (text == null) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}
