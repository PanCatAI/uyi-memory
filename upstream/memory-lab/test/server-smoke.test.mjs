import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startSandbox } from './helpers/sandbox.mjs';

let sb;
before(async () => { sb = await startSandbox(); });
after(async () => { await sb?.stop(); });

test('health answers with version and mock provider', async () => {
  const r = await sb.get('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.version, '0.1.0');
  assert.equal(r.body.provider, 'mock');
});

test('serves the page and three.js', async () => {
  assert.match((await sb.get('/')).body.toString(), /记忆实验台/);
  assert.equal((await sb.get('/vendor/three/build/three.module.js')).status, 200);
});

test('unknown api is 404 json, path traversal is refused', async () => {
  const r = await sb.get('/api/nope');
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, 'NOT_FOUND');
  assert.equal((await sb.get('/..%2Fpackage.json')).status, 404);
});
