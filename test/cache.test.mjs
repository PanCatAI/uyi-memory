// 2.0 C7: the system prompt stays cacheable, and cache hits are only trusted when the provider reports them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { freshLab } from './helpers/lab.mjs';
import { openDb } from '../lib/db.mjs';
import { createLlm } from '../lib/llm.mjs';

const sha = s => createHash('sha256').update(s).digest('hex');

test('system prompt is byte-identical across 10 turns of one save while the card version stays the same', async () => {
  const { lab, saveId, say } = await freshLab({ sceneId: 'camp' });
  const lines = ['我回来了', '你腰上那把短剑哪来的？', '我叫阿远', '不对，是小远', '你会游泳吗？', '今天风大吗', '坐下歇会儿吧', '火还烧着吗', '明天去北坡吗', '晚安'];
  for (const text of lines) await say(text);
  await lab.jobs.idle(saveId);
  const rows = lab.db.prepare("SELECT prompt_json, card_version FROM turns WHERE save_id = ? AND mode = 'memory' ORDER BY rowid").all(saveId);
  assert.equal(rows.length, 10);
  assert.equal(new Set(rows.map(r => r.card_version)).size, 1);
  const hashes = new Set(rows.map(r => sha(JSON.parse(r.prompt_json).find(m => m.role === 'system').content)));
  assert.equal(hashes.size, 1, 'system prompt changed between turns: it would miss the provider prompt cache');
});

test('cache_reported is 0 when the provider reports usage without a cache field', async () => {
  const db = openDb(':memory:');
  const fetchImpl = async () => new Response(JSON.stringify({ model: 'm', choices: [{ message: { content: '{"a":1}' } }], usage: { prompt_tokens: 50, completion_tokens: 5 } }), { status: 200 });
  const llm = createLlm({ db, fetchImpl, getEnv: () => ({ LLM_BASE_URL: 'http://127.0.0.1:9', LLM_API_KEY: 'k', LLM_MODEL: 'm' }) });
  await llm.callJson({ purpose: 'facts', system: 's', user: 'u' });
  const row = db.prepare('SELECT cached_tokens, cache_reported, usage_known FROM llm_calls').get();
  assert.deepEqual({ ...row }, { cached_tokens: 0, cache_reported: 0, usage_known: 1 });
});
