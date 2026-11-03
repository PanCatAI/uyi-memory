// 2.0 C4: walking paths in an imported camp, computed on the server (the browser only plays them).
// Walkable = the open areas (rooms with a `group`) minus object footprints (造物台 collision box/trunk) grown by 0.25 m.
// A visibility graph over stand points, obstacle corners and area corners, searched with A*. No path → a straight line
// with ok: false (the caller logs it).
import { inRoom, roomBox, roomCenter, sameArea } from './scene.mjs';

export const MARGIN = 0.25, STAND = 0.6, STEP = 0.05, SPEED = 1.2;
const END_FREE = 0.3; // the first and last bit of a path may leave the walkable area (start on a seat, goal at a door)

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const r3 = v => Math.round(v * 1000) / 1000;

/** Convex polygon grown outward by m (each corner pushed away from the centroid). */
function grow(poly, m) {
  const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length, cz = poly.reduce((s, p) => s + p[1], 0) / poly.length;
  return poly.map(([x, z]) => {
    const d = Math.hypot(x - cx, z - cz) || 1;
    return [x + ((x - cx) / d) * m * Math.SQRT2, z + ((z - cz) / d) * m * Math.SQRT2];
  });
}
function inPoly(poly, x, z) {
  let inside = false;
  for (let i = 0, k = poly.length - 1; i < poly.length; k = i++) {
    const [xi, zi] = poly[i], [xk, zk] = poly[k];
    if ((zi > z) !== (zk > z) && x < ((xk - xi) * (z - zi)) / (zk - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Obstacles of the current world: { id, poly } for every object (and filler) with a footprint, not held or worn. */
export function obstacles(scene, state) {
  const out = [];
  for (const o of Object.values(state.objects)) {
    if (!o.footprint || o.holder || o.worn_by) continue;
    out.push({ id: o.id, poly: grow(o.footprint.map(([dx, dz]) => [o.pos[0] + dx, o.pos[2] + dz]), MARGIN) });
  }
  for (const d of scene.studio?.decor || []) if (d.footprint) out.push({ id: d.id, poly: grow(d.footprint.map(([dx, dz]) => [d.pos[0] + dx, d.pos[2] + dz]), MARGIN) });
  return out;
}

export function createNav(scene, state, { ignore = [] } = {}) {
  const open = scene.rooms.filter(r => r.group);
  const obs = obstacles(scene, state).filter(o => !ignore.includes(o.id));
  const walkable = (x, z) => open.some(r => inRoom(scene, r.id, x, z));
  const free = (x, z) => walkable(x, z) && !obs.some(o => inPoly(o.poly, x, z));
  /** Every sample of the segment is free, except near the path's own ends. */
  function clear(a, b, ends) {
    const n = Math.max(1, Math.ceil(dist(a, b) / STEP));
    for (let i = 0; i <= n; i++) {
      const p = [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n];
      if (ends.some(e => dist(e, p) < END_FREE)) continue;
      if (!free(p[0], p[1])) return false;
    }
    return true;
  }
  // Graph nodes: obstacle corners pushed out a little more, area corners pulled in toward the area centre.
  const nodes = [];
  for (const o of obs) for (const p of grow(o.poly, 0.03)) if (free(p[0], p[1])) nodes.push(p);
  for (const r of open) {
    const poly = r.poly || [[r.box[0], r.box[1]], [r.box[2], r.box[1]], [r.box[2], r.box[3]], [r.box[0], r.box[3]]];
    const [cx, , cz] = roomCenter(scene, r.id);
    for (const [x, z] of poly) { const d = Math.hypot(cx - x, cz - z) || 1; const p = [x + ((cx - x) / d) * 0.08, z + ((cz - z) / d) * 0.08]; if (free(p[0], p[1])) nodes.push(p); }
  }

  /** Shortest polyline from a to b ([x, z] each): { path, ok }. */
  function path(a, b) {
    const ends = [a, b];
    if (clear(a, b, ends)) return { path: [a, b].map(p => p.map(r3)), ok: true };
    const pts = [a, ...nodes, b], goal = pts.length - 1;
    const g = new Array(pts.length).fill(Infinity), prev = new Array(pts.length).fill(-1), done = new Array(pts.length).fill(false);
    g[0] = 0;
    for (;;) {
      let u = -1, best = Infinity;
      for (let i = 0; i < pts.length; i++) if (!done[i] && g[i] + dist(pts[i], b) < best) { best = g[i] + dist(pts[i], b); u = i; }
      if (u < 0) return { path: [a, b].map(p => p.map(r3)), ok: false };
      if (u === goal) break;
      done[u] = true;
      for (let v = 0; v < pts.length; v++) {
        if (done[v] || v === u) continue;
        const w = g[u] + dist(pts[u], pts[v]);
        if (w < g[v] && clear(pts[u], pts[v], ends)) { g[v] = w; prev[v] = u; }
      }
    }
    const out = [];
    for (let i = goal; i >= 0; i = prev[i]) out.unshift(pts[i]);
    return { path: out.map(p => p.map(r3)), ok: true };
  }
  /** A polyline (e.g. one stored on an event) stays free all the way, except its own ends. */
  const pathClear = pts => pts.every((p, i) => i === 0 || clear(pts[i - 1], p, [pts[0], pts.at(-1)]));
  return { path, free, walkable, pathClear, obstacles: obs };
}

/** Stand point for an object: 0.6 m out from its footprint (or centre), on the free side nearest `near`. */
export function standPoint(scene, state, obj, near) {
  const nav = createNav(scene, state, { ignore: [obj.id] });
  // Something you go into (the tent) has no collision footprint: its size is the room it leads to.
  const box = !obj.footprint && obj.leads_to && roomBox(scene, obj.leads_to);
  const fp = obj.footprint || (box ? [[box[0] - obj.pos[0], box[1] - obj.pos[2]], [box[2] - obj.pos[0], box[3] - obj.pos[2]]] : [[-0.2, -0.2], [0.2, 0.2]]);
  const hx = Math.max(...fp.map(p => Math.abs(p[0]))), hz = Math.max(...fp.map(p => Math.abs(p[1])));
  const [x, , z] = obj.pos;
  const cands = [[x, z + hz + STAND], [x, z - hz - STAND], [x + hx + STAND, z], [x - hx - STAND, z]].map(p => p.map(r3));
  const ok = cands.filter(p => nav.free(p[0], p[1]));
  return (ok.length ? ok : cands).sort((a, b) => dist(a, near) - dist(b, near))[0];
}

const WALKERS = ['walk_to', 'sit', 'pick_up', 'put_down', 'tend_fire', 'enter', 'clean', 'switch'];

/**
 * The path a character walks for an allowed action in an imported camp, or null (old scenes, no walking needed).
 * Returns { path: [[x, z], …], ok, to: [x, z] }.
 */
export function planWalk(scene, state, charId, action) {
  if (!scene.studio || !WALKERS.includes(action.name)) return null;
  const c = state.characters[charId];
  const room = scene.rooms.find(r => r.id === c.room);
  if (!room?.group) return null; // inside the tent: leave first
  const from = [c.pos[0], c.pos[2]];
  const obj = state.objects[action.target];
  let to, ignore = [];
  if (action.name === 'walk_to' && !obj) {
    if (!sameArea(scene, c.room, action.target)) return null;
    const [cx, , cz] = roomCenter(scene, action.target); to = [cx, cz];
  } else if (!obj) return null;
  else if (action.name === 'sit' && obj.sit) { to = [obj.sit[0], obj.sit[2]]; ignore = [obj.id]; }
  else if (action.name === 'enter') {
    const fire = Object.values(state.objects).find(o => (o.tags || []).includes('fire'));
    to = standPoint(scene, state, obj, fire ? [fire.pos[0], fire.pos[2]] : from);
  } else to = standPoint(scene, state, obj, from);
  if (dist(from, to) < 0.05) return null;
  const r = createNav(scene, state, { ignore }).path(from, to);
  return { ...r, to };
}
