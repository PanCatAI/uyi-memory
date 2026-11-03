// Left column: the scene drawn with primitives (or GLBs imported from 造物台), characters that move, and speech bubbles.
// A save imported from 造物台 (scene.studio, 2.0 C3) shows the real camp: environment mesh, object and filler models
// placed as in the studio layout, dusk lighting, and 岚 as a rigged model playing UAL clips (scenes/clips.json).
import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createCharacterRig } from './character-rig.js';

const CHAR_HEIGHT = 1.6;

export function createScene3d(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  container.appendChild(renderer.domElement);
  const labels = new CSS2DRenderer();
  labels.domElement.style.cssText = 'position:absolute;inset:0;pointer-events:none';
  container.appendChild(labels.domElement);
  const scene3 = new THREE.Scene();
  scene3.background = new THREE.Color('#cfe3ea');
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
  camera.position.set(0, 24, 27);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 2.5);
  controls.maxPolarAngle = Math.PI / 2.1;
  const hemi = new THREE.HemisphereLight('#ffffff', '#8a7a5a', 2.2);
  scene3.add(hemi);
  const sun = new THREE.DirectionalLight('#ffffff', 1.4);
  sun.position.set(10, 20, 8);
  scene3.add(sun);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  // Sky presets by the world clock (2.0 C5). 白天/黄昏/夜里 are 造物台's default/dusk/night (asset-forge public/scene.js
  // LIGHTING and SKY); 清晨 is a cool, low morning made in the same style.
  const SKIES = {
    清晨: { sky: '#c9d6f0', groundCol: '#4a4232', hemi: 0.9, sun: '#ffc9a0', sunI: 1.1, sunPos: [8, 3, 5], fog: ['#b9c4d8', 16, 70], exposure: 1.05, stops: ['#6f86b8', '#a9b9da', '#e8c7c0', '#f6d6b0'] },
    白天: { sky: '#ffffff', groundCol: '#8a7f6a', hemi: 1.1, sun: '#fff4e0', sunI: 2.2, sunPos: [6, 10, 4], fog: null, exposure: 1, stops: ['#7fa7d9', '#a9c6e8', '#cfe0ef', '#e6eef2'] },
    黄昏: { sky: '#8aa5df', groundCol: '#3a3024', hemi: 0.75, sun: '#ffad70', sunI: 0.85, sunPos: [-7, 4, -5], fog: ['#3d4a72', 14, 62], exposure: 1.08, stops: ['#18203f', '#34456f', '#9a6d7e', '#e29a62'] },
    夜里: { sky: '#3a4a7a', groundCol: '#141210', hemi: 0.3, sun: '#9fb4ff', sunI: 0.25, sunPos: [4, 9, -3], fog: ['#121a2e', 10, 50], exposure: 1.1, stops: ['#05080f', '#0e1830', '#1a2a4d', '#2a3a60'] }
  };
  function skyTexture(stops) {
    const c = document.createElement('canvas'); c.width = 4; c.height = 256;
    const g = c.getContext('2d'), gr = g.createLinearGradient(0, 0, 0, 256);
    stops.forEach((col, i) => gr.addColorStop(i / (stops.length - 1), col)); g.fillStyle = gr; g.fillRect(0, 0, 4, 256);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  }
  let skyKey = null;
  /** env: { sky, weather } from /api/state (null for indoor/old scenes → the old flat light). */
  function setLighting(studio, env) {
    const key = studio ? `${env?.sky || '黄昏'}|${env?.weather || ''}` : 'flat';
    if (key === skyKey) return;
    skyKey = key;
    if (studio) {
      const L = SKIES[env?.sky] || SKIES.黄昏;
      scene3.background = skyTexture(L.stops);
      hemi.color.set(L.sky); hemi.groundColor.set(L.groundCol); hemi.intensity = L.hemi * 2;
      sun.color.set(L.sun); sun.intensity = L.sunI * 2; sun.position.set(...L.sunPos).multiplyScalar(3);
      const fog = env?.weather === '起雾' ? [L.fog?.[0] || '#c8cdd4', 3, 18] : ['阴', '小雨', '大雨'].includes(env?.weather) ? [L.fog?.[0] || '#9aa3ad', 10, 45] : env?.weather === '雪' ? ['#d8dde4', 8, 40] : L.fog;
      scene3.fog = fog ? new THREE.Fog(...fog) : null;
      if (['阴', '小雨', '大雨', '雪'].includes(env?.weather)) sun.intensity *= env.weather === '大雨' ? 0.3 : 0.45; // 3.0 F2: the new kinds too
      renderer.toneMappingExposure = L.exposure;
    } else {
      scene3.background = new THREE.Color('#cfe3ea');
      hemi.color.set('#ffffff'); hemi.groundColor.set('#8a7a5a'); hemi.intensity = 2.2;
      sun.color.set('#ffffff'); sun.intensity = 1.4; sun.position.set(10, 20, 8);
      scene3.fog = null; renderer.toneMappingExposure = 1;
    }
  }

  const root = new THREE.Group();
  scene3.add(root);
  const objects = new Map(); // id → { group, def }
  const chars = new Map();   // id → { group, body, label, bubble, target, held }
  const tweens = [];
  const glbs = new Map();    // id → url
  const loader = new GLTFLoader();
  let pickFn = () => {};
  let sceneDef = null;
  let assetBase = '';           // /api/assets/<save>/ for a studio save
  let loadToken = 0;            // a newer load() makes older async model loads drop their result
  let clipsCfg = null;
  const gltfCache = new Map();  // url → Promise<gltf>
  const loadGltf = url => { if (!gltfCache.has(url)) gltfCache.set(url, loader.loadAsync(url).catch(e => { gltfCache.delete(url); throw e; })); return gltfCache.get(url); };
  const studioUrl = p => assetBase + p.split('/').map(encodeURIComponent).join('/');

  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    renderer.setSize(w, h); labels.setSize(w, h);
    camera.aspect = w / h;
    // Keep the whole island in view in a narrow column: widen the vertical FOV when the view is tall.
    camera.fov = Math.min(80, Math.max(45, (2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(21)) / camera.aspect) * 180) / Math.PI));
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(container);

  function label(text, cls = 'label3d') {
    const el = document.createElement('div');
    el.className = cls; el.textContent = text;
    return new CSS2DObject(el);
  }

  function primitive(def) {
    const color = new THREE.Color(def.color || '#999');
    const [a = 0.5, b = 0.5, c = 0.5] = def.size || [];
    let geo;
    if (def.shape === 'cylinder') geo = new THREE.CylinderGeometry(a, a, b, 24);
    else if (def.shape === 'sphere') geo = new THREE.SphereGeometry(a, 20, 14);
    else geo = new THREE.BoxGeometry(a, b, c);
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.8 }));
    mesh.userData.height = def.shape === 'sphere' ? a * 2 : b;
    return mesh;
  }

  /**
   * Which horizontal way a character model faces, so it can be turned to +z (toward the default camera).
   * The arms (T/A pose) make the side-to-side axis the wider one, so forward is the other axis; the toes give the
   * sign, because the feet stick out past the shins at the front. Returns 0 (no turn) when either is unclear.
   */
  function faceForwardYaw(model) {
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model, true);
    const h = box.max.y - box.min.y;
    const size = box.getSize(new THREE.Vector3());
    if (Math.abs(size.x - size.z) < h * 0.05) return 0;
    const axis = size.x > size.z ? 'z' : 'x';
    const feet = { min: Infinity, max: -Infinity }, shins = { min: Infinity, max: -Infinity };
    const v = new THREE.Vector3();
    model.traverse(o => {
      if (!o.isMesh) return;
      const pos = o.geometry.attributes.position;
      for (let i = 0; i < pos.count; i += Math.max(1, Math.floor(pos.count / 30000))) {
        o.getVertexPosition(i, v);
        if (o.isSkinnedMesh) o.applyBoneTransform(i, v);
        v.applyMatrix4(o.matrixWorld);
        const y = (v.y - box.min.y) / h;
        const band = y < 0.05 ? feet : y > 0.1 && y < 0.25 ? shins : null;
        if (band) { band.min = Math.min(band.min, v[axis]); band.max = Math.max(band.max, v[axis]); }
      }
    });
    if (!Number.isFinite(feet.min) || !Number.isFinite(shins.min)) return 0;
    const ahead = feet.max - shins.max, behind = shins.min - feet.min; // how far the feet stick out each way
    if (Math.abs(ahead - behind) < h * 0.01) return 0;
    const sign = ahead > behind ? 1 : -1;
    // Yaw that maps the forward direction onto +z.
    return axis === 'z' ? (sign > 0 ? 0 : Math.PI) : (sign > 0 ? -Math.PI / 2 : Math.PI / 2);
  }

  /** Replaces a group's visible model with a GLB, scaled to `height`, feet on the ground. */
  function applyGlb(group, url, height, centered) {
    const id = group.userData.id;
    loader.load(url, gltf => {
      const model = gltf.scene;
      if (group.userData.kind === 'character') model.rotation.y = faceForwardYaw(model);
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const s = height / (size.y || 1);
      model.scale.setScalar(s);
      const b2 = new THREE.Box3().setFromObject(model);
      const center = b2.getCenter(new THREE.Vector3());
      model.position.set(-center.x, -b2.min.y - (centered ? height / 2 : 0), -center.z);
      group.userData.body.visible = false;
      model.userData.baseScale = s;
      if (group.userData.seated) model.scale.y = s * 0.62;
      group.userData.glb?.removeFromParent();
      group.userData.glb = model;
      group.add(model);
    }, undefined, err => {
      // Keep whatever was shown before (the primitive or the previous GLB) and say why.
      glbErrorFn?.(id, err?.message || String(err));
    });
  }

  function addObject(def) {
    const group = new THREE.Group();
    const body = primitive(def);
    group.add(body);
    group.userData = { id: def.id, body, kind: 'object' };
    const lab = label(def.name);
    lab.position.set(0, body.userData.height / 2 + 0.3, 0);
    group.add(lab);
    group.position.set(...def.pos);
    root.add(group);
    const entry = { group, def, label: lab, light: null };
    objects.set(def.id, entry);
    if (def.model && sceneDef?.studio) applyStudioModel(entry);
    else if (glbs.has(def.id)) applyGlb(group, glbs.get(def.id), body.userData.height, true);
    return entry;
  }

  /** A studio object: its model as placed in the layout (rotation and scale on the model, position on the group). */
  function applyStudioModel(entry) {
    const token = loadToken, { def, group } = entry;
    loadGltf(studioUrl(def.model)).then(gltf => {
      if (token !== loadToken || objects.get(def.id) !== entry) return;
      const model = gltf.scene.clone(true);
      model.rotation.set(...(def.rot || [0, 0, 0]));
      model.scale.setScalar(def.scale || 1);
      group.userData.body.visible = false;
      group.add(model);
      group.userData.glb = model;
      const box = new THREE.Box3().setFromObject(model);
      entry.label.position.set(0, box.max.y + 0.25, 0);
      entry.label.element.classList.add('small');
      if ((def.tags || []).includes('fire')) entry.fireTop = box.max.y;
      syncLight(entry, entry.lastState);
    }).catch(err => glbErrorFn?.(def.id, err?.message || String(err)));
  }
  // Fire (lit) and lantern (on) carry a warm point light.
  function syncLight(entry, st = {}) {
    entry.lastState = st;
    const tags = entry.def.tags || [];
    const on = tags.includes('fire') ? Boolean(st.lit) : 'on' in st ? Boolean(st.on) : false;
    const fire = tags.includes('fire');
    if (on && !entry.light) {
      entry.light = new THREE.PointLight(fire ? '#ff983f' : '#fff2a8', fire ? 18 : (sceneDef?.studio ? 3.2 : 30), fire ? 10 : (sceneDef?.studio ? 4.5 : 30), sceneDef?.studio ? 1.6 : 2);
      entry.light.position.y = fire ? (entry.fireTop ?? 0.3) + 0.2 : 0.2;
      entry.group.add(entry.light);
    }
    if (!on && entry.light) { entry.light.removeFromParent(); entry.light = null; }
    const mat = entry.group.userData.body.material;
    if (!sceneDef?.studio && 'on' in st) mat.emissive = new THREE.Color(on ? '#ffd84a' : '#000');
  }

  /** The environment mesh and the display-only fillers (decor), placed as in the studio layout. */
  function loadStudioEnv(studio) {
    const token = loadToken;
    const far = new THREE.Mesh(new THREE.CircleGeometry(120, 48), new THREE.MeshBasicMaterial({ color: '#2a3926' }));
    far.rotation.x = -Math.PI / 2; far.position.y = -0.32;
    root.add(far);
    if (studio.env_model) loadGltf(studioUrl(studio.env_model)).then(g => { if (token === loadToken) root.add(g.scene.clone(true)); }).catch(err => glbErrorFn?.('环境', err.message));
    for (const d of studio.decor || []) {
      if (!d.model) continue;
      loadGltf(studioUrl(d.model)).then(g => {
        if (token !== loadToken) return;
        const m = g.scene.clone(true);
        m.position.set(...d.pos); m.rotation.set(...(d.rot || [0, 0, 0])); m.scale.setScalar(d.scale || 1);
        root.add(m);
      }).catch(() => {});
    }
  }

  /** Left hand on +x means the model faces +z (asset-forge faceForward); falls back to the toe heuristic. */
  function studioFacing(model) {
    const H = {}; model.traverse(o => { const n = o.name.toLowerCase().replace(/^mixamorig[:_]?/, ''); if (/^(l_|left)hand$/.test(n)) H.l = o; if (/^(r_|right)hand$/.test(n)) H.r = o; });
    if (!H.l || !H.r) return faceForwardYaw(model);
    model.updateMatrixWorld(true);
    const v = H.l.getWorldPosition(new THREE.Vector3()).sub(H.r.getWorldPosition(new THREE.Vector3()));
    return Math.round(Math.atan2(v.z, v.x) / (Math.PI / 2)) * (Math.PI / 2);
  }

  /** 岚 from 造物台: rigged model + UAL libraries, Idle_Loop to start. */
  async function loadStudioCharacter(e, def, studio) {
    const token = loadToken;
    try {
      const [gltf, ...libs] = await Promise.all([loadGltf(studioUrl(def.model)), ...(studio.animations || []).map(a => loadGltf(studioUrl(a.model)))]);
      clipsCfg ??= await fetch('/api/clips').then(r => r.json());
      if (token !== loadToken) return;
      const holder = new THREE.Group();
      // gltf is cached across save loads; animate a copy so the cached scene keeps its bind pose for the next load.
      const model = SkeletonUtils.clone(gltf.scene);
      model.rotation.y = studioFacing(model);
      model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model);
      const h = box.max.y - box.min.y;
      const s = h > 1.2 && h < 2.2 ? 1 : 1.65 / (h || 1); // keep the studio's metres unless the model is off-scale
      holder.scale.setScalar(s);
      model.position.y -= box.min.y;
      holder.add(model);
      e.group.userData.body.visible = false;
      e.group.add(holder);
      e.group.userData.glb = holder;
      e.rig = createCharacterRig(model, libs, clipsCfg, name => { console.warn(`缺少片段 ${name}，用 ${clipsCfg.fallback} 代替`); noticeFn?.(`缺少片段 ${name}`); });
      e.rig.play(e.seated ? 'sit' : 'stand');
      if (lastWorld) update(lastWorld, true);
    } catch (err) { glbErrorFn?.(def.id, err?.message || String(err)); }
  }

  function load(scene, world, opts = {}) {
    sceneDef = scene;
    loadToken++;
    assetBase = opts.assetBase || '';
    const studio = Boolean(scene.studio && assetBase);
    skyKey = null;
    setLighting(studio, opts.env);
    lastEnv = opts.env ?? null; setWeatherFx(lastEnv);
    // Frame the ground: the island (30 m) keeps its old view, a small camp (8 m) gets a close one.
    const k = scene.ground.size / 30;
    camera.position.set(0, 24 * k + 1.5, 27 * k + 1.5);
    controls.target.set(0, 0, 2.5 * k);
    controls.update();
    // Labels and bubbles are DOM elements: removing their group from the scene does not take them off the page.
    root.traverse(o => { if (o.isCSS2DObject) o.element.remove(); });
    for (const c of chars.values()) clearTimeout(c.timer);
    root.clear(); objects.clear(); chars.clear(); tweens.length = 0;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(scene.ground.size, scene.ground.size), new THREE.MeshStandardMaterial({ color: scene.ground.color }));
    ground.rotation.x = -Math.PI / 2;
    root.add(ground);
    ground.visible = !studio;
    if (studio) loadStudioEnv(scene.studio);
    for (const r of scene.rooms) {
      if (studio) { drawOutline(r); continue; }
      if (r.poly) { drawPoly(r); continue; }
      const [x0, z0, x1, z1] = r.box;
      const floor = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, 0.05, z1 - z0), new THREE.MeshStandardMaterial({ color: r.color }));
      floor.position.set((x0 + x1) / 2, 0.025, (z0 + z1) / 2);
      root.add(floor);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(x1 - x0, 0.6, z1 - z0)), new THREE.LineBasicMaterial({ color: '#6b7380' }));
      edges.position.set((x0 + x1) / 2, 0.3, (z0 + z1) / 2);
      root.add(edges);
      const l = label(r.name, 'label3d room');
      l.position.set(x0 + 0.8, 0.8, z0 + 0.3);
      root.add(l);
    }
    for (const c of scene.characters) {
      const group = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.35, CHAR_HEIGHT - 0.7, 6, 16), new THREE.MeshStandardMaterial({ color: c.color }));
      body.position.y = CHAR_HEIGHT / 2;
      group.add(body);
      group.userData = { id: c.id, body, kind: 'character' };
      const name = label(c.name);
      name.position.set(0, CHAR_HEIGHT + 0.3, 0);
      group.add(name);
      const bubbleEl = document.createElement('div');
      bubbleEl.className = 'bubble3d'; bubbleEl.hidden = true;
      const bubble = new CSS2DObject(bubbleEl);
      bubble.position.set(0, CHAR_HEIGHT + 0.9, 0);
      group.add(bubble);
      group.position.set(...c.pos);
      root.add(group);
      const entry = { group, bubble, bubbleEl, timer: 0, rig: null, talking: false };
      chars.set(c.id, entry);
      if (studio && c.model) loadStudioCharacter(entry, c, scene.studio);
      else if (glbs.has(c.id)) applyGlb(group, glbs.get(c.id), CHAR_HEIGHT, false);
    }
    update(world, true);
  }

  // Studio camp: the areas are only faint outlines on the real ground (no floors over the environment mesh).
  function drawOutline(r) {
    const pts = (r.poly || [[r.box[0], r.box[1]], [r.box[2], r.box[1]], [r.box[2], r.box[3]], [r.box[0], r.box[3]]]).map(([x, z]) => new THREE.Vector3(x, 0.05, z));
    pts.push(pts[0].clone());
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: '#e8d9b0', transparent: true, opacity: 0.25 }));
    root.add(line);
  }

  // Polygon area (the camp): flat floor + outline at ground level, label at the first corner.
  function drawPoly(r) {
    const shape = new THREE.Shape(r.poly.map(([x, z]) => new THREE.Vector2(x, -z)));
    const floor = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshStandardMaterial({ color: r.color }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0.02;
    root.add(floor);
    const pts = [...r.poly, r.poly[0]].map(([x, z]) => new THREE.Vector3(x, 0.04, z));
    root.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: '#6b7380' })));
    const [cx, , cz] = roomCenter(r.id);
    const l = label(r.name, 'label3d room');
    l.position.set(cx, 0.6, cz);
    root.add(l);
  }

  function roomCenter(id) {
    const r = sceneDef.rooms.find(q => q.id === id);
    if (r?.center) return [r.center[0], 0, r.center[1]];
    if (r?.poly) return [r.poly.reduce((a, p) => a + p[0], 0) / r.poly.length, 0, r.poly.reduce((a, p) => a + p[1], 0) / r.poly.length];
    const b = r?.box || [0, 0, 0, 0];
    return [(b[0] + b[2]) / 2, 0, (b[1] + b[3]) / 2];
  }

  function inRoom(id, x, z) {
    const r = sceneDef.rooms.find(q => q.id === id);
    if (!r) return false;
    if (r.box) return x >= r.box[0] && x <= r.box[2] && z >= r.box[1] && z <= r.box[3];
    let inside = false;
    for (let i = 0, k = r.poly.length - 1; i < r.poly.length; k = i++) {
      const [xi, zi] = r.poly[i], [xk, zk] = r.poly[k];
      if ((zi > z) !== (zk > z) && x < ((xk - xi) * (z - zi)) / (zk - zi) + xi) inside = !inside;
    }
    return inside;
  }

  function moveTo(group, pos, instant) {
    const to = new THREE.Vector3(...pos);
    for (let i = tweens.length - 1; i >= 0; i--) if (tweens[i].group === group) tweens.splice(i, 1);
    if (instant || group.position.distanceTo(to) < 0.01) { group.position.copy(to); return; }
    tweens.push({ group, from: group.position.clone(), to, t: 0 });
  }

  /** Syncs everything to a world state (from /api/state). */
  // ---- 2.0 C4: action playback. The server sends each walked action's path; the browser only plays it. ----
  const SPEED = 1.2; // m/s
  const walkers = []; // { e, pts, seg, resolve }
  const wait = s => new Promise(r => setTimeout(r, s * 1000));
  function walk(e, pts) {
    return new Promise(resolve => {
      const g = e.group;
      const full = [[g.position.x, g.position.z], ...pts];
      walkers.push({ e, pts: full, seg: 1, resolve });
      e.rig?.play('walk');
    });
  }
  function stepWalkers(dt) {
    for (let i = walkers.length - 1; i >= 0; i--) {
      const w = walkers[i], g = w.e.group;
      let left = SPEED * dt;
      while (left > 0 && w.seg < w.pts.length) {
        const [tx, tz] = w.pts[w.seg], dx = tx - g.position.x, dz = tz - g.position.z, d = Math.hypot(dx, dz);
        if (d > 1e-3) g.rotation.y = Math.atan2(dx, dz);
        if (d <= left) { g.position.x = tx; g.position.z = tz; left -= d; w.seg++; }
        else { g.position.x += (dx / d) * left; g.position.z += (dz / d) * left; left = 0; }
      }
      if (w.seg >= w.pts.length) { walkers.splice(i, 1); w.resolve(); }
    }
  }
  async function playOne(e, ev, world) {
    const p = ev.payload || {};
    const c = world?.characters?.[ev.actor];
    if (ev.action === 'leave' && p.path) { e.group.visible = true; e.group.position.set(p.path[0][0], 0, p.path[0][1]); e.seated = false; e.rig?.play('stand'); return; }
    if (p.path) {
      if (e.seated) { setSeated(e, false, c?.name || ''); }
      await walk(e, p.path);
    }
    const rig = e.rig;
    if (ev.action === 'sit') {
      const seat = objects.get(ev.target);
      if (seat?.def.facing != null) e.group.rotation.y = THREE.MathUtils.degToRad(seat.def.facing);
      setSeated(e, true, c?.name || '');
      await wait(1.2);
    } else if (ev.action === 'enter') { rig?.play('stand'); await wait(0.3); e.group.visible = false; }
    else if (['pick_up', 'put_down'].includes(ev.action) && rig) { rig.play('pick_up', { after: 'stand' }); await wait(1); }
    else if (ev.action === 'tend_fire' && rig) { rig.play('tend_fire', { after: 'stand' }); await wait(2); }
    else if (ev.action === 'wave' && rig) { rig.play('wave', { after: e.seated ? 'sit' : 'stand' }); await wait(1.5); }
    else if (ev.action === 'draw_map' && rig) rig.play('draw_map');
    else if (rig && rig.state === 'walk') rig.play(e.seated ? 'sit' : 'stand');
  }
  /** Plays a turn's events in order (at most 3 actions a turn), then syncs to the final world. */
  function play(events, world) {
    for (const ev of events || []) {
      if (ev.type !== 'char_action' || ev.outcome !== 'ok') continue;
      const e = chars.get(ev.actor);
      if (!e) continue;
      e.busy = (e.busy || Promise.resolve()).then(() => playOne(e, ev, world)).catch(err => console.warn(err));
      const mine = e.busy;
      mine.then(() => { if (e.busy === mine) { e.busy = null; if (lastWorld) update(lastWorld); } });
    }
  }

  // ── 3.0 F6: what the world's rules did, visible: rain / snow, a squashed tent, a wet wood pile, a muddy cup, tracks ──
  let lastEnv = null;
  const FX_MAX = 1500;
  let fx = null; // { points, kind, speed, slant }
  function setWeatherFx(env) {
    const kind = ['小雨', '大雨', '雪'].includes(env?.weather) ? env.weather : null;
    const windy = env?.weather === '大风' || env?.wind === '5 级';
    if (fx?.kind === kind && fx?.windy === windy) return;
    if (fx) { fx.points.removeFromParent(); fx.points.geometry.dispose(); fx = null; }
    if (!kind) return;
    const snow = kind === '雪';
    // Rain is short streaks (two points per drop, LineSegments); snow is flakes (Points). FX_MAX vertices at most.
    const n = kind === '大雨' ? FX_MAX / 2 : kind === '小雨' ? 300 : 900;
    const per = snow ? 1 : 2, len = kind === '大雨' ? 0.45 : 0.3;
    const pos = new Float32Array(n * per * 3);
    for (let i = 0; i < n; i++) {
      const x = (Math.random() - 0.5) * 16, y = Math.random() * 12, z = (Math.random() - 0.5) * 16 + 1;
      pos.set([x, y, z], i * per * 3);
      if (!snow) pos.set([x - len * (windy ? 0.5 : 0.05), y + len, z], i * per * 3 + 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const obj = snow
      ? new THREE.Points(geo, new THREE.PointsMaterial({ color: '#ffffff', size: 0.16, transparent: true, opacity: 0.95, depthWrite: false }))
      : new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: '#5d7ea6', transparent: true, opacity: kind === '大雨' ? 0.75 : 0.55, depthWrite: false }));
    fx = { kind, windy, per, points: obj, speed: snow ? 0.8 : kind === '大雨' ? 9 : 6, slant: windy ? 0.5 : snow ? 0.15 : 0.05 };
    scene3.add(obj);
  }
  function stepWeatherFx(dt) {
    if (!fx) return;
    const a = fx.points.geometry.attributes.position;
    const dx = fx.speed * fx.slant * dt, dy = fx.speed * dt;
    for (let i = 0; i < a.count; i += fx.per) {
      let shiftY = -dy, shiftX = dx;
      if (a.getY(i) - dy < 0) { shiftY += 12; shiftX = (Math.random() - 0.5) * 16 - a.getX(i); }
      else if (a.getX(i) + dx > 8) shiftX -= 16;
      for (let k = 0; k < fx.per; k++) a.setXY(i + k, a.getX(i + k) + shiftX, a.getY(i + k) + shiftY);
    }
    a.needsUpdate = true;
  }
  const baseColor = new Map(); // object id → its color before the mud
  function syncDirty(e, state) {
    const mesh = e.group.userData.body;
    if (!mesh?.material?.color) return;
    if (!baseColor.has(e.group.userData.id)) baseColor.set(e.group.userData.id, mesh.material.color.clone());
    const base = baseColor.get(e.group.userData.id);
    mesh.material.color.copy(state.dirty ? base.clone().multiplyScalar(0.35) : base);
  }
  const campFx = new THREE.Group();
  scene3.add(campFx);
  let campKey = null;
  function syncCamp(world, env) {
    const v = world.vars || {};
    const tracks = Boolean(world.incidents?.fox_food);
    const key = `${v.tent_down}|${v.wood_wet}|${tracks}`;
    // The tent squashed to half height while it is down.
    const tent = objects.get('tent-1');
    if (tent) tent.group.scale.y = v.tent_down ? 0.5 : 1;
    if (key === campKey) return;
    campKey = key;
    campFx.clear();
    const crate = world.objects['wood-crate-1'];
    if (v.wood_wet && crate) {
      const pile = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.25, 0.35), new THREE.MeshStandardMaterial({ color: '#3b2e22', roughness: 1 }));
      pile.position.set(crate.pos[0] - 0.65, 0.13, crate.pos[2] + 0.1);
      campFx.add(pile);
    }
    if (tracks && crate) {
      for (let i = 0; i < 5; i++) {
        const dot = new THREE.Mesh(new THREE.CircleGeometry(0.06, 12), new THREE.MeshStandardMaterial({ color: '#2a2018' }));
        dot.rotation.x = -Math.PI / 2;
        dot.position.set(crate.pos[0] + 0.5 + i * 0.22, 0.01, crate.pos[2] + 0.4 + (i % 2) * 0.12);
        campFx.add(dot);
      }
    }
    void env;
  }

  let lastWorld = null;
  function update(world, instant = false, env) {
    lastWorld = world;
    if (env !== undefined) { lastEnv = env; setWeatherFx(env); }
    if (env !== undefined) setLighting(Boolean(sceneDef?.studio && assetBase), env);
    for (const id of [...objects.keys()]) if (!world.objects[id]) { objects.get(id).group.removeFromParent(); objects.delete(id); }
    for (const [id, o] of Object.entries(world.objects)) {
      const e = objects.get(id) || addObject(o);
      const holder = o.worn_by || o.holder;
      const hand = holder && !o.worn_by && chars.get(holder)?.rig?.rightHand;
      if (hand) {
        // Held by a rigged character: in the right hand, at its own world size.
        if (e.group.parent !== hand) { hand.add(e.group); }
        hand.updateMatrixWorld(true);
        const ws = hand.getWorldScale(new THREE.Vector3());
        e.group.scale.set(1 / ws.x, 1 / ws.y, 1 / ws.z);
        e.group.position.set(0, 0, 0);
        e.label.visible = false;
      } else if (holder && chars.has(holder)) {
        const cg = chars.get(holder).group;
        if (e.group.parent !== cg) cg.add(e.group);
        e.group.scale.set(1, 1, 1);
        e.group.position.set(o.worn_by ? 0 : 0.45, o.worn_by ? CHAR_HEIGHT - 0.25 : CHAR_HEIGHT + 0.1, o.worn_by ? 0.3 : 0);
        e.label.visible = false;
      } else if (holder === 'user') {
        e.group.visible = false;
      } else {
        if (e.group.parent !== root) root.add(e.group);
        e.group.scale.set(1, 1, 1);
        e.group.visible = true; e.label.visible = true;
        moveTo(e.group, o.pos, instant);
      }
      syncLight(e, o.state || {});
      syncDirty(e, o.state || {});
    }
    syncCamp(world, env ?? lastEnv);
    for (const [i, [id, c]] of Object.entries(world.characters).entries()) {
      const e = chars.get(id);
      if (!e || (e.busy && !instant)) continue; // playing a walk: the final world is applied when it ends
      if (instant) e.busy = null;
      // In the walled tent: not shown (C4); out again, visible.
      const inTent = sceneDef?.studio && !sceneDef.rooms.find(r => r.id === c.room)?.group;
      e.group.visible = !inTent;
      let pos = c.pos;
      if (sceneDef?.studio) pos = c.pos; // the server knows exactly where she stands (path ends)
      else if (c.room) {
        const center = roomCenter(c.room);
        const here = p => inRoom(c.room, p[0], p[2]);
        if (!here(e.group.position.toArray()) || instant) pos = here(c.pos) && !(c.pos[0] === center[0] && c.pos[2] === center[2]) ? c.pos : [center[0] + i * 0.9, 0, center[2]];
        else pos = e.group.position.toArray();
      }
      // Sitting is visible: on the seat, lower and squatter, and the name says so.
      const seat = c.sitting && objects.get(c.sitting);
      if (seat) pos = seat.def.sit && e.rig ? [seat.def.sit[0], 0, seat.def.sit[2]] : seat.group.position.toArray();
      e.seatYaw = seat && e.rig && seat.def.facing != null ? THREE.MathUtils.degToRad(seat.def.facing) : null;
      if (e.seatYaw != null && (instant || e.group.position.distanceTo(new THREE.Vector3(pos[0], 0, pos[2])) < 0.01)) e.group.rotation.y = e.seatYaw;
      setSeated(e, Boolean(seat), c.name);
      const y = c.elevated ? 7 : 0;
      moveTo(e.group, [pos[0], y, pos[2]], instant);
    }
  }

  function setSeated(e, seated, name) {
    const g = e.group;
    if (g.userData.seated === seated) return;
    g.userData.seated = seated;
    e.seated = seated;
    if (e.rig) {
      // Rigged: the sitting clips do the posing (appendix B), no squashing.
      e.rig.play(seated ? 'sit_enter' : 'stand');
      const lab = g.children.find(x => x.isCSS2DObject && x.element.className.includes('label3d'));
      if (lab) lab.element.textContent = seated ? `${name}（坐着）` : name;
      return;
    }
    const k = seated ? 0.62 : 1;
    g.userData.body.scale.y = k;
    g.userData.body.position.y = (CHAR_HEIGHT / 2) * k;
    const m = g.userData.glb;
    if (m) m.scale.y = (m.userData.baseScale || 1) * k;
    const lab = g.children.find(x => x.isCSS2DObject && x.element.className.includes('label3d'));
    if (lab) { lab.element.textContent = seated ? `${name}（坐着）` : name; lab.position.y = CHAR_HEIGHT * k + 0.3; }
  }

  function say(charId, text) {
    const e = chars.get(charId);
    if (!e) return;
    e.bubbleEl.textContent = text; e.bubbleEl.hidden = false;
    clearTimeout(e.timer);
    if (e.rig) e.rig.play(e.seated ? 'sit_talk' : 'talk');
    e.timer = setTimeout(() => { e.bubbleEl.hidden = true; if (e.rig) e.rig.play(e.seated ? 'sit' : 'stand'); }, 6000);
  }

  function setGlb(id, url) {
    glbs.set(id, url);
    const o = objects.get(id);
    if (o) applyGlb(o.group, url, o.group.userData.body.userData.height, true);
    const c = chars.get(id);
    if (c) applyGlb(c.group, url, CHAR_HEIGHT, false);
  }

  const raycaster = new THREE.Raycaster(), mouse = new THREE.Vector2();
  renderer.domElement.addEventListener('click', ev => {
    const r = renderer.domElement.getBoundingClientRect();
    mouse.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(mouse, camera);
    for (const hit of raycaster.intersectObjects(root.children, true)) {
      let g = hit.object;
      while (g && !g.userData?.kind) g = g.parent;
      if (g) { pickFn(g.userData.id, g.userData.kind); return; }
    }
  });

  let last = performance.now();
  renderer.setAnimationLoop(now => {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    for (let i = tweens.length - 1; i >= 0; i--) {
      const tw = tweens[i];
      tw.t = Math.min(1, tw.t + dt);
      tw.group.position.lerpVectors(tw.from, tw.to, tw.t * tw.t * (3 - 2 * tw.t));
      // Characters turn toward where they walk (horizontal moves only; climbing keeps the facing).
      const ce = tw.group.userData.kind === 'character' && chars.get(tw.group.userData.id);
      if (ce && tw.t < 1) {
        const dx = tw.to.x - tw.from.x, dz = tw.to.z - tw.from.z;
        if (Math.hypot(dx, dz) > 0.05) { tw.group.rotation.y = Math.atan2(dx, dz); if (ce.rig && !ce.seated) ce.rig.play('walk'); }
      }
      if (tw.t >= 1) {
        tweens.splice(i, 1);
        if (ce?.seatYaw != null) tw.group.rotation.y = ce.seatYaw; // sat down: face the way the seat faces
        if (ce?.rig && ce.rig.state === 'walk') ce.rig.play(ce.seated ? 'sit_enter' : 'stand');
      }
    }
    stepWalkers(dt);
    stepWeatherFx(dt);
    for (const c of chars.values()) c.rig?.update(dt);
    controls.update();
    renderer.render(scene3, camera);
    labels.render(scene3, camera);
  });
  resize();
  let glbErrorFn = null, noticeFn = null;
  return { load, update, play, say, setGlb, onPick: fn => { pickFn = fn; }, onGlbError: fn => { glbErrorFn = fn; }, onNotice: fn => { noticeFn = fn; },
    // For tests and the console: what each character is playing.
    debug: () => [...chars].map(([id, c]) => ({ id, rigged: Boolean(c.rig), state: c.rig?.state || null, seated: Boolean(c.seated) })) };
}
