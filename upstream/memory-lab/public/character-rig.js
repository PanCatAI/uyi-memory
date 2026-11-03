// 2.0 C3: a 造物台 character with UAL clips retargeted onto it (vendor/forge/retarget.js), played by state name.
// States and their clips come from scenes/clips.json (appendix B). A clip is retargeted the first time it is needed.
import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { humanoid, retargetClip } from './vendor/forge/retarget.js';

/**
 * model: the character's gltf.scene (already in the scene graph). libs: [gltf] of the animation libraries.
 * cfg: scenes/clips.json. onMissing(name): called once per missing clip.
 */
export function createCharacterRig(model, libs, cfg, onMissing = () => {}) {
  const mixer = new THREE.AnimationMixer(model);
  const bones = humanoid(model);
  // Clips are baked lazily, while the model is already playing something; retargetClip reads the target's rest pose
  // from the bones as they are, so bake against a copy taken now (bind pose), unturned like 造物台's tgt.scene.
  const rest = SkeletonUtils.clone(model);
  rest.position.set(0, 0, 0); rest.rotation.set(0, 0, 0); rest.scale.set(1, 1, 1);
  rest.updateMatrixWorld(true);
  const baked = new Map(); // clip name → AnimationClip on this model
  const told = new Set();
  const source = new Map(); // clip name → { gltf, clip }
  for (const g of libs) for (const c of g.animations) if (!source.has(c.name)) source.set(c.name, { gltf: g, clip: c });
  let current = null, currentState = null, neck = 0;

  function bake(name) {
    if (baked.has(name)) return baked.get(name);
    const s = source.get(name);
    let clip = null;
    if (s) {
      try { clip = retargetClip(rest, s.gltf.scene, s.clip, { inPlace: true, ground: true }); }
      catch (e) { console.warn(`片段 ${name} 套不上：${e.message}`); }
    }
    baked.set(name, clip);
    return clip;
  }
  /** First clip of a state that exists; the fallback (with a one-time notice) when none does. */
  function clipFor(state) {
    const st = cfg.states[state] || { clips: [] };
    for (const n of st.clips) { const c = source.has(n) && bake(n); if (c) return { clip: c, st }; }
    const missing = st.clips[0] || state;
    if (!told.has(missing)) { told.add(missing); onMissing(missing); }
    return { clip: bake(cfg.fallback), st: { ...st, loop: true } };
  }

  /** Crossfades to `state`; a one-shot state returns to `after` (default 'stand') when done. */
  function play(state, { after } = {}) {
    if (state === currentState && current?.isRunning()) return;
    const { clip, st } = clipFor(state);
    if (!clip) return;
    const action = mixer.clipAction(clip);
    action.reset();
    action.setLoop(st.loop ? THREE.LoopRepeat : THREE.LoopOnce, st.loop ? Infinity : 1);
    action.clampWhenFinished = !st.loop;
    if (!st.loop && st.seconds) action.setEffectiveTimeScale(clip.duration / st.seconds);
    else action.setEffectiveTimeScale(1);
    action.play();
    if (current && current !== action) current.crossFadeTo(action, cfg.fade ?? 0.3, false);
    current = action; currentState = state;
    neck = st.neck ? THREE.MathUtils.degToRad(st.neck) : 0;
    if (!st.loop) {
      const next = st.then || after || 'stand';
      const done = e => { if (e.action !== action) return; mixer.removeEventListener('finished', done); if (current === action) play(next); };
      mixer.addEventListener('finished', done);
    }
  }

  function update(dt) {
    mixer.update(dt);
    if (neck && bones.neck) bones.neck.rotateX(neck); // draw_map: look down at the paper
  }

  return { play, update, get state() { return currentState; }, rightHand: bones.rightHand || null, bones };
}
