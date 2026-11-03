// 复制自 asset-forge 7ef1af2（public/splice.js），勿在此修改。
// Several clips (already retargeted onto one character) played one after another as a single clip (P9-10):
// each part starts where the previous one ended (hips position across the floor and facing), and neighbouring parts
// cross-fade over `fade` seconds. Bones a part doesn't animate keep their rest pose in it.
import * as THREE from 'three';
import { humanoid } from './retarget.js';

const UP = new THREE.Vector3(0, 1, 0);

/** Heading (radians about world up) of the hips for a local hips quaternion under `parent`. */
function heading(parent, q) {
  const w = parent.getWorldQuaternion(new THREE.Quaternion()).multiply(q), f = new THREE.Vector3(0, 0, 1).applyQuaternion(w).setY(0);
  return Math.atan2(f.x, f.z);
}

/** Sample a track at time t into `out` (array of its value size). */
const sampleTrack = (track, t, out) => { const ip = track.createInterpolant(); out.set(ip.evaluate(Math.min(t, track.times[track.times.length - 1]))); return out; };

export function spliceClips(root, clips, { fade = 0.3, fps = 30, name = '编排' } = {}) {
  if (!clips.length) throw new Error('没有要拼的片段');
  root.updateMatrixWorld(true);
  const hips = humanoid(root).hips, parent = hips.parent;
  const posName = `${hips.name}.position`, quatName = `${hips.name}.quaternion`;
  const names = [...new Set(clips.flatMap(c => c.tracks.map(t => t.name)))];
  const restOf = n => { const [node, prop] = n.split('.'), o = root.getObjectByName(node); return o?.[prop]?.toArray?.() || null; };
  const rest = Object.fromEntries(names.map(n => [n, restOf(n)]));
  // Bake every part at fps.
  const parts = clips.map(c => {
    const frames = Math.max(2, Math.round(c.duration * fps) + 1), by = Object.fromEntries(c.tracks.map(t => [t.name, t]));
    const data = Object.fromEntries(names.filter(n => rest[n] || by[n]).map(n => {
      const size = by[n] ? by[n].getValueSize() : rest[n].length, arr = new Float32Array(frames * size), buf = new Float32Array(size);
      for (let f = 0; f < frames; f++) arr.set(by[n] ? sampleTrack(by[n], f / fps, buf) : rest[n], f * size);
      return [n, { size, arr }];
    }));
    return { frames, data };
  });
  // Align part k to where part k−1 ends: turn it about the hips' up axis (in the parent's frame) and move it
  // across the floor; its height stays its own.
  const upLocal = UP.clone().applyQuaternion(parent.getWorldQuaternion(new THREE.Quaternion()).invert()).normalize();
  for (let k = 1; k < parts.length; k++) {
    const prev = parts[k - 1].data, cur = parts[k].data, pf = parts[k - 1].frames - 1;
    if (!prev[quatName] || !cur[quatName]) continue;
    const qPrev = new THREE.Quaternion().fromArray(prev[quatName].arr, pf * 4), qCur = new THREE.Quaternion().fromArray(cur[quatName].arr, 0);
    const turn = new THREE.Quaternion().setFromAxisAngle(upLocal, heading(parent, qPrev) - heading(parent, qCur));
    const q = new THREE.Quaternion(), p = new THREE.Vector3(), p0 = cur[posName] ? new THREE.Vector3().fromArray(cur[posName].arr, 0) : null;
    const pEnd = prev[posName] ? new THREE.Vector3().fromArray(prev[posName].arr, pf * 3) : null;
    for (let f = 0; f < parts[k].frames; f++) {
      q.fromArray(cur[quatName].arr, f * 4).premultiply(turn).toArray(cur[quatName].arr, f * 4);
      if (p0 && pEnd) {
        p.fromArray(cur[posName].arr, f * 3).sub(p0).applyQuaternion(turn);
        const along = p.dot(upLocal); p.addScaledVector(upLocal, -along); // across the floor only
        p.add(pEnd).addScaledVector(upLocal, -pEnd.dot(upLocal)).addScaledVector(upLocal, along + p0.dot(upLocal));
        p.toArray(cur[posName].arr, f * 3);
      }
    }
  }
  // Lay the parts end to end, overlapping by `fade` (smoothstep blend; slerp for rotations).
  const overlap = Math.round(fade * fps), starts = [];
  let total = 0;
  parts.forEach((pt, k) => { starts.push(k ? total - overlap : 0); total = starts[k] + pt.frames; });
  const times = Float32Array.from({ length: total }, (_, f) => f / fps), tracks = [];
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
  for (const n of Object.keys(parts[0].data)) {
    const size = parts[0].data[n].size, out = new Float32Array(total * size);
    for (let f = 0; f < total; f++) {
      let v = null;
      parts.forEach((pt, k) => {
        const i = f - starts[k]; if (i < 0 || i >= pt.frames || !pt.data[n]) return;
        const w = pt.data[n].arr.subarray(i * size, i * size + size);
        if (!v) { v = Float32Array.from(w); return; }
        const s = THREE.MathUtils.smoothstep(i, -1, overlap); // the later part fades in over the overlap
        if (size === 4) { qa.fromArray(v); qb.fromArray(w); if (qa.dot(qb) < 0) qb.set(-qb.x, -qb.y, -qb.z, -qb.w); qa.slerp(qb, s).toArray(v); }
        else for (let c = 0; c < size; c++) v[c] += (w[c] - v[c]) * s;
      });
      if (v) out.set(v, f * size);
    }
    const Track = size === 4 ? THREE.QuaternionKeyframeTrack : THREE.VectorKeyframeTrack;
    tracks.push(new Track(n, times, out));
  }
  const clip = new THREE.AnimationClip(name, (total - 1) / fps, tracks);
  clip.userData.junctions = starts.slice(1).map(s => (s + overlap / 2) / fps);
  return clip;
}

/**
 * At each junction: the largest frame-to-frame move (metres, scaled to a 1.7 m character) and turn (degrees) of the
 * hips within ±fade, minus the largest the two parts make on their own next to it (a landing moves fast by itself).
 */
export function junctionJumps(root, clip, parts = [], { fps = 30, fade = 0.3 } = {}) {
  const hips = humanoid(root).hips, k = 1.7 / Math.max(1e-3, new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3()).y);
  const track = (c, t0, t1) => {
    const mixer = new THREE.AnimationMixer(root); mixer.clipAction(c).play();
    const at = t => { mixer.setTime(Math.min(Math.max(0, t), c.duration)); root.updateMatrixWorld(true); const f = new THREE.Vector3(0, 0, 1).applyQuaternion(hips.getWorldQuaternion(new THREE.Quaternion())).setY(0); return { p: hips.getWorldPosition(new THREE.Vector3()), h: Math.atan2(f.x, f.z) }; };
    let move = 0, turn = 0, prev = at(t0);
    for (let t = t0 + 1 / fps; t <= t1 + 1e-6; t += 1 / fps) {
      const cur = at(t); move = Math.max(move, cur.p.distanceTo(prev.p) * k);
      let d = Math.abs(cur.h - prev.h); if (d > Math.PI) d = 2 * Math.PI - d; turn = Math.max(turn, THREE.MathUtils.radToDeg(d)); prev = cur;
    }
    mixer.stopAllAction(); mixer.uncacheRoot(root);
    return { move, turn };
  };
  return (clip.userData.junctions || []).map((j, i) => {
    const got = track(clip, j - fade, j + fade);
    const own = [parts[i] && track(parts[i], parts[i].duration - 2 * fade, parts[i].duration), parts[i + 1] && track(parts[i + 1], 0, 2 * fade)].filter(Boolean);
    const base = { move: Math.max(0, ...own.map(o => o.move)), turn: Math.max(0, ...own.map(o => o.turn)) };
    return { at: +j.toFixed(2), moveCm: +(Math.max(0, got.move - base.move) * 100).toFixed(1), turnDeg: +Math.max(0, got.turn - base.turn).toFixed(1) };
  });
}
