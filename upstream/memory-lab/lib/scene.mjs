import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCardV2 } from './card.mjs';

export const LAB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEEDS = ['same_room', 'hands_free', 'holding', 'held_target', 'user_present', 'reachable', 'sitting', 'inside'];
const TARGETS = ['room', 'object', 'user', 'none'];

/** Character card markdown → { name, text, canon, card, meta } (contracts/card.md; old cards still parse). */
export function parseCard(text) {
  const p = parseCardV2(text);
  return { name: p.name, text: p.text, canon: p.canon, card: p.card, meta: p.meta };
}

/** Validates a scene object; throws a Chinese error listing every problem. */
export function validateScene(scene) {
  const errors = [];
  const rooms = new Set();
  const seen = new Set();
  for (const r of scene.rooms || []) {
    if (rooms.has(r.id)) errors.push(`房间 id 重复：${r.id}`);
    rooms.add(r.id);
    const okBox = Array.isArray(r.box) && r.box.length === 4;
    const okPoly = Array.isArray(r.poly) && r.poly.length >= 3 && r.poly.every(p => Array.isArray(p) && p.length === 2);
    if (!okBox && !okPoly) errors.push(`房间 ${r.id} 要有 box（[x0,z0,x1,z1]）或 poly（至少 3 个 [x,z]）`);
  }
  for (const r of scene.rooms || []) for (const k of ['exit_to']) if (r[k] && !rooms.has(r[k])) errors.push(`房间 ${r.id} 的 ${k} 不存在：${r[k]}`);
  for (const o of scene.objects || []) if (o.leads_to && !rooms.has(o.leads_to)) errors.push(`${o.id} 的 leads_to 不存在：${o.leads_to}`);
  for (const x of [...(scene.objects || []), ...(scene.palette || []), ...(scene.characters || [])]) {
    if (seen.has(x.id) || rooms.has(x.id)) errors.push(`id 重复：${x.id}`);
    seen.add(x.id);
  }
  for (const x of [...(scene.objects || []), ...(scene.characters || [])]) if (!rooms.has(x.room)) errors.push(`${x.id} 所在房间不存在：${x.room}`);
  for (const p of scene.palette || []) for (const r of p.rooms || []) if (!rooms.has(r)) errors.push(`${p.id} 可放置的房间不存在：${r}`);
  for (const [name, a] of Object.entries(scene.actions || {})) {
    for (const t of String(a.target).split('|')) if (!TARGETS.includes(t)) errors.push(`动作 ${name} 的目标类型不认识：${t}`);
    for (const n of a.needs || []) if (!NEEDS.includes(n) && !/^tag:\w+$/.test(n)) errors.push(`动作 ${name} 的条件不认识：${n}`);
  }
  if (!(scene.characters || []).length) errors.push('场景里没有角色');
  if (errors.length) throw new Error(`场景 ${scene.id} 有问题：${errors.join('；')}`);
  return scene;
}

const cache = new Map();
// 3.0 F: the scene's world data, next to it as scenes/<id>.<kind>.json (rules, incidents, topics, scout, practices).
// Loaded for every save of the scene; lab.scene() only puts it to use when the save has features.world on.
export const WORLD_KINDS = ['rules', 'incidents', 'topics', 'scout', 'practices'];
function worldFiles(id, dir) {
  const out = {};
  for (const kind of WORLD_KINDS) {
    const f = path.join(dir, 'scenes', `${id}.${kind}.json`);
    if (existsSync(f)) out[kind] = JSON.parse(readFileSync(f, 'utf8'));
  }
  return out;
}
/** Fills each character's card fields from its card file (paths are relative to dir). */
function hydrate(scene, dir) {
  validateScene(scene);
  scene.worldFiles = worldFiles(scene.id, dir);
  const has岚 = scene.characters.some(c => c.card === 'characters/lan.md');
  for (const c of scene.characters) {
    // characters/_friendly.md is a template for 造物台 characters without their own card: {{name}} / {{looks}}.
    const text = readFileSync(path.join(dir, c.card), 'utf8').replaceAll('{{name}}', c.name).replaceAll('{{looks}}', c.looks || '造物台里的模样。');
    const card = parseCard(text);
    c.cardText = card.text;
    c.canon = card.canon;
    c.card = card.card;
    c.meta = card.meta;
  }
  // The camp's world files are written for 岚. Another character from 造物台 (e.g. 银羽) shares the camp, but not
  // 岚's own past: her lines (师父, 铜钩星) are dropped and 岚 in the text becomes the character's name.
  const who = scene.characters[0];
  if (scene.id === 'camp' && who && !has岚 && who.name !== '岚') {
    const own = x => /师父|铜钩/.test(JSON.stringify(x));
    const f = scene.worldFiles;
    if (f.topics?.topics) f.topics = { ...f.topics, topics: f.topics.topics.filter(x => !own(x)) };
    if (f.practices?.practices) f.practices = { ...f.practices, practices: f.practices.practices.filter(x => !own(x)) };
    for (const k of WORLD_KINDS) if (f[k]) f[k] = JSON.parse(JSON.stringify(f[k]).replaceAll('岚', who.name));
  }
  return scene;
}
/** Loads scenes/<id>.json plus its character cards. dir is only overridden in tests. */
export function loadScene(id, dir = LAB_DIR) {
  const key = `${dir}|${id}`;
  if (cache.has(key)) return cache.get(key);
  if (!/^[a-z0-9_-]+$/.test(id)) throw new Error(`场景 id 不合法：${id}`);
  const file = path.join(dir, 'scenes', `${id}.json`);
  if (!existsSync(file)) throw new Error(`没有这个场景：${id}`);
  const scene = hydrate(JSON.parse(readFileSync(file, 'utf8')), dir);
  cache.set(key, scene);
  return scene;
}
/** The scenes/<id>.json object as written, without card fields (the importer builds on it). */
export function rawScene(id, dir = LAB_DIR) {
  loadScene(id, dir);
  return JSON.parse(readFileSync(path.join(dir, 'scenes', `${id}.json`), 'utf8'));
}
const fileCache = new Map();
/** A save's own scene file (2.0 C1 import), cached until the file changes. Cards still come from dir. */
export function loadSceneFile(file, dir = LAB_DIR) {
  const mtime = statSync(file).mtimeMs;
  const hit = fileCache.get(file);
  if (hit?.mtime === mtime) return hit.scene;
  const scene = hydrate(JSON.parse(readFileSync(file, 'utf8')), dir);
  fileCache.set(file, { mtime, scene });
  return scene;
}

// scenes/clips.json is the 2.0 C3 animation map, not a scene; scenes/<id>.<kind>.json are 3.0 world data.
export function listScenes(dir = LAB_DIR) {
  return readdirSync(path.join(dir, 'scenes')).filter(f => /^[a-z0-9_-]+\.json$/.test(f) && f !== 'clips.json').map(f => {
    const s = loadScene(f.slice(0, -5), dir);
    return { id: s.id, name: s.name };
  });
}

export const characterIds = scene => scene.characters.map(c => c.id);
export const findCharacter = (scene, id) => scene.characters.find(c => c.id === id);
export const roomName = (scene, id) => scene.rooms.find(r => r.id === id)?.name || id;
/** [x0, z0, x1, z1] of a room: its box, or the bounding box of its polygon. */
export function roomBox(scene, id) {
  const r = scene.rooms.find(x => x.id === id);
  if (!r) return null;
  if (r.box) return r.box;
  const xs = r.poly.map(p => p[0]), zs = r.poly.map(p => p[1]);
  return [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)];
}
export function roomCenter(scene, id) {
  const r = scene.rooms.find(x => x.id === id);
  if (r?.center) return [r.center[0], 0, r.center[1]];
  if (r?.poly) return [r.poly.reduce((a, p) => a + p[0], 0) / r.poly.length, 0, r.poly.reduce((a, p) => a + p[1], 0) / r.poly.length];
  const b = r?.box;
  return b ? [(b[0] + b[2]) / 2, 0, (b[1] + b[3]) / 2] : [0, 0, 0];
}
/** Point-in-room on the x/z plane (box or polygon, edges count as inside). */
export function inRoom(scene, id, x, z) {
  const r = scene.rooms.find(q => q.id === id);
  if (!r) return false;
  if (r.box) return x >= r.box[0] && x <= r.box[2] && z >= r.box[1] && z <= r.box[3];
  let inside = false;
  for (let i = 0, k = r.poly.length - 1; i < r.poly.length; k = i++) {
    const [xi, zi] = r.poly[i], [xk, zk] = r.poly[k];
    if ((zi > z) !== (zk > z) && x < ((xk - xi) * (z - zi)) / (zk - zi) + xi) inside = !inside;
  }
  return inside;
}
/** Rooms that see and hear each other: the same room, or rooms sharing a `group` (open ground with no walls). */
export function sameArea(scene, a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const ga = scene.rooms.find(r => r.id === a)?.group;
  return Boolean(ga) && ga === scene.rooms.find(r => r.id === b)?.group;
}
