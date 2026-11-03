// 2.0 C4: server-side walking paths in the imported camp (fixture layout, no real studio).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildScene } from '../lib/studio-import.mjs';
import { rawScene, validateScene, loadScene } from '../lib/scene.mjs';
import { initialState, applyEvent } from '../lib/world.mjs';
import { createNav, planWalk, standPoint, obstacles, MARGIN } from '../lib/nav.mjs';
import { actionEvents, checkAction } from '../lib/arbiter.mjs';

process.env.LAB_QUIET = '1';
const here = path.dirname(fileURLToPath(import.meta.url));
const state1 = JSON.parse(readFileSync(path.join(here, 'fixtures', 'studio', 'state-v2.json'), 'utf8'));
function camp() {
  const { scene } = buildScene(rawScene('camp'), state1, { sceneAssetId: 'scene-769405f4' });
  validateScene(scene); // cards are not needed for walking
  return { scene, state: initialState(scene) };
}
const inside = (poly, [x, z]) => {
  let r = false;
  for (let i = 0, k = poly.length - 1; i < poly.length; k = i++) {
    const [xi, zi] = poly[i], [xk, zk] = poly[k];
    if ((zi > z) !== (zk > z) && x < ((xk - xi) * (z - zi)) / (zk - zi) + xi) r = !r;
  }
  return r;
};
/** Every 2 cm of the polyline, outside every given footprint (already grown by MARGIN). */
function avoids(pathPts, polys) {
  for (let i = 1; i < pathPts.length; i++) {
    const [a, b] = [pathPts[i - 1], pathPts[i]];
    const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.02);
    for (let j = 0; j <= n; j++) {
      const p = [a[0] + ((b[0] - a[0]) * j) / n, a[1] + ((b[1] - a[1]) * j) / n];
      for (const poly of polys) if (inside(poly, p)) return false;
    }
  }
  return true;
}

test('footprints come from the studio collision boxes; the tent (open) and fillers without collision have none', () => {
  const { scene, state } = camp();
  const ids = obstacles(scene, state).map(o => o.id);
  for (const id of ['campfire-1', 'log-bench-1', 'log-bench-2', 'log-bench-3', 'wood-crate-1', 'barrel-1']) assert.ok(ids.includes(id), id);
  assert.ok(!ids.includes('tent-1') && !ids.includes('lantern-1'));
  assert.ok(!scene.studio.decor.some(d => ['grass-flowers', 'shrub', 'pebbles'].includes(d.kind) && d.footprint));
  assert.equal(MARGIN, 0.25);
});

test('from the tent door to the east bench the path goes around the fire and the crate', () => {
  const { scene, state } = camp();
  const door = standPoint(scene, state, state.objects['tent-1'], [0, 0.45]);
  assert.deepEqual(door, [-0.2, -0.5]);
  const bench = state.objects['log-bench-2'];
  const r = createNav(scene, state, { ignore: ['log-bench-2'] }).path(door, [bench.sit[0], bench.sit[2]]);
  assert.equal(r.ok, true);
  assert.ok(r.path.length > 2, 'not a straight line: the fire is in the way');
  const block = obstacles(scene, state).filter(o => ['campfire-1', 'wood-crate-1'].includes(o.id)).map(o => o.poly);
  assert.ok(avoids(r.path, block), JSON.stringify(r.path));
  assert.deepEqual(r.path.at(-1), [bench.sit[0], bench.sit[2]]);
});

test('an unreachable goal walks straight and says so', () => {
  const { scene, state } = camp();
  const r = createNav(scene, state).path([-0.2, -0.5], [0, 0.45]); // into the middle of the fire
  assert.equal(r.ok, false);
  assert.deepEqual(r.path, [[-0.2, -0.5], [0, 0.45]]);
});

test('sit, enter and leave carry paths in the event; the world ends where the path ends', () => {
  const { scene, state } = camp();
  let t = 0;
  const run = action => {
    const check = checkAction(state, scene, 'lan', action);
    assert.equal(check.ok, true, `${action.name}: ${check.reason}`);
    const evs = actionEvents(state, scene, 'lan', action, check);
    for (const ev of evs) applyEvent(state, scene, { ...ev, t: ++t, perceivers: [] });
    return evs.at(-1);
  };
  const sit = run({ name: 'sit', target: 'log-bench-2' });
  assert.ok(sit.payload.path.length >= 2);
  assert.equal(state.characters.lan.sitting, 'log-bench-2');
  assert.deepEqual([state.characters.lan.pos[0], state.characters.lan.pos[2]], sit.payload.path.at(-1));
  const enter = run({ name: 'enter', target: 'tent-1' });
  assert.deepEqual(enter.payload.path.at(-1), [-0.2, -0.5], 'walks to the tent door');
  assert.equal(state.characters.lan.room, 'tent');
  assert.equal(planWalk(scene, state, 'lan', { name: 'walk_to', target: 'fireside' }), null, 'no walking out of the walled tent');
  const leave = run({ name: 'leave' });
  assert.deepEqual(leave.payload.path, [[-0.2, -0.5]]);
  assert.equal(state.characters.lan.room, 'fireside');
});

test('old scenes (no studio import) get no paths', () => {
  const scene = loadScene('camp'), state = initialState(scene);
  assert.equal(planWalk(scene, state, 'lan', { name: 'sit', target: 'log-bench-1' }), null);
});
