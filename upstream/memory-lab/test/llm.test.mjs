import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb } from '../lib/db.mjs';
import { createLlm } from '../lib/llm.mjs';

const KEY = 'sk-test-secret-123';
let server, base, plan = [], seen = [];
before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      seen.push({ headers: req.headers, body: JSON.parse(body) });
      const [status, payload] = plan.shift() || [200, { choices: [{ message: { content: '{"ok":1}' } }] }];
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const make = (extra = {}) => {
  const db = openDb(':memory:');
  return { db, llm: createLlm({ db, getEnv: () => ({ LLM_BASE_URL: base, LLM_API_KEY: KEY, LLM_MODEL: 'm1', ...extra }) }) };
};
const ok = content => [200, { model: 'served-model', choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 40 } }];

test('sends bearer key and json response_format, strips fences', async () => {
  const { llm, db } = make();
  plan = [ok('```json\n{"say":"嗨"}\n```')]; seen = [];
  const out = await llm.callJson({ purpose: 'reply', system: 's', user: 'u' });
  assert.equal(out.say, '嗨');
  assert.equal(out.__meta.model, 'served-model');
  assert.equal(seen[0].headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(seen[0].body.response_format, { type: 'json_object' });
  assert.equal(seen[0].body.model, 'm1');
  const row = db.prepare('SELECT * FROM llm_calls').get();
  assert.equal(row.cached_tokens, 40);
  assert.equal(row.cost_usd, null); // no prices configured
});

test('2.0 C7: cache hits from DeepSeek or OpenAI-style usage; none reported is not a 0', async () => {
  const { llm, db } = make();
  const usage = u => [200, { choices: [{ message: { content: '{"a":1}' } }], usage: { prompt_tokens: 100, completion_tokens: 10, ...u } }];
  plan = [usage({ prompt_cache_hit_tokens: 64 }), usage({ prompt_tokens_details: { cached_tokens: 32 } }), usage({})];
  for (let i = 0; i < 3; i++) await llm.callJson({ purpose: 'facts', system: 's', user: 'u' });
  const rows = db.prepare('SELECT cached_tokens, cache_reported FROM llm_calls ORDER BY real_at, rowid').all().map(r => [r.cached_tokens, r.cache_reported]);
  assert.deepEqual(rows, [[64, 1], [32, 1], [0, 0]]);
});

test('retries a 500 once', async () => {
  const { llm } = make();
  plan = [[500, 'oops'], ok('{"a":1}')];
  assert.equal((await llm.callJson({ purpose: 'facts', system: 's', user: 'u' })).a, 1);
});

test('a 401 never stores the key', async () => {
  const { llm, db } = make();
  plan = [[401, `bad key ${KEY}`]];
  await assert.rejects(llm.callJson({ purpose: 'reply', system: 's', user: 'u' }), /401/);
  const row = db.prepare('SELECT error FROM llm_calls').get();
  assert.doesNotMatch(row.error, new RegExp(KEY));
});

test('prices give a cost; background model for background purposes', async () => {
  const { llm, db } = make({ LLM_MODEL_BACKGROUND: 'cheap', LLM_PRICE_INPUT: '1', LLM_PRICE_CACHED: '0.1', LLM_PRICE_OUTPUT: '2' });
  plan = [ok('{"facts":[],"commitments":[]}')]; seen = [];
  await llm.callJson({ purpose: 'facts', system: 's', user: 'u' });
  assert.equal(seen[0].body.model, 'cheap');
  const c = db.prepare('SELECT cost_usd FROM llm_calls').get().cost_usd;
  assert.ok(Math.abs(c - (60 * 1 + 40 * 0.1 + 10 * 2) / 1e6) < 1e-12);
});

test('callChecked retries a bad shape once with the errors', async () => {
  const { llm } = make();
  plan = [ok('{"say":""}'), ok('{"say":"好","used":[]}')]; seen = [];
  const out = await llm.callChecked({ purpose: 'reply', system: 's', user: 'u' });
  assert.equal(out.say, '好');
  assert.match(seen[1].body.messages[1].content, /say 必须是非空字符串/);
});

test('mock provider does not touch the network', async () => {
  const db = openDb(':memory:');
  const llm = createLlm({ db, getEnv: () => ({ LLM_PROVIDER: 'mock' }), fetchImpl: () => { throw new Error('network!'); } });
  assert.equal((await llm.testConnection()).ok, true);
});
