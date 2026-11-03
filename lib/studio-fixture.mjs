// A stand-in 造物台 for scenarios and tests: test/fixtures/studio/state-v<n>.json plus tiny GLBs, served through a
// fetch() look-alike. Never touches the real studio. The animation libraries' SHA256 point at the tiny GLBs.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { LAB_DIR } from './scene.mjs';

export const FIXTURE_SCENE = 'scene-769405f4';

/** The smallest valid GLB, tagged so each file has its own bytes. */
export function tinyGlb(tag) {
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0', generator: String(tag) }, meshes: [{ primitives: [] }] }).padEnd(80, ' '));
  const chunk = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(20);
  head.write('glTF', 0, 'latin1'); head.writeUInt32LE(2, 4); head.writeUInt32LE(20 + chunk.length, 8);
  head.writeUInt32LE(chunk.length, 12); head.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([head, chunk]);
}

export function fixtureState(n) {
  const state = JSON.parse(readFileSync(path.join(LAB_DIR, 'test', 'fixtures', 'studio', `state-v${n}.json`), 'utf8'));
  for (const a of state.animations) if (a.sha256) a.sha256 = createHash('sha256').update(tinyGlb(a.file)).digest('hex');
  return state;
}

/** { state, fetchImpl, calls } for fixture n; calls records every request (method and url). */
export function fixtureStudio(n, state = fixtureState(n)) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET' });
    const p = new URL(url).pathname;
    if (p === '/api/state') return new Response(JSON.stringify(state), { headers: { 'content-type': 'application/json' } });
    const m = /^\/files\/(models|anims)\/(.+)$/.exec(p);
    if (m) return new Response(tinyGlb(decodeURIComponent(m[2])));
    return new Response('no', { status: 404 });
  };
  return { state, fetchImpl, calls };
}
