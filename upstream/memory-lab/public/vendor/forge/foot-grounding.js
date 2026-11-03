// 复制自 asset-forge 7ef1af2（public/foot-grounding.js），勿在此修改。
import * as THREE from 'three';

export const CONTACT_CLEARANCE = 0.003;
export const CONTROLLER_GAP = 0.02;

/** Shoe vertices are sampled after skinning; ankle height alone changes as a foot rolls. */
export function createFootProbes(object, feet) {
  object.updateMatrixWorld(true);
  const restBottom = new THREE.Box3().setFromObject(object, true).min.y;
  return feet.map(foot => {
    const family = new Set(); foot.traverse(b => { if (b.isBone) family.add(b); });
    const samples = [];
    object.traverse(mesh => {
      const a = mesh.geometry?.attributes;
      if (!mesh.isSkinnedMesh || !a?.skinIndex || !a.skinWeight) return;
      const indices = [];
      for (let i = 0; i < a.position.count; i++) {
        let weight = 0;
        for (let k = 0; k < 4; k++) if (family.has(mesh.skeleton.bones[a.skinIndex.getComponent(i, k)])) weight += a.skinWeight.getComponent(i, k);
        if (weight > 0.5) indices.push(i);
      }
      if (indices.length) samples.push({ mesh, indices });
    });
    return { foot, samples, ankle: foot.getWorldPosition(new THREE.Vector3()).y - restBottom };
  });
}

/** Sample the lowest shoe point in four sectors, so heel and toe can meet different ground heights. */
export function footContacts(probes, surfaceAt) {
  const contacts = [], p = new THREE.Vector3(), ankle = new THREE.Vector3();
  for (const probe of probes) {
    probe.foot.getWorldPosition(ankle);
    const sectors = [null, null, null, null];
    for (const { mesh, indices } of probe.samples) for (const i of indices) {
      mesh.getVertexPosition(i, p).applyMatrix4(mesh.matrixWorld);
      const sector = (p.x >= ankle.x ? 1 : 0) + (p.z >= ankle.z ? 2 : 0);
      if (!sectors[sector] || p.y < sectors[sector].y) sectors[sector] = p.clone();
    }
    const points = sectors.filter(Boolean);
    if (!points.length) points.push(ankle.clone().add(new THREE.Vector3(0, -probe.ankle, 0)));
    for (const point of points) {
      const ground = surfaceAt(point.x, point.y, point.z);
      if (Number.isFinite(ground)) contacts.push({ sole: point.y, ground, gap: point.y - ground });
    }
  }
  return contacts;
}

/** Never pull an animated foot down: running flight and the swing leg remain intact.
 * Raise immediately to prevent penetration; ease only the release of extra lift. */
export function contactLift(previous, contacts, dt, { maxLift = 0.3, clearance = CONTACT_CLEARANCE } = {}) {
  const required = Math.min(maxLift, Math.max(0, ...contacts.map(c => clearance - c.gap)));
  if (required >= previous) return required;
  return required + (previous - required) * Math.exp(-Math.max(0, dt) * 18);
}
