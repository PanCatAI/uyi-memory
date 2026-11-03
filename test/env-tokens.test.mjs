import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { saveEnv, loadEnv, mask } from '../lib/env.mjs';
import { estimate } from '../lib/tokens.mjs';

test('env file is private and round-trips', async () => {
  const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'env-')), '.env');
  await saveEnv(file, { LLM_API_KEY: 'sk-abcdef', LLM_EXTRA_BODY: '{"a":1}', bad_key: 'x' });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await loadEnv(file), { LLM_API_KEY: 'sk-abcdef', LLM_EXTRA_BODY: '{"a":1}' });
  assert.doesNotMatch(await readFile(file, 'utf8'), /bad_key/);
  assert.equal(mask('sk-abcdef'), '••••cdef');
});

test('token estimate', () => {
  const n = estimate('灯塔 lighthouse');
  assert.ok(Number.isInteger(n) && n > 0);
  assert.equal(estimate(''), 0);
  assert.ok(estimate('灯塔灯塔灯塔灯塔灯塔') > estimate('lighthouse'));
});
