// 复制自 asset-forge 7ef1af2（public/retarget.js），勿在此修改。
// Retarget any humanoid animation (Mixamo, Tripo, VRM-style names) onto any humanoid rig.
// Torso, head and feet copy the source's world-space rotation change from its rest pose;
// arms and legs copy the source's bone *directions* (so an A-pose character can use clips authored
// on a T-pose rig without its arms being offset) plus the source's turn about the bone's own axis.
// Hands (and, with `fingers: true`, fingers) copy their rotation *relative to the parent bone*, so they bend
// at the wrist as much as the source does whatever the arm's rest pose. Fingers are off by default: generated
// characters usually have fused fingers, which stretch badly when curled.
// The wrist's twist (the forearm's axial turn + the hand's turn about the forearm) is shared: half on the
// forearm (or spread over the target's forearm twist bones), the rest on the hand, so the wrist doesn't wring.
import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { createFootProbes, footContacts } from './foot-grounding.js';

const SIDES = { left: ['l_', 'left', 'l.', 'l'], right: ['r_', 'right', 'r.', 'r'] };
const CENTER = {
  hips: ['hip', 'hips', 'pelvis'], spine: ['spine01', 'spine', 'spine_01', 'spine.001', 'spine001'], chest: ['spine02', 'spine1', 'chest', 'spine_02', 'spine.002', 'spine002'],
  upperChest: ['spine03', 'spine2', 'upperchest', 'spine_03', 'spine.003', 'spine003'], neck: ['neck', 'necktwist01', 'neck01', 'neck_01'], head: ['head']
};
const LIMB = {
  Shoulder: ['clavicle', 'shoulder'], UpperArm: ['upperarm', 'arm', 'upper_arm'], LowerArm: ['forearm', 'lowerarm', 'lower_arm'], Hand: ['hand'],
  UpperLeg: ['thigh', 'upleg', 'upperleg', 'upper_leg'], LowerLeg: ['calf', 'leg', 'lowerleg', 'shin', 'lower_leg'], Foot: ['foot'], Toes: ['toebase', 'toe', 'toes']
};
const norm = s => String(s || '').toLowerCase().replace(/^mixamorig\d*[:_]?/, '').replace(/^(bip0?1|armature)[ _]?/, '').replace(/^(def|org)[-_]/, '').replace(/\s+/g, '');
// Blender / Rigify-style rigs put the side at the end ("DEF-upper_arm.L"; three.js drops the dot: "upper_arml").
const SUFFIX = { left: ['.l', '_l', 'l'], right: ['.r', '_r', 'r'] };

const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];
// Mixamo "LeftHandIndex1", "Left_Index1"-style, Tripo-style "L_Index01", Rigify "DEF-f_index01.L" / "DEF-thumb01.L",
// UE / UAL2 "index_01_l", VRM "leftIndexProximal" / "leftThumbMetacarpal" / "leftLittleDistal".
const fingerNames = (side, f, n) => {
  const s = side[0], x = f.toLowerCase(), vrm = `${side}${f === 'Pinky' ? 'little' : x}${vrmSegment(f, n).toLowerCase()}`;
  return [`${side}hand${x}${n}`, `${side}${x}${n}`, `${s}_${x}${n}`, `${s}_${x}0${n}`, vrm,
    ...SUFFIX[side].flatMap(sf => [`f_${x}0${n}${sf}`, `${x}0${n}${sf}`, `f_${x}${n}${sf}`, `${x}_0${n}${sf}`])];
};
// VRM 1.0 finger segments: the thumb has a metacarpal, the others an intermediate.
const vrmSegment = (f, n) => (f === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal'])[n - 1];
/** VRM humanoid bone name → our key (body names are the same; "leftLittleDistal" → "leftPinky3"). */
function vrmKey(name) {
  const m = /^(left|right)(Thumb|Index|Middle|Ring|Little)(Metacarpal|Proximal|Intermediate|Distal)$/.exec(name);
  if (!m) return name;
  const f = m[2] === 'Little' ? 'Pinky' : m[2], n = [1, 2, 3].find(i => vrmSegment(f, i) === m[3]);
  return n ? `${m[1]}${f}${n}` : null;
}

// SOMA (GEM-X video mocap, 77 joints; bones.glb from tools/gemx2glb.py, P8-8). Generic matching gets it wrong:
// "LeftLeg" is the thigh (not the calf), "Spine1" is the lowest spine and "Neck1" isn't a neck candidate.
// Mapping after h3-motion-creator tools/to_vrma/soma-bones.mjs (Apache-2.0): Neck2's turn folds into the head;
// finger joint 1 is the metacarpal, so the three finger bones are 2–4 (the thumb's are 1–3).
const SOMA = { hips: 'Hips', spine: 'Spine1', chest: 'Spine2', upperChest: 'Chest', neck: 'Neck1', head: 'Head' };
const SOMA_LIMB = { Shoulder: 'Shoulder', UpperArm: 'Arm', LowerArm: 'ForeArm', Hand: 'Hand', UpperLeg: 'Leg', LowerLeg: 'Shin', Foot: 'Foot', Toes: 'ToeBase' };
function somaHumanoid(bones) {
  const by = new Map(bones.map(b => [b.name, b]));
  if (!['Hips', 'Spine1', 'Neck1', 'LeftShin', 'RightShin'].every(n => by.has(n))) return null;
  const map = {};
  for (const [k, n] of Object.entries(SOMA)) if (by.has(n)) map[k] = by.get(n);
  for (const side of ['left', 'right']) {
    const S = side === 'left' ? 'Left' : 'Right';
    for (const [part, n] of Object.entries(SOMA_LIMB)) { const b = by.get(S + n); if (b) map[side + part] = b; }
    for (const f of FINGERS) for (let n = 1; n <= 3; n++) { const b = by.get(`${S}Hand${f}${f === 'Thumb' ? n : n + 1}`); if (b) map[`${side}${f}${n}`] = b; }
  }
  return map;
}

/** Humanoid bone name → THREE.Bone for a model (fingers as leftIndex1…rightPinky3 when present). */
export function humanoid(root) {
  const bones = []; root.traverse(o => { if (o.isBone) bones.push(o); });
  // A skeleton-only glb (no skin, e.g. SOMA bones.glb) loads as plain Object3D nodes.
  if (!bones.length) root.traverse(o => { if (o !== root && o.name && !o.isMesh) bones.push(o); });
  const soma = somaHumanoid(bones); if (soma) return soma;
  // A VRMA's own table (anim-formats.js markVrmaHumanoid): VRM bone name → node name.
  const table = root.userData?.humanBones;
  if (table) {
    const map = {};
    for (const [vrm, node] of Object.entries(table)) { const k = vrmKey(vrm), b = bones.find(x => x.name === node); if (k && b) map[k] = b; }
    if (map.hips) return map;
  }
  const find = cands => { for (const c of cands) { const b = bones.find(x => norm(x.name) === c); if (b) return b; } return null; };
  const map = {};
  for (const [k, c] of Object.entries(CENTER)) { const b = find(c); if (b) map[k] = b; }
  for (const side of ['left', 'right']) for (const [part, c] of Object.entries(LIMB)) {
    const b = find([...SIDES[side].flatMap(p => c.map(x => p + x)), ...c.flatMap(x => SUFFIX[side].map(sf => x + sf))]); if (b) map[side + part] = b;
  }
  for (const side of ['left', 'right']) for (const f of FINGERS) for (let n = 1; n <= 3; n++) {
    const b = find(fingerNames(side, f, n)); if (b) map[`${side}${f}${n}`] = b;
  }
  return map;
}

const ORDER = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
  ...['left', 'right'].flatMap(s => ['Shoulder', 'UpperArm', 'LowerArm', 'Hand', 'UpperLeg', 'LowerLeg', 'Foot', 'Toes'].map(p => s + p)),
  ...['left', 'right'].flatMap(s => FINGERS.flatMap(f => [1, 2, 3].map(n => `${s}${f}${n}`)))];
// Limbs follow direction (rest poses differ between A- and T-pose rigs); everything else follows rotation deltas.
const DIRECTION = { leftUpperArm: 'leftLowerArm', leftLowerArm: 'leftHand', rightUpperArm: 'rightLowerArm', rightLowerArm: 'rightHand', leftUpperLeg: 'leftLowerLeg', leftLowerLeg: 'leftFoot', rightUpperLeg: 'rightLowerLeg', rightLowerLeg: 'rightFoot' };

// Hands and fingers follow their parent's frame: key → the bone they are measured against.
const RELATIVE = Object.fromEntries(['left', 'right'].flatMap(s => [[s + 'Hand', s + 'LowerArm'],
  ...FINGERS.flatMap(f => [1, 2, 3].map(n => [`${s}${f}${n}`, n === 1 ? s + 'Hand' : `${s}${f}${n - 1}`]))]));
const TWIST_SHARE = 0.5; // of the wrist's twist, given to the forearm when there are no twist bones
// Wrist limits (P9-4): the hand bends at most WRIST_BEND from its rest relative to the forearm, and the wrist's total
// twist (forearm axial turn + hand turn) stays within WRIST_TWIST; capture noise beyond that only wrings the skin.
export const WRIST_BEND = THREE.MathUtils.degToRad(80), WRIST_TWIST = THREE.MathUtils.degToRad(90);

const wq = o => o.getWorldQuaternion(new THREE.Quaternion());
const wp = o => o.getWorldPosition(new THREE.Vector3());

/** The part of rotation `q` about unit `axis` (swing–twist decomposition), as a signed angle. */
export function twistAngle(q, axis) {
  const p = axis.x * q.x + axis.y * q.y + axis.z * q.z;
  let a = 2 * Math.atan2(p, q.w);
  if (a > Math.PI) a -= 2 * Math.PI; else if (a < -Math.PI) a += 2 * Math.PI;
  return a;
}
const turnAbout = (axis, angle) => new THREE.Quaternion().setFromAxisAngle(axis, angle);
/** Hand change (swing · twist about the forearm `axis`) with the bend and the wrist's total twist (`axial` + twist) capped. */
export function limitWrist(change, axis, axial) {
  let twist = twistAngle(change, axis);
  const swing = change.clone().multiply(turnAbout(axis, twist).invert()), bend = 2 * Math.acos(Math.min(1, Math.abs(swing.w)));
  if (bend > WRIST_BEND) swing.copy(new THREE.Quaternion().slerp(swing, WRIST_BEND / bend));
  const total = THREE.MathUtils.clamp(axial + twist, -WRIST_TWIST, WRIST_TWIST);
  twist = total - axial;
  return { change: swing.multiply(turnAbout(axis, twist)), total };
}
const relTo = (a, b) => wq(a).invert().multiply(wq(b)); // b's rotation in a's frame

/** Rest hand frame (towards the fingers, across the palm index→pinky, palm normal); null without index and pinky bones. */
function handFrame(H, side, map = v => v) {
  const hand = H[side + 'Hand'], tip = H[side + 'Middle1'] || H[side + 'Index1'], index = H[side + 'Index1'], pinky = H[side + 'Pinky1'];
  if (!hand || !tip || !index || !pinky) return null;
  const d = map(wp(tip).sub(wp(hand))).normalize(), across = map(wp(index).sub(wp(pinky)));
  across.addScaledVector(d, -across.dot(d)).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(d, across, d.clone().cross(across)));
}

/** Target forearm twist bones (e.g. Tripo L_ForearmTwist01/02): below the forearm, not above the hand; nearest the elbow first. */
function twistBones(fore, hand) {
  const out = [], above = new Set(); for (let o = hand; o; o = o.parent) above.add(o);
  fore.traverse(o => { if (o.isBone && o !== fore && !above.has(o) && /twist/i.test(o.name)) out.push(o); });
  const f = wp(fore);
  return out.sort((a, b) => wp(a).distanceTo(f) - wp(b).distanceTo(f));
}

/** Body frame (side, up, forward) of a character in its current pose, as a quaternion. */
function bodyFrame(map) {
  const up = wp(map.head).sub(wp(map.hips)).normalize();
  const side = wp(map.leftUpperArm || map.leftUpperLeg).sub(wp(map.rightUpperArm || map.rightUpperLeg));
  side.addScaledVector(up, -side.dot(up)).normalize();
  const fwd = new THREE.Vector3().crossVectors(side, up).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(side, up, fwd));
}
function hipHeight(map) { return wp(map.hips).y - Math.min(wp(map.leftFoot || map.hips).y, wp(map.rightFoot || map.hips).y); }

// Ground contact for video mocap: a foot's lowest point is its ankle or toe, each against its rest height above
// the rest floor (no skinning needed). Frames where the source's lower foot is on its own floor (5th percentile,
// so a clip that floats as a whole still counts) and barely moves vertically are contacts; the target's median
// height there is the offset taken off the hips for the whole clip. Jumps keep their flight; nothing is clamped.
function footRest(H) {
  const sides = ['left', 'right'].filter(s => H[s + 'Foot']).map(s => ({ foot: H[s + 'Foot'], toe: H[s + 'Toes'] }));
  if (sides.length < 2) return null;
  const floor = Math.min(...sides.flatMap(x => [wp(x.foot).y, x.toe ? wp(x.toe).y : Infinity]));
  return sides.map(x => ({ ...x, a0: wp(x.foot).y - floor, t0: x.toe ? wp(x.toe).y - floor : 0 }));
}
const lowFoot = feet => Math.min(...feet.map(x => Math.min(wp(x.foot).y - x.a0, x.toe ? wp(x.toe).y - x.t0 : Infinity)));
function soleProbe(root, feet) {
  const bottom = new THREE.Box3().setFromObject(root, true).min.y, probes = createFootProbes(root, feet);
  if (!probes.some(p => p.samples.length)) return null;
  return () => Math.min(...footContacts(probes, () => 0).map(c => c.sole)) - bottom;
}
const CONTACT_BAND = 0.03, CONTACT_VY = 0.25;
export function groundOffset(lowS, lowT, fps = 30) {
  if (lowS.length < 3) return 0;
  const floor = [...lowS].sort((a, b) => a - b)[Math.floor(0.05 * lowS.length)];
  const at = lowS.map((h, i) => i).filter(i => i > 0 && i < lowS.length - 1 && lowS[i] - floor < CONTACT_BAND && Math.abs(lowS[i + 1] - lowS[i - 1]) * fps / 2 < CONTACT_VY);
  if (at.length < 0.1 * lowS.length) return 0;
  const v = at.map(i => lowT[i]).sort((a, b) => a - b), m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * Bake `clip` (playing on `sourceScene`) onto a fresh copy of `targetScene`.
 * Returns an AnimationClip whose tracks address the target's bones by name.
 * `ground` (default on, P9-1 / 10-23 for every source) settles the clip on the ground; see groundOffset. Off = the old, unsettled result.
 */
export function retargetClip(targetScene, sourceScene, clip, { fps = 30, inPlace = true, name, fingers = false, ground = true } = {}) {
  const target = SkeletonUtils.clone(targetScene), source = SkeletonUtils.clone(sourceScene);
  target.updateMatrixWorld(true); source.updateMatrixWorld(true);
  const T = humanoid(target), S = humanoid(source);
  const keys = ORDER.filter(k => T[k] && S[k] && (!RELATIVE[k] || (T[RELATIVE[k]] && S[RELATIVE[k]])) && (fingers || !/\d$/.test(k)));
  if (!keys.includes('hips') || !T.head || !S.head) throw new Error('骨骼认不全，无法套用这个动作。');

  // Rest poses (both models as loaded).
  const restT = new Map(keys.map(k => [k, { q: T[k].quaternion.clone(), p: T[k].position.clone(), wq: wq(T[k]) }]));
  const restS = new Map(keys.map(k => [k, { q: S[k].quaternion.clone(), wq: wq(S[k]), p: wp(S[k]) }]));
  const frameS = bodyFrame(S), frameT = bodyFrame(T);
  const M = frameT.clone().multiply(frameS.clone().invert()); // source world → target world
  const Minv = M.clone().invert();
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(M).setY(0);
  const Myaw = fwd.lengthSq() > 1e-8 ? new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), fwd.normalize()) : new THREE.Quaternion();
  const hipScale = hipHeight(T) / (hipHeight(S) || 1);
  const hipRestT = wp(T.hips);

  // Hands and fingers: rest rotation relative to their parent key, and Q, which carries a rotation from the
  // source parent's frame to the target's: via the body frame, then aligning the rest hands (palm included) when
  // both have fingers, else just the forearm directions (the palm's roll is then unknown).
  const arm = {};
  for (const side of ['left', 'right']) {
    const fore = side + 'LowerArm', hand = side + 'Hand';
    if (!keys.includes(hand)) continue;
    const dS = restS.get(hand).p.clone().sub(restS.get(fore).p).normalize().applyQuaternion(M);
    const dT = wp(T[hand]).sub(wp(T[fore])).normalize();
    const tb = twistBones(T[fore], T[hand]);
    const hS = handFrame(S, side, v => v.applyQuaternion(M)), hT = handFrame(T, side);
    arm[side] = {
      A: hS && hT ? hT.multiply(hS.invert()) : new THREE.Quaternion().setFromUnitVectors(dS, dT),
      axis: dT.clone().applyQuaternion(restT.get(fore).wq.clone().invert()), // forearm axis in the forearm's frame
      twist: tb.map(b => ({ bone: b, q: b.quaternion.clone(), rel: relTo(T[fore], b), quats: new Float32Array(0) })),
    };
  }
  const rel = new Map(keys.filter(k => RELATIVE[k] && arm[k.startsWith('left') ? 'left' : 'right']).map(k => {
    const pk = RELATIVE[k], A = arm[k.startsWith('left') ? 'left' : 'right'].A;
    const Q = restT.get(pk).wq.clone().invert().multiply(A).multiply(M).multiply(restS.get(pk).wq);
    return [k, { pk, Q, Qinv: Q.clone().invert(), r0T: relTo(T[pk], T[k]), r0Sinv: relTo(S[pk], S[k]).invert() }];
  }));
  // Change of k's rotation relative to its parent key, in the target parent's frame.
  const relChange = k => { const r = rel.get(k); return r.Q.clone().multiply(relTo(S[r.pk], S[k]).multiply(r.r0Sinv)).multiply(r.Qinv); };
  // Source bone's turn about its own axis beyond the shortest swing from where its parent carried it.
  const axialTurn = (k, childKey) => {
    const b = S[k], carried = (b.parent ? wq(b.parent) : new THREE.Quaternion()).multiply(restS.get(k).q);
    const turn = wq(b).multiply(carried.invert());
    const dCur = wp(S[childKey]).sub(wp(b)).normalize();
    const swing = new THREE.Quaternion().setFromUnitVectors(dCur.clone().applyQuaternion(turn.clone().invert()), dCur);
    return twistAngle(turn.multiply(swing.invert()), dCur);
  };

  const mixer = new THREE.AnimationMixer(source);
  const action = mixer.clipAction(clip); action.play();
  const frames = Math.max(2, Math.round(clip.duration * fps) + 1);
  const times = new Float32Array(frames);
  const quats = new Map(keys.map(k => [k, new Float32Array(frames * 4)]));
  for (const a of Object.values(arm)) for (const t of a.twist) t.quats = new Float32Array(frames * 4);
  const hipPos = new Float32Array(frames * 3), hipWorld = [];
  // Every source floats or sinks a little differently on each character: settle it on the ground (below).
  const feetS = ground && footRest(S), feetT = ground && footRest(T), lowS = [], lowT = [];
  // The target's shoe soles (skinned, as foot-grounding.js sees them) when it has a mesh; bones otherwise.
  const soles = ground && T.leftFoot && T.rightFoot && soleProbe(target, [T.leftFoot, T.rightFoot]);

  for (let f = 0; f < frames; f++) {
    const t = Math.min(clip.duration, f / fps);
    times[f] = t;
    mixer.setTime(t); source.updateMatrixWorld(true);
    for (const k of keys) { T[k].quaternion.copy(restT.get(k).q); T[k].position.copy(restT.get(k).p); }
    for (const a of Object.values(arm)) for (const tw of a.twist) tw.bone.quaternion.copy(tw.q);
    target.updateMatrixWorld(true);
    const handTurn = {};
    for (const k of keys) {
      const bone = T[k], parentQ = bone.parent ? wq(bone.parent) : new THREE.Quaternion();
      let world;
      const childKey = DIRECTION[k];
      if (childKey && T[childKey] && S[childKey]) {
        const want = wp(S[childKey]).sub(wp(S[k])).normalize().applyQuaternion(M);
        const cur = wp(T[childKey]).sub(wp(bone)).normalize();
        const swung = new THREE.Quaternion().setFromUnitVectors(cur, want).multiply(wq(bone)), axial = axialTurn(k, childKey);
        world = turnAbout(want, axial).multiply(swung);
        const side = k.startsWith('left') ? 'left' : 'right', a = arm[side];
        if (k === side + 'LowerArm' && a && rel.has(side + 'Hand')) {
          // The forearm's own axial turn plus the hand's turn about it is the wrist's total twist. The hand keeps
          // the source's orientation (measured from the fully turned forearm); the forearm takes a share of the
          // total, or none when twist bones carry it.
          const { change, total } = limitWrist(relChange(side + 'Hand'), a.axis, axial);
          handTurn[side] = { full: world, change, total };
          world = swung.clone().multiply(turnAbout(a.axis, a.twist.length ? 0 : total * TWIST_SHARE));
        }
      } else if (rel.has(k)) {
        const r = rel.get(k), side = k.startsWith('left') ? 'left' : 'right', h = k === side + 'Hand' ? handTurn[side] : null;
        world = (h ? h.full.clone() : wq(T[r.pk])).multiply(h ? h.change : relChange(k)).multiply(r.r0T);
      } else {
        const delta = wq(S[k]).multiply(restS.get(k).wq.clone().invert());
        world = M.clone().multiply(delta).multiply(Minv).multiply(restT.get(k).wq);
      }
      bone.quaternion.copy(parentQ.invert().multiply(world));
      if (k === 'hips') {
        // Travel turns with the body frame's yaw only. M also carries the rest poses' lean difference, which tips
        // forward travel into height (a GEM-X walk climbed ~1 m over 12 m, UAL Roll_RM floated 1.3 m). Height changes
        // stay vertical; the ground offset below then settles what the hip-height scale leaves high or low.
        const raw = wp(S.hips).sub(restS.get('hips').p);
        const d = (ground ? new THREE.Vector3(raw.x, 0, raw.z).applyQuaternion(Myaw).setY(raw.y) : raw.applyQuaternion(M)).multiplyScalar(hipScale);
        if (inPlace) { d.x = 0; d.z = 0; }
        const worldPos = hipRestT.clone().add(d);
        hipWorld.push(worldPos.clone());
        bone.position.copy(bone.parent ? bone.parent.worldToLocal(worldPos) : worldPos);
        bone.position.toArray(hipPos, f * 3);
      }
      bone.updateMatrixWorld(true);
      bone.quaternion.toArray(quats.get(k), f * 4);
      const side = k.startsWith('left') ? 'left' : 'right';
      if (k === side + 'Hand' && handTurn[side]) {
        // Twist bones spread the turn along the forearm: i/(n+1) of it each, measured from the forearm.
        const a = arm[side], n = a.twist.length;
        a.twist.forEach((tw, i) => {
          const w = wq(T[side + 'LowerArm']).multiply(turnAbout(a.axis, (handTurn[side].total * (i + 1)) / (n + 1))).multiply(tw.rel);
          tw.bone.quaternion.copy(wq(tw.bone.parent).invert().multiply(w));
          tw.bone.updateMatrixWorld(true);
          tw.bone.quaternion.toArray(tw.quats, f * 4);
        });
      }
    }
    if (feetS && feetT) { lowS.push(lowFoot(feetS)); lowT.push(soles ? soles() : lowFoot(feetT)); }
  }
  mixer.stopAllAction(); mixer.uncacheRoot(source);
  if (ground && feetS && feetT) {
    const off = groundOffset(lowS, lowT, fps);
    if (off) hipWorld.forEach((w, f) => T.hips.parent.worldToLocal(w.setY(w.y - off)).toArray(hipPos, f * 3));
  }
  const tracks = keys.map(k => new THREE.QuaternionKeyframeTrack(`${T[k].name}.quaternion`, times, quats.get(k)));
  for (const a of Object.values(arm)) for (const tw of a.twist) if (tw.quats.length) tracks.push(new THREE.QuaternionKeyframeTrack(`${tw.bone.name}.quaternion`, times, tw.quats));
  tracks.push(new THREE.VectorKeyframeTrack(`${T.hips.name}.position`, times, hipPos));
  return new THREE.AnimationClip(name || clip.name, clip.duration, tracks);
}
