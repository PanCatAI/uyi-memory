import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { startSandbox } from './helpers/sandbox.mjs';

let sb, save;
/** The smallest complete binary glTF 2.0: header + one JSON chunk with one (empty) mesh. */
export function minimalGlb(json = { asset: { version: '2.0' }, meshes: [{ primitives: [] }] }) {
  let text = JSON.stringify(json);
  while (text.length % 4) text += ' ';
  const chunk = Buffer.from(text, 'utf8');
  const head = Buffer.alloc(20);
  head.write('glTF', 0, 'latin1'); head.writeUInt32LE(2, 4); head.writeUInt32LE(20 + chunk.length, 8);
  head.writeUInt32LE(chunk.length, 12); head.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([head, chunk]);
}
before(async () => { sb = await startSandbox(); save = (await sb.post('/api/saves', { name: '接口测试' })).body; });
after(async () => { await sb?.stop(); });

test('save → session → chat → events → turn', async () => {
  assert.equal((await sb.post('/api/session', { save: save.id, op: 'start' })).status, 200);
  const r = await sb.post('/api/chat', { save: save.id, character: 'rin', text: '我叫美林', compare: true });
  assert.equal(r.status, 200);
  assert.match(r.body.reply.say, /mock/);
  assert.ok(r.body.compare.full && r.body.compare.none);
  assert.equal((await sb.post('/api/delivered', { turnId: r.body.turnId })).body.ok, true);
  const evs = (await sb.get(`/api/events?save=${save.id}`)).body;
  assert.deepEqual(evs.map(e => e.type), ['session_start', 'user_said', 'char_said']);
  assert.equal(evs[1].text, '我叫美林');
  const t = (await sb.get(`/api/turns/${r.body.turnId}`)).body;
  assert.ok(t.sections.some(s => s.name === 'input'));
  const st = (await sb.get(`/api/state?save=${save.id}`)).body;
  assert.equal(st.save.session_open, true);
  assert.equal(st.world.characters.rin.room, 'cabin');
});

test('act, time, memory, usage', async () => {
  const a = await sb.post('/api/act', { save: save.id, action: 'build', target: 'stairs', args: { room: 'lighthouse' } });
  assert.deepEqual(a.body.events.map(e => e.type), ['user_action', 'object_created']);
  assert.equal((await sb.post('/api/act', { save: save.id, action: 'build', target: 'stairs', args: { room: 'lighthouse' } })).status, 400);
  const t = await sb.post('/api/time', { save: save.id, advance: '1d' });
  assert.deepEqual(t.body.events.map(e => e.type), ['session_end', 'time_skip']);
  const m = (await sb.get(`/api/memory?save=${save.id}&character=rin`)).body;
  assert.equal(m.facts[0].object, '美林');
  assert.equal(m.relationship.talks, 1);
  assert.ok((await sb.get(`/api/usage?save=${save.id}`)).body.total.calls >= 3);
});

test('manual forget from the inspector', async () => {
  const m = (await sb.get(`/api/memory?save=${save.id}&character=rin`)).body;
  const job = (await sb.post('/api/forget', { save: save.id, character: 'rin', verb: 'forget', refs: [`fact:${m.facts[0].id}`] })).body;
  assert.equal(job.state, 'proposed');
  assert.equal((await sb.post(`/api/forget/${job.id}/confirm`)).body.state, 'reported');
  assert.equal((await sb.get(`/api/memory?save=${save.id}&character=rin`)).body.facts[0].status, 'forgotten');
});

test('settings never return the key; key goes to the env file with mode 600', async () => {
  const s = (await sb.post('/api/settings', { apiKey: 'sk-zzzz-secret-9876', model: 'deepseek-flash' })).body;
  assert.equal(s.keySet, true);
  assert.equal(s.keyMasked, '••••9876');
  assert.doesNotMatch(JSON.stringify(s), /secret/);
  const file = path.join(sb.dir, '.env');
  assert.match(await readFile(file, 'utf8'), /LLM_API_KEY=sk-zzzz-secret-9876/);
  assert.equal((await sb.post('/api/settings', { extraBody: '{bad' })).status, 400);
  assert.equal((await sb.post('/api/settings/test')).body.ok, true); // mock provider from the sandbox: no network
});

test('scenarios run over http', async () => {
  const list = (await sb.get('/api/scenarios')).body;
  assert.equal(list.length, 16); // was 7; R9 added six 体验路径 scenarios (path-*), 2.0 B7 added s1-sword, C6 s2-cup, 3.0 G5 s3-wind; the original seven are unchanged
  for (const id of ['lighthouse', 'new-clothes', 'red-cup', 'suppress', 'trust-forget', 'trust-name', 'trust-secret', 's1-sword']) assert.ok(list.some(x => x.id === id), id);
  const run = (await sb.post('/api/scenarios/red-cup/run', { provider: 'mock' })).body;
  assert.equal(run.state, 'passed');
  const stepper = (await sb.post('/api/scenarios/trust-name/run', { provider: 'mock', step: true })).body;
  const next = (await sb.post(`/api/scenario-runs/${stepper.id}/step`)).body;
  assert.equal(next.step, 1);
});

test('errors are json and in Chinese', async () => {
  const r = await sb.post('/api/chat', { save: 'nope', character: 'rin', text: 'x' });
  assert.equal(r.status, 404);
  assert.equal(r.body.error.message, '没有这个存档。');
});

test('GLB import: upload, list, serve, reject non-glb, not in the ledger', async () => {
  const s = (await sb.post('/api/saves', { name: 'GLB' })).body;
  const glb = minimalGlb(); // was a 20-byte header-only fake; uploads are now checked for a complete glTF 2.0
  const put = (id, body) => fetch(`${sb.base}/api/assets/${s.id}/${id}`, { method: 'PUT', body });
  const ok = await put('red_cup', glb);
  assert.equal(ok.status, 200);
  assert.equal((await put('red_cup', Buffer.from('not a model'))).status, 400);
  assert.equal((await put('nothing_here', glb)).status, 400);
  const list = (await sb.get(`/api/assets?save=${s.id}`)).body;
  assert.deepEqual(list.map(a => a.id), ['red_cup']);
  const file = await sb.get(list[0].url);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'model/gltf-binary');
  assert.equal(file.body.length, glb.length);
  assert.equal((await sb.get(`/api/events?save=${s.id}`)).body.length, 0);
  assert.equal((await sb.get(`/api/assets/${s.id}/..%2F..%2Flab.sqlite`)).status, 404);
  await sb.del(`/api/saves/${s.id}`);
  assert.equal((await sb.get(list[0].url)).status, 404);
});

test('UI files are served', async () => {
  for (const f of ['/', '/app.js', '/inspector.js', '/chat.js', '/scene3d.js', '/api.js', '/styles.css', '/vendor/three/build/three.module.js', '/vendor/three/examples/jsm/loaders/GLTFLoader.js']) assert.equal((await sb.get(f)).status, 200, f);
});

test('one scenario request id → one run and one save over http, even when sent twice at once', async () => {
  const before = (await sb.get('/api/saves')).body.length;
  const body = { provider: 'mock', requestId: 'http-dedupe-1' };
  const [a, b] = await Promise.all([sb.post('/api/scenarios/suppress/run', body), sb.post('/api/scenarios/suppress/run', body)]);
  assert.equal(a.body.id, b.body.id);
  assert.equal((await sb.post('/api/scenarios/suppress/run', body)).body.id, a.body.id);
  assert.equal((await sb.get('/api/saves')).body.length, before + 1);
  assert.equal((await sb.get(`/api/scenario-runs/${a.body.id}`)).body.state, 'passed');
});

test('usage separates logical calls from attempts and never prices mock tokens', async () => {
  const u = (await sb.get(`/api/usage?save=${save.id}`)).body;
  assert.ok(u.total.logical >= 1 && u.total.logical <= u.total.calls);
  assert.equal(u.total.unpriced, u.total.calls);
  assert.ok(u.rows.every(r => r.usage_unknown === r.calls));
  assert.ok(u.rows.every(r => r.cache_reported === 0 && 'cache_input' in r), 'mock never reports cache hits (2.0 C7)');
});

test('job runs and retry over http', async () => {
  const runs = (await sb.get(`/api/jobs?save=${save.id}`)).body;
  assert.ok(Array.isArray(runs));
  const r = await sb.post('/api/jobs/retry', { save: save.id });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body));
  assert.equal((await sb.post('/api/jobs/retry', { save: save.id, id: 'jr_nope' })).status, 400);
});

test('GLB upload: truncated, wrong version, no mesh are refused with a reason and keep the working model', async () => {
  const s = (await sb.post('/api/saves', { name: 'GLB 坏文件' })).body;
  const put = body => fetch(`${sb.base}/api/assets/${s.id}/rin`, { method: 'PUT', body }).then(async r => ({ status: r.status, body: await r.json() }));
  const good = minimalGlb();
  assert.equal((await put(good)).status, 200);
  const truncated = good.subarray(0, good.length - 4);
  const v1 = Buffer.from(good); v1.writeUInt32LE(1, 4);
  const noMesh = minimalGlb({ asset: { version: '2.0' } });
  for (const [bad, re] of [[truncated, /不完整/], [v1, /2\.0/], [noMesh, /网格/], [Buffer.from('hello'), /不是 \.glb/]]) {
    const r = await put(bad);
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, re);
  }
  const served = await sb.get(`/api/assets/${s.id}/rin.glb`);
  assert.equal(served.status, 200);
  assert.equal(Buffer.compare(served.body, good), 0); // the working model is still the one served
});

test('GLB upload: a mesh pointing at missing vertex data is refused', async () => {
  const s = (await sb.post('/api/saves', { name: 'GLB 引用' })).body;
  const glb = minimalGlb({ asset: { version: '2.0' }, meshes: [{ primitives: [{ attributes: { POSITION: 3 } }] }] });
  const r = await fetch(`${sb.base}/api/assets/${s.id}/rin`, { method: 'PUT', body: glb });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error.message, /不存在的顶点数据/);
});

test('turn groups, run history and run export over http; the export never contains the key', async () => {
  const groups = (await sb.get(`/api/turn-groups?save=${save.id}&character=rin`)).body;
  assert.ok(groups.length >= 1 && groups[0].modes.memory);
  const runs = (await sb.get('/api/scenario-runs')).body;
  assert.ok(runs.length >= 1 && runs[0].summary);
  const ex = await sb.get(`/api/scenario-runs/${runs[0].id}/export`);
  assert.equal(ex.status, 200);
  assert.ok(ex.body.versions && ex.body.run.id === runs[0].id);
  assert.doesNotMatch(JSON.stringify(ex.body), /secret|sk-zzzz/); // a key was saved in an earlier test
  assert.equal((await sb.get('/api/scenario-runs/r_nope/export')).status, 404);
});

test('card versions: bad card is 400 with a line number, save bumps the version, turns record it, restore', async () => {
  const camp = (await sb.post('/api/saves', { name: '设定页', sceneId: 'camp' })).body;
  const base = `/api/saves/${camp.id}/characters/lan/card`;
  const v0 = (await sb.get(base)).body;
  assert.equal(v0.version, 0);
  assert.match(v0.text, /^# 岚/);
  const bad = await sb.put(base, { text: v0.text.replace('- 05:30–08:00｜', '- 05:30–09:00｜'), note: '坏的' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error.message, /^第 \d+ 行：作息时间段重叠/);
  assert.equal((await sb.get(base)).body.version, 0, 'a bad card is not saved');
  const good = await sb.put(base, { text: v0.text.replace('深色短发', '深色齐耳短发'), note: '改发型' });
  assert.equal(good.status, 200);
  assert.equal(good.body.version, 1);
  await sb.post('/api/session', { save: camp.id, op: 'start' });
  const r = await sb.post('/api/chat', { save: camp.id, character: 'lan', text: '你好' });
  const t = (await sb.get(`/api/turns/${r.body.turnId}`)).body;
  assert.equal(t.card_version, 1);
  assert.match(t.prompt[0].content, /深色齐耳短发/, 'the system prompt uses the new version');
  const back = await sb.post(`${base}/restore`, { version: 0 });
  assert.equal(back.body.version, 2);
  assert.equal(back.body.text, v0.text);
  const list = (await sb.get(`${base}/versions`)).body;
  assert.deepEqual(list.map(v => v.version), [0, 1, 2]);
  assert.equal(list[2].hash, list[0].hash);
  assert.equal(list[2].note, '恢复为第 0 版');
  assert.equal((await sb.get(`/api/saves/${camp.id}/characters/nobody/card`)).status, 400);
});

test('2.0 D1: tick moves a camp session 5 world minutes and her 作息 shows up; no session → skipped', async () => {
  const camp = (await sb.post('/api/saves', { name: '作息', sceneId: 'camp' })).body;
  assert.equal((await sb.post(`/api/saves/${camp.id}/tick`, {})).body.skipped, 'no_session');
  await sb.post('/api/session', { save: camp.id, op: 'start' });
  const r = (await sb.post(`/api/saves/${camp.id}/tick`, {})).body;
  assert.equal(r.skipped, null);
  assert.equal(r.clockText.slice(-5), '09:05');
  assert.ok(r.events.some(e => e.payload?.routine && e.action === 'draw_map'), JSON.stringify(r.events.map(e => e.action)));
  const st = (await sb.get(`/api/state?save=${camp.id}`)).body;
  assert.equal(st.life.lan.doing, '坐在长凳上画图');
});

test('2.0 D9: a playtest note is kept with its world day, blank is skipped, and the 关系 data lists it', async () => {
  const camp = (await sb.post('/api/saves', { name: '试玩', sceneId: 'camp' })).body;
  assert.equal((await sb.post(`/api/saves/${camp.id}/playtest-notes`, { text: '  ' })).body.note, null);
  const r = (await sb.post(`/api/saves/${camp.id}/playtest-notes`, { text: '她自己去画图了，挺像在过日子。' })).body;
  assert.deepEqual(r.note, { day: '2026-10-20', text: '她自己去画图了，挺像在过日子。' });
  const m = (await sb.get(`/api/memory?save=${camp.id}&character=lan`)).body;
  assert.deepEqual(m.playtestNotes.map(n => n.text), ['她自己去画图了，挺像在过日子。']);
});

test('3.0 E4: saves made over http get every 3.0 feature; PUT turns one off; direct saves have none', async () => {
  const s = (await sb.post('/api/saves', { name: '开关', sceneId: 'camp' })).body;
  let f = (await sb.get(`/api/saves/${s.id}/features`)).body.features;
  assert.deepEqual(f, { voice: true, world: true, director: true, topics: true, scout: true, practices: true, pace: '起伏' });
  f = (await sb.put(`/api/saves/${s.id}/features`, { voice: false, pace: '平静' })).body.features;
  assert.equal(f.voice, false);
  assert.equal(f.pace, '平静');
  assert.equal(f.world, true);
  const lab = (await import('../lib/lab.mjs')).createLab();
  const direct = lab.saves.createSave({ name: '直接' });
  assert.deepEqual(Object.values(lab.features(direct.id)).filter(v => v === true), []);
});
