// 插件公开接口（index.mjs）和本机 HTTP 服务（bin/uyi-memory.mjs）。全部假模型、临时目录。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemory, MemoryError } from '../index.mjs';

process.env.LAB_QUIET = '1';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scene = JSON.parse(await readFile(path.join(root, 'examples', 'room.scene.json'), 'utf8'));
const T0 = Date.parse('2026-11-03T10:00:00+09:00');

async function fresh() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'uyi-memory-test-'));
  const mem = await createMemory({ dataDir });
  return { mem, dataDir, done: async () => { await mem.close(); await rm(dataDir, { recursive: true, force: true }); } };
}

test('a space keeps the host scene and inline card, starts at the given time, all game features off', async () => {
  const { mem, done } = await fresh();
  const sp = mem.createSpace({ name: '我的房间', userName: '小林', scene, now: T0 });
  assert.equal(sp.clock, T0);
  assert.deepEqual(sp.characters, [{ id: 'rin', name: '玲' }]);
  assert.ok(Object.entries(sp.features).filter(([k]) => k !== 'pace').every(([, v]) => v === false));
  assert.equal(mem.listSpaces().length, 1);
  await done();
});

test('bad scenes and unknown ids are readable errors', async () => {
  const { mem, done } = await fresh();
  const noCard = structuredClone(scene); delete noCard.characters[0].card_text;
  assert.throws(() => mem.createSpace({ scene: noCard }), e => e instanceof MemoryError && e.code === 'BAD_SCENE');
  const badRoom = structuredClone(scene); badRoom.objects[0].room = 'kitchen';
  assert.throws(() => mem.createSpace({ scene: badRoom }), /kitchen/);
  assert.throws(() => mem.getSpace('nope'), e => e.code === 'NO_SPACE' && e.status === 404);
  assert.equal(mem.listSpaces().length, 0, 'a refused scene leaves no space behind');
  await done();
});

test('chat → facts; a 3D gift is remembered; clock only moves forward; delete removes everything', async () => {
  const { mem, dataDir, done } = await fresh();
  const sp = mem.createSpace({ scene, now: T0 });
  await mem.openSession(sp.id);
  const r = await mem.chat(sp.id, 'rin', '这个红杯子是我奶奶留下的，帮我好好收着');
  assert.ok(r.say && r.turnId);
  assert.equal(mem.delivered(r.turnId).ok, true);
  mem.userAction(sp.id, { action: 'give', target: 'new_scarf', args: { to: 'rin' } });
  mem.closeSession(sp.id);
  await mem.idle(sp.id);
  const m = mem.memory(sp.id, 'rin');
  assert.ok(m.facts.some(f => f.evidence.includes('红杯子')));
  assert.ok(m.facts.some(f => f.object.includes('新围巾')));
  assert.ok(m.episodes.length >= 1);
  mem.syncClock(sp.id, T0 - 1000);
  assert.ok(mem.getSpace(sp.id).clock > T0, 'syncClock never goes back');
  mem.deleteSpace(sp.id);
  assert.equal(mem.listSpaces().length, 0);
  const left = mem.lab.db.prepare('SELECT count(*) n FROM events WHERE save_id = ?').get(sp.id).n;
  assert.equal(left, 0);
  await assert.rejects(readFile(path.join(dataDir, 'spaces', sp.id, 'scene.json')));
  await done();
});

test('host events: allowed types go in with seq and text; model-only types are refused', async () => {
  const { mem, done } = await fresh();
  const sp = mem.createSpace({ scene, now: T0 });
  await mem.openSession(sp.id);
  const ev = mem.recordEvent(sp.id, { type: 'object_changed', actor: 'host', target: 'lamp', payload: { field: 'state.on', from: false, to: true } }).events[0];
  assert.ok(ev.seq > 0 && ev.text);
  assert.throws(() => mem.recordEvent(sp.id, { type: 'char_said', actor: 'rin', payload: { text: '我是AI', to: 'user', used: [], proactive: false } }), e => e.code === 'BAD_EVENT');
  assert.throws(() => mem.recordEvent(sp.id, { type: 'object_changed', actor: 'host', target: 'lamp', payload: {} }), e => e.code === 'BAD_EVENT');
  assert.equal(mem.world(sp.id).objects.lamp.state.on, true);
  await done();
});

test('forget from the memory panel: propose → confirm → reported, and the words are gone', async () => {
  const { mem, done } = await fresh();
  const sp = mem.createSpace({ scene, now: T0 });
  await mem.openSession(sp.id);
  mem.lab.llm.mock.enqueue('reply', { say: '嗯嗯。', action: null, used: [], self_claims: [] }); // the default mock echoes the input
  const said = (await mem.chat(sp.id, 'rin', '我喜欢豆豆布丁')).events.find(e => e.type === 'user_said');
  await mem.idle(sp.id);
  const fact = mem.memory(sp.id, 'rin').facts.find(f => f.evidence.includes('豆豆'));
  assert.ok(fact);
  assert.equal(fact.ref, `fact:${fact.id}`);
  const job = await mem.proposeForget(sp.id, 'rin', { verb: 'delete', refs: [fact.ref, `ev:${said.seq}`] }); // the fact and the words it came from
  const after = await mem.confirmForget(job.id);
  assert.equal(after.state, 'reported');
  assert.ok(!mem.memory(sp.id, 'rin').facts.some(f => f.status === 'active' && f.evidence.includes('豆豆')));
  const rows = mem.lab.db.prepare("SELECT count(*) n FROM events WHERE save_id = ? AND payload_json LIKE '%豆豆%'").get(sp.id).n;
  assert.equal(rows, 0);
  await done();
});

test('updateScene: a new piece of furniture can be used; old memories stay', async () => {
  const { mem, done } = await fresh();
  const sp = mem.createSpace({ scene, now: T0 });
  await mem.openSession(sp.id);
  await mem.chat(sp.id, 'rin', '这个红杯子是我奶奶留下的');
  await mem.idle(sp.id);
  const next = structuredClone(scene);
  next.objects.push({ id: 'bookshelf', name: '书架', room: 'room', pos: [-3, 1, -3], tags: ['surface'] });
  mem.updateScene(sp.id, next);
  assert.ok(mem.world(sp.id).objects.bookshelf);
  assert.ok(mem.memory(sp.id, 'rin').facts.some(f => f.evidence.includes('红杯子')));
  await done();
});

test('HTTP: serve prints the port; health, space, chat, memory, errors and the token all work', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uyi-memory-http-'));
  await writeFile(path.join(dir, '.env'), '', { mode: 0o600 });
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'bin/uyi-memory.mjs', 'serve', '--port', '0', '--data', dir], {
    cwd: root, env: { PATH: process.env.PATH, HOME: dir, LLM_PROVIDER: 'mock', LAB_QUIET: '1', UYI_MEMORY_TOKEN: 'secret' }, stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    const port = await new Promise((resolve, reject) => {
      let out = '', err = '';
      const t = setTimeout(() => reject(new Error(`no ready line\n${out}\n${err}`)), 15000);
      child.stderr.on('data', c => { err += c; });
      child.stdout.on('data', c => { out += c; const line = out.split('\n')[0]; try { const j = JSON.parse(line); clearTimeout(t); resolve(j.port); } catch { /* wait */ } });
    });
    const call = async (method, p, body, token = 'secret') => {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, json: await r.json() };
    };
    assert.equal((await call('GET', '/v1/health', null, null)).status, 401);
    const h = await call('GET', '/v1/health');
    assert.equal(h.json.ok, true); assert.equal(h.json.api, 1); assert.equal(h.json.provider, 'mock');
    const sp = (await call('POST', '/v1/spaces', { name: 'http', scene, now: T0 })).json;
    assert.ok(sp.id);
    await call('POST', `/v1/spaces/${sp.id}/session/open`, {});
    const c = await call('POST', `/v1/spaces/${sp.id}/chat`, { character: 'rin', text: '我叫小林' });
    assert.equal(c.status, 200); assert.ok(c.json.say);
    assert.equal((await call('POST', `/v1/turns/${c.json.turnId}/delivered`, {})).json.ok, true);
    const m = await call('GET', `/v1/spaces/${sp.id}/characters/rin/memory`);
    assert.ok(Array.isArray(m.json.facts));
    const bad = await call('POST', `/v1/spaces/${sp.id}/chat`, { character: 'ghost', text: 'hi' });
    assert.equal(bad.status, 400); assert.equal(bad.json.error.code, 'NO_CHARACTER');
    assert.equal((await call('GET', '/v1/spaces/nope')).status, 404);
    assert.equal((await call('GET', '/v1/nothing')).status, 404);
  } finally {
    child.kill('SIGTERM');
    await new Promise(r => child.once('exit', r));
    await rm(dir, { recursive: true, force: true });
  }
});
