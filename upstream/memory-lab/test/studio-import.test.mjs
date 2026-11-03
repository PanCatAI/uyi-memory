// 2.0 C1: import from 造物台 against a fake /api/state (test/fixtures/studio/) and tiny GLBs. Never touches the real studio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLab } from '../lib/lab.mjs';
import { buildScene, catalog, fetchState, importStudio, StudioError, FILLERS } from '../lib/studio-import.mjs';
import { rawScene, inRoom } from '../lib/scene.mjs';
import { startSandbox } from './helpers/sandbox.mjs';
import { fixtureState, fixtureStudio, tinyGlb } from '../lib/studio-fixture.mjs';

process.env.LAB_QUIET = '1';
const fixture = fixtureState;
const SCENE = 'scene-769405f4';

test('an animation file whose SHA256 differs from the studio record is refused', async () => {
  const t = await setup();
  try {
    const state = fixture(1);
    state.animations.find(a => a.seedKey === 'UAL').sha256 = '0'.repeat(64);
    await assert.rejects(importStudio(t.lab, { saveId: t.saveId, sceneAssetId: SCENE, base: 'http://x', assetsDir: t.assetsDir, fetchImpl: fakeStudio(state).fetchImpl }), /SHA256/);
    assert.equal(existsSync(t.lab.sceneFile(t.saveId)), false, 'nothing is written');
  } finally { await t.done(); }
});

const fakeStudio = state => fixtureStudio(0, state);
async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'studio-import-'));
  const lab = createLab({ savesDir: path.join(dir, 'saves') });
  const saveId = lab.saves.createSave({ name: '营地', sceneId: 'camp' }).id;
  return { dir, lab, saveId, assetsDir: path.join(dir, 'assets'), done: () => rm(dir, { recursive: true, force: true }) };
}

test('catalog lists layout scenes, characters with a model, and the UAL libraries', () => {
  const c = catalog(fixture(1));
  assert.deepEqual(c.scenes.map(s => s.name).sort(), ['P9 演示', '篝火营地 v2'].sort());
  assert.ok(c.characters.some(x => x.id === 'char-scout' && x.name === '岚 · 探索者'));
  assert.deepEqual(c.animations.filter(a => a.ual).map(a => a.id).sort(), ['68048601-673', 'cac4d5b9-820']);
});

test('a closed studio says 请先打开造物台', async () => {
  await assert.rejects(fetchState('http://127.0.0.1:9', async () => { throw new TypeError('fetch failed'); }), e => e instanceof StudioError && /请先打开造物台/.test(e.message));
});

test('mapping: seats, tent, fire, props, fillers and the four areas follow the C1 table', () => {
  const { scene, downloads } = buildScene(rawScene('camp'), fixture(1), { sceneAssetId: SCENE, chars: { lan: 'char-scout' } });
  const o = id => scene.objects.find(x => x.id === id);
  const room = id => scene.rooms.find(r => r.id === id);
  // Areas.
  assert.deepEqual(room('tent').box, [-1.5, -3.4, 1.1, -1.1]);
  assert.deepEqual(room('path').poly, [[-0.65, 2.55], [0.6, 2.55], [0.6, 4], [-0.65, 4]]);
  assert.ok(room('fireside').poly.every(([, z]) => z >= -1 && z <= 2.55), 'fireside is cut at the supply corner and the path');
  assert.equal(room('fireside').group, 'open');
  assert.equal(room('tent').exit_to, 'fireside');
  for (const [x, z, id] of [[0, 0.45, 'fireside'], [-2, 1.1, 'fireside'], [2.4, -1.65, 'supply'], [0, 3.5, 'path'], [-0.2, -2.25, 'tent']]) assert.ok(inRoom(scene, id, x, z), `${x},${z} in ${id}`);
  // Objects keep camp.json ids and gain the mapped tags.
  assert.ok(o('campfire-1').tags.includes('fire'));
  assert.equal(o('campfire-1').state.lit, true);
  assert.ok(o('tent-1').tags.includes('enterable'));
  assert.equal(o('tent-1').leads_to, 'tent');
  for (const id of ['log-bench-1', 'log-bench-2']) {
    const b = o(id);
    assert.ok(b.tags.includes('sittable'));
    assert.equal(b.sit[1], 0.42);
    assert.ok(Math.abs(Math.hypot(b.sit[0] - b.pos[0], b.sit[2] - b.pos[2]) - 0.1) < 0.002, 'sit point is 0.1 m forward');
    const toFire = Math.hypot(0 - b.sit[0], 0.45 - b.sit[2]) < Math.hypot(0 - b.pos[0], 0.45 - b.pos[2]);
    assert.ok(toFire, `${id} faces the fire`);
  }
  assert.ok(o('lantern-1').tags.includes('portable') && o('lantern-1').tags.includes('switchable'));
  assert.deepEqual(o('cup').tags.sort(), ['cleanable', 'portable']);
  assert.equal(o('sword').worn_by, 'lan');
  assert.ok(o('backpack'));
  assert.equal(o('wood-crate-1').room, 'supply');
  assert.match(o('campfire-1').model, /^studio\/.+\.glb$/);
  // Fillers and the other studio character only show up as decor / not at all.
  assert.ok(!scene.objects.some(x => FILLERS.includes(x.studio?.spec)));
  assert.ok(scene.studio.decor.length >= 6 && scene.studio.decor.every(d => FILLERS.includes(d.kind)));
  assert.ok(!scene.objects.some(x => /银羽/.test(x.name)));
  // 岚, the environment and the two UAL libraries are downloaded.
  const lan = scene.characters.find(c => c.id === 'lan');
  assert.equal(lan.studio.asset, 'char-scout');
  assert.equal(lan.model, 'studio/c2c348e2-d2d0-4a8b-ac54-c0517261b2c9.glb');
  assert.equal(scene.studio.env_model, 'studio/06261bc4-af85-43c9-9f60-1648c0049ca8.glb');
  assert.deepEqual(scene.studio.animations.map(a => a.set), ['UAL', 'UAL2']);
  assert.ok(scene.studio.animations[0].clips.includes('Sitting_Idle_Loop'));
  const paths = downloads.map(d => d.path);
  for (const p of [lan.model, scene.studio.env_model, ...scene.studio.animations.map(a => a.model), o('log-bench-1').model]) assert.ok(paths.includes(p), p);
  assert.ok(!paths.some(p => p.endsWith('.fbx')), 'only GLB animation libraries');
});

test('import writes the save scene, files with SHA256 and one scene_imported; the same fixture twice changes nothing', async () => {
  const t = await setup();
  try {
    const studio = fakeStudio(fixture(1));
    const args = { saveId: t.saveId, sceneAssetId: SCENE, chars: { lan: 'char-scout' }, base: 'http://127.0.0.1:4320', assetsDir: t.assetsDir, fetchImpl: studio.fetchImpl };
    const first = await importStudio(t.lab, args);
    assert.equal(first.changed, true);
    assert.ok(studio.calls.every(c => c.method === 'GET'), 'only GET requests reach the studio');
    for (const f of first.files) {
      assert.match(f.sha256, /^[0-9a-f]{64}$/);
      assert.ok(existsSync(path.join(t.assetsDir, t.saveId, f.path)), f.path);
    }
    const sceneFile = t.lab.sceneFile(t.saveId);
    const text = await readFile(sceneFile, 'utf8');
    const scene = t.lab.scene(t.saveId);
    assert.equal(scene.studio.scene_asset_id, SCENE);
    assert.ok(scene.characters[0].card, 'cards still load for an imported scene');
    // World state: no filler, the fire is lit, the imported benches are there.
    const world = t.lab.ledger.world(t.saveId);
    assert.ok(!Object.keys(world.objects).some(id => FILLERS.some(f => id.startsWith(f))));
    assert.equal(world.objects['campfire-1'].state.lit, true);
    assert.ok(world.objects['log-bench-2']);
    const evs = () => t.lab.ledger.list(t.saveId, { all: true }).filter(e => e.type === 'scene_imported');
    assert.equal(evs().length, 1);
    assert.deepEqual(evs()[0].payload.files.map(f => f.path), first.files.map(f => f.path));

    const again = await importStudio(t.lab, args);
    assert.equal(again.changed, false);
    assert.equal(await readFile(sceneFile, 'utf8'), text);
    assert.deepEqual(again.files, first.files);
    assert.equal(evs().length, 1, 'no second event for an identical import');

    // Another save that was never imported keeps using scenes/camp.json.
    const other = t.lab.saves.createSave({ name: '没导入', sceneId: 'camp' }).id;
    assert.equal(t.lab.scene(other).studio, undefined);
  } finally { await t.done(); }
});

test('a new studio object (third bench) keeps the studio id and lands in its area', async () => {
  const t = await setup();
  try {
    await importStudio(t.lab, { saveId: t.saveId, sceneAssetId: SCENE, base: 'http://x', assetsDir: t.assetsDir, fetchImpl: fakeStudio(fixture(2)).fetchImpl });
    const b = t.lab.scene(t.saveId).objects.find(o => o.id === 'log-bench-3');
    assert.equal(b.room, 'fireside');
    assert.ok(b.tags.includes('sittable'));
    assert.ok(b.sit[2] < b.pos[2], 'the south bench faces north, toward the fire');
  } finally { await t.done(); }
});

test('HTTP: catalog and import go through the server; a closed studio is a readable 400', async () => {
  const state = fixture(1);
  const methods = [];
  const fake = http.createServer((req, res) => {
    methods.push(req.method);
    if (req.url === '/api/state') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(state)); }
    const m = /^\/files\/(models|anims)\/(.+)$/.exec(req.url);
    if (m) return res.end(tinyGlb(m[2]));
    res.statusCode = 404; res.end();
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const sb = await startSandbox({ extraEnv: { LAB_STUDIO_URL: `http://127.0.0.1:${fake.address().port}` } });
  const closed = await startSandbox({ extraEnv: { LAB_STUDIO_URL: 'http://127.0.0.1:9' } });
  try {
    const cat = await sb.get('/api/studio/catalog');
    assert.equal(cat.status, 200);
    assert.ok(cat.body.scenes.some(s => s.id === SCENE));
    const save = (await sb.post('/api/saves', { name: '营地', sceneId: 'camp' })).body;
    const r = await sb.post(`/api/saves/${save.id}/import-studio`, { scene: SCENE, characters: { lan: 'char-scout' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.changed, true);
    const st = (await sb.get(`/api/state?save=${save.id}`)).body;
    assert.equal(st.scene.studio.scene_asset_id, SCENE);
    const glb = await sb.get(`/api/assets/${save.id}/${st.scene.characters[0].model}`);
    assert.equal(glb.status, 200);
    assert.equal(glb.body.toString('latin1', 0, 4), 'glTF');
    assert.ok(methods.every(m => m === 'GET'));
    const bad = await closed.get('/api/studio/catalog');
    assert.equal(bad.status, 400);
    assert.match(bad.body.error.message, /请先打开造物台/);
  } finally { await sb.stop(); await closed.stop(); fake.close(); }
});

// ---- 2.0 C2: re-import writes what changed as world_edit by the user-as-creator ----
async function importedTwice({ open = true, tweak = () => {}, before = () => {} } = {}) {
  const t = await setup();
  const args = state => ({ saveId: t.saveId, sceneAssetId: SCENE, base: 'http://x', assetsDir: t.assetsDir, fetchImpl: fakeStudio(state).fetchImpl });
  await importStudio(t.lab, args(fixture(1)));
  if (open) await t.lab.session.start(t.saveId);
  before(t);
  const v2 = fixture(2);
  tweak(v2.assets.find(a => a.id === SCENE).layout.items);
  const out = await importStudio(t.lab, args(v2));
  const edits = t.lab.ledger.list(t.saveId, { types: ['world_edit'], all: true });
  return { ...t, out, edits };
}
const ctx = async (t, text = '嗯') => {
  const r = await t.lab.turns.runTurn({ saveId: t.saveId, charId: 'lan', text });
  const turn = t.lab.db.prepare('SELECT sections_json FROM turns WHERE id = ?').get(r.turnId);
  const sections = JSON.parse(turn.sections_json);
  return { r, get: n => sections.find(s => s.name === n) };
};

test('C2: a third bench in the second layout is one world_edit add, seen, in the world section, offered once', async () => {
  const t = await importedTwice();
  try {
    assert.equal(t.edits.length, 1);
    const e = t.edits[0];
    assert.equal(e.actor, 'user');
    assert.deepEqual([e.payload.op, e.target, e.payload.by], ['add', 'log-bench-3', 'creator']);
    assert.ok(e.perceivers.includes('lan'), '岚 is at the fire with the session on: she sees it');
    assert.ok(t.lab.ledger.world(t.saveId).objects['log-bench-3'].tags.includes('sittable'));
    assert.ok(!t.lab.scene(t.saveId).objects.some(o => o.id === 'log-bench-3'), 'the save scene keeps the first import as the starting world');
    const one = await ctx(t);
    assert.match(one.get('world').text, /长凳/);
    const hint = one.get('hints');
    assert.ok(hint.refs.includes(`ev:${e.seq}`), JSON.stringify(hint));
    assert.match(hint.text, /新搭的东西/);
    t.lab.proactive.recordDelivered(one.r.turnId);
    // Past the 5-turn proactive cap, it still never comes back.
    for (let i = 0; i < 6; i++) await ctx(t, `第${i}句`);
    const later = await ctx(t);
    assert.ok(!(later.get('hints')?.refs || []).includes(`ev:${e.seq}`));
  } finally { await t.done(); }
});

test('C2: built while the session was off, she learns it when she is there: "之前没有"', async () => {
  const t = await importedTwice({ open: false });
  try {
    assert.deepEqual(t.edits[0].perceivers, []);
    await t.lab.session.start(t.saveId);
    const one = await ctx(t);
    assert.match(one.get('world').text, /多了原木长凳，之前没有/);
    assert.ok(one.get('hints').refs.includes(`ev:${t.edits[0].seq}`));
  } finally { await t.done(); }
});

test('C2: inside the walled tent she neither sees nor knows about it', async () => {
  const t = await importedTwice({ before: s => {
    s.lab.ledger.append(s.saveId, { type: 'char_action', actor: 'lan', action: 'enter', target: 'tent-1', outcome: 'ok', payload: { args: {} } });
  } });
  try {
    assert.equal(t.lab.ledger.world(t.saveId).characters.lan.room, 'tent');
    assert.ok(!t.edits[0].perceivers.includes('lan'));
    const one = await ctx(t);
    assert.doesNotMatch(one.get('world').text, /长凳/);
    assert.ok(!(one.get('hints')?.refs || []).includes(`ev:${t.edits[0].seq}`));
  } finally { await t.done(); }
});

test('C2: moved more than 0.3 m is a move, less is nothing; gone from the studio is a remove', async () => {
  const t = await importedTwice({ tweak: items => {
    items.find(i => i.id === 'barrel-1').position[0] += 0.5;
    items.find(i => i.id === 'wood-crate-1').position[0] += 0.1;
    items.splice(items.findIndex(i => i.id === 'log-bench-2'), 1);
  } });
  try {
    const ops = t.edits.map(e => `${e.payload.op}:${e.target}`).sort();
    assert.deepEqual(ops, ['add:log-bench-3', 'move:barrel-1', 'remove:log-bench-2']);
    const w = t.lab.ledger.world(t.saveId);
    assert.equal(w.objects['log-bench-2'], undefined);
    assert.equal(w.objects['barrel-1'].pos[0], 2.9);
    assert.equal(w.objects['wood-crate-1'].pos[0], 1.65);
    // The same layout once more: nothing new.
    const again = await importStudio(t.lab, { saveId: t.saveId, sceneAssetId: SCENE, base: 'http://x', assetsDir: t.assetsDir, fetchImpl: fakeStudio((() => { const v = fixture(2); const it = v.assets.find(a => a.id === SCENE).layout.items; it.find(i => i.id === 'barrel-1').position[0] += 0.5; it.splice(it.findIndex(i => i.id === 'log-bench-2'), 1); return v; })()).fetchImpl });
    assert.equal(again.changed, false);
  } finally { await t.done(); }
});
