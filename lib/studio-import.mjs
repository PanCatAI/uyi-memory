// 2.0 C1: import a scene and a character from 造物台 (asset-forge) over its local read-only HTTP API.
// Only GET requests go to the studio. URL rules (asset-forge/server.mjs):
//   GET /api/state                → { assets, models, animations, ... }
//   GET /files/models/<model.file> → model GLB
//   GET /files/anims/<anim.file>   → animation library GLB
// Files land in <assetsDir>/<save>/studio/ with a SHA256 each; the scene goes to the save's own scene.json.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile, rename, readFile } from 'node:fs/promises';
import path from 'node:path';
import { rawScene, validateScene, inRoom } from './scene.mjs';
import { perceiversFor } from './perception.mjs';

export const STUDIO_PORT = 4320;
export const FILLERS = ['pine', 'boulder', 'small-rock', 'shrub', 'grass-flowers', 'pebbles'];
const SIT_FORWARD = 0.1, SIT_HEIGHT = 0.42, MOVE_MIN = 0.3;
const r3 = v => Math.round(v * 1000) / 1000;
const TRUNK = 0.4; // collision 'trunk' (pines): a small square at the foot

/** Collision footprint (造物台 collision box/trunk) as 4 corners relative to the item's position, rotated like the item. */
function footprint(it, spec) {
  if (!['box', 'trunk'].includes(it.collision)) return null;
  const size = it.collision === 'trunk' ? { w: TRUNK, d: TRUNK } : spec?.size;
  if (!size?.w || !size?.d) return null;
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => {
    const [x, , z] = rotate(it.rotation || [0, 0, 0], [(sx * size.w) / 2, 0, (sz * size.d) / 2]);
    return [r3(x), r3(z)];
  });
}

export class StudioError extends Error {}
export const studioBase = env => `http://127.0.0.1:${Number(env?.STUDIO_PORT) || STUDIO_PORT}`;

/** GET <base>/api/state; a closed studio is a readable StudioError, never a stack trace. */
export async function fetchState(base, fetchImpl = fetch) {
  let res;
  try { res = await fetchImpl(`${base}/api/state`, { signal: AbortSignal.timeout(5000) }); }
  catch { throw new StudioError('请先打开造物台（连不上 ' + base + '）。'); }
  if (!res.ok) throw new StudioError(`造物台返回 ${res.status}，请确认打开的是造物台。`);
  const state = await res.json().catch(() => null);
  if (!Array.isArray(state?.assets) || !Array.isArray(state?.models)) throw new StudioError('造物台的 /api/state 格式不认识。');
  return state;
}

/** What the import dialog lists: scene assets with a layout, characters with a current model, the animation libraries. */
export function catalog(state) {
  return {
    scenes: state.assets.filter(a => a.layout).map(a => ({ id: a.id, name: a.name, items: a.layout.items?.length || 0, updatedAt: a.layout.updatedAt || null })),
    characters: state.assets.filter(a => a.kind === 'character' && a.currentModelId).map(a => ({ id: a.id, name: a.name, modelId: a.currentModelId })),
    animations: (state.animations || []).filter(a => a.file).map(a => ({ id: a.id, name: a.name, format: a.format, clips: a.clips?.length || 0, ual: /^UAL/.test(a.seedKey || '') }))
  };
}

/** Euler XYZ (three.js default order) applied to a local unit vector; returns the world vector. */
function rotate([rx, ry, rz], [x, y, z]) {
  const c = Math.cos, s = Math.sin;
  [x, y] = [x * c(rz) - y * s(rz), x * s(rz) + y * c(rz)];
  [x, z] = [x * c(ry) + z * s(ry), -x * s(ry) + z * c(ry)];
  [y, z] = [y * c(rx) - z * s(rx), y * s(rx) + z * c(rx)];
  return [x, y, z];
}
/** Seat facing: of the item's local ±x/±z axes, the one pointing most toward the fire (the spec seats face the fire). */
function seatFacing(item, toward) {
  const d = [toward[0] - item.position[0], toward[1] - item.position[2]];
  const len = Math.hypot(...d) || 1;
  let best = null;
  for (const v of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
    const w = rotate(item.rotation || [0, 0, 0], v);
    const h = Math.hypot(w[0], w[2]) || 1;
    const dir = [w[0] / h, w[2] / h];
    const dot = (dir[0] * d[0] + dir[1] * d[1]) / len;
    if (!best || dot > best.dot) best = { dot, dir };
  }
  return best.dir;
}
// three.js yaw convention: facing degrees where 0 looks along +z.
const yawDeg = ([x, z]) => r3(((Math.atan2(x, z) * 180) / Math.PI + 360) % 360);

/** Sutherland–Hodgman against one horizontal line: keeps the side where keep(z) holds. */
function clipZ(poly, z0, keepAbove) {
  const inside = p => (keepAbove ? p[1] >= z0 : p[1] <= z0);
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if (inside(a)) out.push(a);
    if (inside(a) !== inside(b)) { const t = (z0 - a[1]) / (b[1] - a[1]); out.push([r3(a[0] + t * (b[0] - a[0])), z0]); }
  }
  return out.map(([x, z]) => [r3(x), r3(z)]);
}

/**
 * The B2 four areas from the studio's zones and paths:
 *   fireside = the walkable zone, cut at the supply corner's north edge and the path's start;
 *   supply   = the B2 polygon from the base scene (fixed numbers in the plan);
 *   tent     = the tent object's footprint from the layout spec;
 *   path     = the entry path's points widened 0.6 m on each side.
 */
function buildRooms(base, spec) {
  const rooms = base.rooms.map(r => ({ ...r }));
  const room = id => rooms.find(r => r.id === id);
  const supply = room('supply');
  const supplyNorth = supply ? Math.max(...(supply.poly || [[0, supply.box[1]], [0, supply.box[3]]]).map(p => p[1])) : null;
  const pathSpec = (spec?.paths || [])[0];
  if (pathSpec && room('path')) {
    const xs = pathSpec.points.map(p => p[0]), zs = pathSpec.points.map(p => p[1]);
    const [x0, x1, z0, z1] = [Math.min(...xs) - 0.6, Math.max(...xs) + 0.6, Math.min(...zs), Math.max(...zs)].map(r3);
    Object.assign(room('path'), { poly: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]] });
    delete room('path').box;
  }
  const walk = (spec?.zones || []).find(z => z.kind === 'walkable');
  if (walk && room('fireside')) {
    let poly = walk.polygon.map(p => [r3(p[0]), r3(p[1])]);
    if (supplyNorth != null) poly = clipZ(poly, supplyNorth, true);
    const pathStart = room('path')?.poly ? Math.min(...room('path').poly.map(p => p[1])) : null;
    if (pathStart != null) poly = clipZ(poly, pathStart, false);
    Object.assign(room('fireside'), { poly });
    delete room('fireside').box;
  }
  const tentSpec = (spec?.objects || []).find(o => o.interaction === 'enter');
  const tentInst = tentSpec?.instances?.[0];
  const tent = rooms.find(r => r.exit_to); // the walled room you enter
  if (tent && tentInst && tentSpec.size) {
    const { w, d } = tentSpec.size;
    tent.box = [tentInst.x - w / 2, tentInst.z - d / 2, tentInst.x + w / 2, tentInst.z + d / 2].map(r3);
    delete tent.poly;
  }
  return rooms;
}

const modelPath = m => `studio/${m.file}`;

/**
 * Pure mapping: studio state + chosen assets → { scene, downloads }. Deterministic for the same input.
 * base: the scenes/<id>.json object (raw). chars: { charId: studioAssetId }.
 */
export function buildScene(base, state, { sceneAssetId, chars = {} }) {
  const asset = state.assets.find(a => a.id === sceneAssetId && a.layout);
  if (!asset) throw new StudioError(`造物台里没有这个场景：${sceneAssetId}`);
  const models = new Map(state.models.map(m => [m.id, m]));
  const assets = new Map(state.assets.map(a => [a.id, a]));
  const spec = asset.layoutSpec || {};
  const specById = new Map((spec.objects || []).map(o => [o.id, o]));
  const isFiller = it => FILLERS.includes(it.specObjectId) || specById.get(it.specObjectId)?.category === 'filler';
  const isCharacter = it => assets.get(models.get(it.modelId)?.assetId)?.kind === 'character' || (!it.specObjectId && typeof it.clip === 'string');
  const downloads = new Map(); // path → { url, size, sha256? }
  const want = m => { if (!m?.file) return null; downloads.set(modelPath(m), { url: `/files/models/${encodeURIComponent(m.file)}`, size: m.size }); return modelPath(m); };

  const rooms = buildRooms(base, spec);
  const scene = { ...structuredClone(base), rooms };
  const roomFor = (x, z) => (rooms.find(r => inRoom({ rooms }, r.id, x, z)) || {}).id || base.user_room || rooms[0].id;
  const items = asset.layout.items || [];
  const fire = items.find(it => it.light === 'fire');
  const firePos = fire ? [fire.position[0], fire.position[2]] : [0, 0];
  const baseObjects = new Map(base.objects.map(o => [o.id, o]));
  const objects = [], decor = [], used = new Set();
  for (const it of items) {
    if (isCharacter(it)) continue;
    const m = models.get(it.modelId);
    const fp = footprint(it, specById.get(it.specObjectId));
    const place = { pos: it.position.map(r3), rot: (it.rotation || [0, 0, 0]).map(r3), scale: r3(it.scale ?? 1), ...(fp ? { footprint: fp } : {}) };
    if (isFiller(it)) { decor.push({ id: it.id, kind: it.specObjectId, model: want(m), ...place }); continue; }
    const old = baseObjects.get(it.id);
    const tags = new Set(old?.tags || []);
    const extra = {};
    if (it.interaction === 'seat') {
      tags.add('sittable');
      const dir = seatFacing(it, firePos);
      extra.facing = yawDeg(dir);
      extra.sit = [r3(it.position[0] + dir[0] * SIT_FORWARD), SIT_HEIGHT, r3(it.position[2] + dir[1] * SIT_FORWARD)];
    }
    if (it.interaction === 'enter') tags.add('enterable');
    if (it.interaction === 'pickup') tags.add('portable');
    if (it.light === 'fire') { tags.add('fire'); extra.state = { ...(old?.state || {}), lit: true }; }
    const obj = {
      ...(old || { id: it.id, name: it.name, room: roomFor(it.position[0], it.position[2]) }),
      ...place, ...extra, tags: [...tags],
      ...(m ? { model: want(m) } : {}),
      studio: { item: it.id, model: it.modelId || null, spec: it.specObjectId || null }
    };
    delete obj.shape_only;
    objects.push(obj);
    used.add(it.id);
  }
  // Props only memory-lab has (cup, backpack, sword) stay as they were; the cup is always cleanable.
  for (const o of base.objects) if (!used.has(o.id)) objects.push(structuredClone(o));
  for (const o of objects) if (o.id === 'cup' && o.tags.includes('portable') && !o.tags.includes('cleanable')) o.tags.push('cleanable');
  scene.objects = objects;

  // Characters: a studio character per scene character (chars map, or the asset whose name starts with the character's name).
  const characters = [];
  for (const c of scene.characters) {
    const a = assets.get(chars[c.id]) || state.assets.find(x => x.kind === 'character' && x.currentModelId && x.name.startsWith(c.name));
    const m = a && models.get(a.currentModelId);
    characters.push(m ? { ...c, model: want(m), studio: { asset: a.id, model: m.id } } : c);
  }
  scene.characters = characters;

  const animations = (state.animations || []).filter(a => a.file && a.format === 'glb' && /^UAL/.test(a.seedKey || ''))
    .sort((x, y) => x.seedKey.localeCompare(y.seedKey))
    .map(a => {
      const p = `studio/${a.file}`;
      downloads.set(p, { url: `/files/anims/${encodeURIComponent(a.file)}`, size: a.size, sha256: a.sha256 });
      return { id: a.id, name: a.name, set: a.seedKey, model: p, clips: a.clips || [] };
    });
  const env = models.get(asset.layout.envModelId);
  scene.studio = {
    source: 'studio', scene_asset_id: asset.id, scene_name: asset.name, layout_updated_at: asset.layout.updatedAt || null,
    environment: asset.layout.environment || null, lighting: asset.layout.lighting || null, env_model: env ? want(env) : null,
    camera: asset.layout.camera || null, decor, animations, files: []
  };
  validateScene(scene);
  return { scene, downloads: [...downloads].map(([p, d]) => ({ path: p, ...d })).sort((a, b) => a.path.localeCompare(b.path)) };
}

const sha256 = buf => createHash('sha256').update(buf).digest('hex');

/**
 * Downloads what buildScene asked for (a file already there with the same size, or the same known SHA256, is kept),
 * writes the save's scene.json and appends one scene_imported event (after any world_edit events of a re-import).
 * Importing the same studio state twice changes nothing and writes no second event. Returns { scene, files, edits, changed }.
 */
export async function importStudio(lab, { saveId, sceneAssetId, chars, base, assetsDir, fetchImpl = fetch, state }) {
  const save = lab.saves.getSave(saveId);
  if (!save) throw new StudioError('没有这个存档。');
  const file = lab.sceneFile(saveId);
  if (!file) throw new StudioError('这个实验台没有存档目录，不能导入。');
  state ??= await fetchState(base, fetchImpl);
  const { scene, downloads } = buildScene(rawScene(save.scene_id), state, { sceneAssetId, chars });
  const dir = path.join(assetsDir, saveId);
  const files = [];
  for (const d of downloads) {
    const dest = path.join(dir, d.path);
    let buf = existsSync(dest) ? await readFile(dest) : null;
    if (buf && !((d.sha256 && sha256(buf) === d.sha256) || (!d.sha256 && d.size != null && buf.length === d.size))) buf = null;
    if (!buf) {
      let res;
      try { res = await fetchImpl(base + d.url, { signal: AbortSignal.timeout(120000) }); }
      catch { throw new StudioError(`下载 ${d.path} 时连不上造物台。`); }
      if (!res.ok) throw new StudioError(`下载 ${d.path} 失败：造物台返回 ${res.status}。`);
      buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'glTF') throw new StudioError(`${d.path} 不是 GLB 文件。`);
      if (d.sha256 && sha256(buf) !== d.sha256) throw new StudioError(`${d.path} 的 SHA256 和造物台记录的不一致。`);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(`${dest}.downloading`, buf);
      await rename(`${dest}.downloading`, dest);
    }
    files.push({ path: d.path, sha256: sha256(buf), bytes: buf.length });
  }
  scene.studio.files = files;
  // Re-import (C2): the save's first import stays the starting world; what changed in the studio since then is
  // written as world_edit events by the user-as-creator, compared against the current world state.
  const before = existsSync(file) ? readFileSync(file, 'utf8') : null;
  const prev = before ? JSON.parse(before) : null;
  const edits = [];
  if (prev?.studio) {
    const fresh = scene.objects;
    // Display fields follow the studio; where things are and their state stay as the first import had them.
    const byId = new Map(fresh.map(o => [o.id, o]));
    scene.objects = prev.objects.map(o => {
      const f = byId.get(o.id);
      if (!f?.studio) return o;
      const { model, rot, scale, footprint: fp, studio } = f;
      return { ...o, model, rot, scale, studio, ...(fp ? { footprint: fp } : {}) };
    });
    const world = lab.ledger.world(saveId);
    const studioIds = new Set(fresh.filter(o => o.studio).map(o => o.id));
    const roomFor = (x, z) => (scene.rooms.find(r => inRoom(scene, r.id, x, z)) || {}).id || scene.user_room || scene.rooms[0].id;
    for (const o of fresh.filter(x => x.studio)) {
      const cur = world.objects[o.id];
      if (!cur) { edits.push({ op: 'add', id: o.id, room: o.room, object: o }); continue; }
      if (!cur.studio || cur.holder || cur.worn_by) continue;
      if (Math.hypot(o.pos[0] - cur.pos[0], o.pos[2] - cur.pos[2]) > MOVE_MIN) {
        const to = { room: roomFor(o.pos[0], o.pos[2]), pos: o.pos, ...(o.sit ? { sit: o.sit, facing: o.facing } : {}) };
        edits.push({ op: 'move', id: o.id, room: to.room, object: o.id, from: { room: cur.room, pos: cur.pos, name: cur.name }, to });
      }
    }
    for (const cur of Object.values(world.objects)) {
      if (cur.studio && !studioIds.has(cur.id) && !cur.holder && !cur.worn_by) edits.push({ op: 'remove', id: cur.id, room: cur.room, object: cur.id, from: { room: cur.room, pos: cur.pos, name: cur.name } });
    }
  }
  const text = JSON.stringify(scene, null, 1) + '\n';
  if (before === text && !edits.length) return { scene: lab.scene(saveId), files, edits, changed: false };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.writing`, text);
  await rename(`${file}.writing`, file);
  lab.ledger.forget(saveId); // the world fold depends on the scene's objects
  const world = lab.ledger.world(saveId);
  const sceneNow = lab.scene(saveId);
  // Seen at the moment only by characters in the same open area while a session is on; the rest find out later.
  const see = room => (world.sessionOpen ? perceiversFor(world, room, sceneNow) : []);
  lab.ledger.appendMany(saveId, [
    ...edits.map(e => ({ type: 'world_edit', actor: 'user', target: e.id, room: e.room, perceivers: see(e.room), payload: { op: e.op, object: e.object, by: 'creator', ...(e.from ? { from: e.from } : {}), ...(e.to ? { to: e.to } : {}) } })),
    { type: 'scene_imported', actor: 'host', payload: { source: 'studio', scene_asset_id: scene.studio.scene_asset_id, layout_updated_at: scene.studio.layout_updated_at || '', files: files.map(f => ({ path: f.path, sha256: f.sha256 })) } }
  ]);
  return { scene: lab.scene(saveId), files, edits, changed: true };
}
