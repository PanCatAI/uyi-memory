// R1 / P1-01: every attempt is logged with its stage, usage survives JSON failures, truncation grows max_tokens,
// unknown usage is never priced, old databases get the new columns, and one scenario request runs once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../lib/db.mjs';
import { createLlm, MAX_TOKENS_CAP } from '../lib/llm.mjs';
import { createLab } from '../lib/lab.mjs';
import { createScenarios } from '../lib/scenarios.mjs';

process.env.LAB_QUIET = '1';
const PRICES = { LLM_PRICE_INPUT: '1', LLM_PRICE_OUTPUT: '2' };
const reply = (content, { finish = 'stop', usage = { prompt_tokens: 1000, completion_tokens: 600 } } = {}) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify({ model: 'fixture', ...(usage ? { usage } : {}), choices: [{ finish_reason: finish, message: { content } }] }) });

/** A local fetch fixture: plan is a list of responses (or functions body → response); requests are recorded. */
function fixture(plan, env = PRICES) {
  const requests = [];
  const db = openDb(':memory:');
  const llm = createLlm({
    db, getEnv: () => ({ LLM_API_KEY: 'NON_SECRET_FIXTURE', ...env }),
    fetchImpl: async (_url, opts) => {
      const body = JSON.parse(opts.body);
      requests.push(body);
      const next = plan.length > 1 ? plan.shift() : plan[0];
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next(body) : next;
    }
  });
  const rows = () => db.prepare('SELECT * FROM llm_calls ORDER BY attempt').all();
  return { db, llm, requests, rows };
}
const TRUNC = '{"facts":[{"predicate":"likes","object":"unfin';

test('truncated output keeps its usage and is retried with a bigger max_tokens, not a nudge (F9 fixture: $0.0044)', async () => {
  const f = fixture([reply(TRUNC, { finish: 'length' }), reply('{"facts":[],"commitments":[]}')]);
  const out = await f.llm.callChecked({ purpose: 'facts', system: 's', user: 'u' });
  assert.deepEqual(out.facts, []);
  assert.deepEqual(f.requests.map(r => r.max_tokens), [600, 1200]);
  assert.equal(f.requests[1].messages[1].content, 'u'); // no "output valid JSON" nudge for truncation
  const rows = f.rows();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.stage), ['json', 'ok']);
  assert.deepEqual(rows.map(r => r.finish_reason), ['length', 'stop']);
  assert.deepEqual(rows.map(r => r.attempt), [1, 2]);
  assert.equal(new Set(rows.map(r => r.logical_id)).size, 1);
  assert.ok(rows.every(r => r.input_tokens === 1000 && r.output_tokens === 600 && r.usage_known === 1));
  const total = rows.reduce((t, r) => t + r.cost_usd, 0);
  assert.ok(Math.abs(total - 0.0044) < 1e-12, `total ${total}`);
});

test('always-truncated output stops at the max_tokens cap and every attempt is priced', async () => {
  const f = fixture([reply(TRUNC, { finish: 'length' })]);
  await assert.rejects(f.llm.callChecked({ purpose: 'facts', system: 's', user: 'u' }), e => e.code === 'TRUNCATED');
  assert.deepEqual(f.requests.map(r => r.max_tokens), [600, 1200, MAX_TOKENS_CAP]);
  assert.ok(f.requests.every(r => r.max_tokens <= 2000));
  const rows = f.rows();
  assert.equal(rows.length, 3);
  assert.ok(rows.every(r => r.stage === 'json' && r.ok === 0 && r.output_tokens === 600 && r.cost_usd > 0));
});

test('plain bad JSON keeps usage and gets one nudge', async () => {
  const f = fixture([reply('not json'), reply('{"facts":[],"commitments":[]}')]);
  await f.llm.callChecked({ purpose: 'facts', system: 's', user: 'u' });
  assert.match(f.requests[1].messages[1].content, /没有输出合法 JSON/);
  const [bad, good] = f.rows();
  assert.equal(bad.stage, 'json');
  assert.equal(bad.input_tokens, 1000);
  assert.ok(bad.cost_usd > 0);
  assert.equal(good.stage, 'ok');
});

test('HTTP and network retries are logged per attempt under one logical call', async () => {
  const f = fixture([{ ok: false, status: 503, text: async () => 'busy' }, reply('{"facts":[],"commitments":[]}')]);
  await f.llm.callJson({ purpose: 'facts', system: 's', user: 'u' });
  assert.deepEqual(f.rows().map(r => [r.stage, r.attempt]), [['http', 1], ['ok', 2]]);
  assert.equal(new Set(f.rows().map(r => r.logical_id)).size, 1);

  const g = fixture([new Error('socket hang up'), reply('{"facts":[],"commitments":[]}')]);
  await g.llm.callJson({ purpose: 'facts', system: 's', user: 'u' });
  assert.deepEqual(g.rows().map(r => r.stage), ['network', 'ok']);
  assert.equal(g.rows()[0].usage_known, 0);
  assert.equal(g.rows()[0].cost_usd, null);
});

test('a bad shape marks its attempt as failed at the shape stage', async () => {
  const f = fixture([reply('{"say":""}'), reply('{"say":"好","used":[]}')]);
  await f.llm.callChecked({ purpose: 'reply', system: 's', user: 'u' });
  const [bad, good] = f.rows();
  assert.equal(bad.stage, 'shape');
  assert.equal(bad.ok, 0);
  assert.match(bad.error, /say 必须是非空字符串/);
  assert.equal(good.stage, 'ok');
});

test('no usage from the provider → usage_known 0 and no cost even with prices', async () => {
  const f = fixture([reply('{"ok":1}', { usage: null })]);
  const out = await f.llm.callJson({ purpose: 'test', system: 's', user: 'u' });
  assert.equal(out.__meta.cost, null);
  const [row] = f.rows();
  assert.equal(row.usage_known, 0);
  assert.equal(row.cost_usd, null);
});

test('mock calls are logged as estimated, never priced', async () => {
  const db = openDb(':memory:');
  const llm = createLlm({ db, getEnv: () => ({ LLM_PROVIDER: 'mock', ...PRICES }) });
  await llm.callChecked({ purpose: 'reply', system: 's', user: 'u', mockInput: { input: '你好' } });
  const row = db.prepare('SELECT * FROM llm_calls').get();
  assert.equal(row.stage, 'ok');
  assert.equal(row.usage_known, 0);
  assert.equal(row.cost_usd, null);
  assert.equal(row.attempt, 1);
});

test('an old database without the new columns is migrated in place and keeps its rows', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'memory-lab-migrate-'));
  const file = path.join(dir, 'old.sqlite');
  try {
    const old = openDb(file);
    old.exec('DROP INDEX scenario_runs_request');
    for (const c of ['finish_reason', 'stage', 'logical_id', 'attempt', 'usage_known']) old.exec(`ALTER TABLE llm_calls DROP COLUMN ${c}`);
    old.exec('ALTER TABLE scenario_runs DROP COLUMN request_id');
    old.prepare("INSERT INTO llm_calls (id, purpose, provider, model, latency_ms, ok, real_at) VALUES ('l_old', 'reply', 'mock', 'mock', 0, 1, 0)").run();
    old.close();
    const db = openDb(file);
    const cols = db.prepare('PRAGMA table_info(llm_calls)').all().map(c => c.name);
    for (const c of ['finish_reason', 'stage', 'logical_id', 'attempt', 'usage_known']) assert.ok(cols.includes(c), c);
    assert.ok(db.prepare('PRAGMA table_info(scenario_runs)').all().some(c => c.name === 'request_id'));
    assert.equal(db.prepare("SELECT stage FROM llm_calls WHERE id = 'l_old'").get().stage, null);
    db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the same scenario requestId runs once, concurrently or resent; a step clicked twice runs once', async () => {
  const lab = createLab();
  const runner = createScenarios(lab);
  const saves = () => lab.saves.listSaves().length;
  const before = saves();
  const [a, b] = await Promise.all([runner.start('red-cup', { requestId: 'req-1' }), runner.start('red-cup', { requestId: 'req-1' })]);
  assert.equal(a.id, b.id);
  assert.equal((await runner.start('red-cup', { requestId: 'req-1' })).id, a.id);
  assert.equal(saves(), before + 1);
  assert.equal(lab.db.prepare('SELECT count(*) n FROM scenario_runs').get().n, 1);
  // A new requestId is a new, intended run.
  assert.notEqual((await runner.start('red-cup', { requestId: 'req-2' })).id, a.id);
  assert.equal(saves(), before + 2);

  const s = await runner.start('red-cup', { requestId: 'req-3', stepOnly: true });
  const [x, y] = await Promise.all([runner.step(s.id), runner.step(s.id)]);
  assert.equal(x.step, 1);
  assert.equal(y.step, 1);
  await assert.rejects(runner.start('red-cup', { requestId: 'bad id!' }), /requestId/);
});

test('a truncation caused by reasoning tokens says so in the attempt row', async () => {
  const f = fixture([reply('', { finish: 'length', usage: { prompt_tokens: 400, completion_tokens: 600, completion_tokens_details: { reasoning_tokens: 600 } } }), reply('{"facts":[],"commitments":[]}')]);
  await f.llm.callChecked({ purpose: 'facts', system: 's', user: 'u' });
  assert.match(f.rows()[0].error, /其中推理 600，正文 0 字/);
});
