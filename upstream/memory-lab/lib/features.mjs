// 3.0 E4: which 3.0 features a save has on. Old saves and scenarios have none (features_json NULL), so everything
// from 1.0 and 2.0 behaves exactly as before; saves made in the UI get all of them.
import { j, pj } from './db.mjs';

export const FEATURES = ['voice', 'world', 'director', 'topics', 'scout', 'practices'];
export const FEATURE_TITLES = { voice: '说话监测', world: '天气和营地的量', director: '意外和导演', topics: '话头', scout: '探路和地图', practices: '共同活动和打赌' };
export const PACES = ['平静', '起伏', '热闹'];
export const ALL_ON = Object.freeze({ ...Object.fromEntries(FEATURES.map(k => [k, true])), pace: '起伏' });

/** Missing keys are off; pace defaults to 起伏. */
export function normalize(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const out = Object.fromEntries(FEATURES.map(k => [k, o[k] === true]));
  out.pace = PACES.includes(o.pace) ? o.pace : '起伏';
  if (o.director_random === false) out.director_random = false; // scenarios: only forced incidents
  if (o.debug === true) out.debug = true; // 3.0 F6: the 世界 tab's debug buttons
  return out;
}

export function createFeatures(db) {
  const cache = new Map(); // lab.scene() asks on every call; this process is the only writer
  const get = saveId => {
    if (!cache.has(saveId)) cache.set(saveId, normalize(pj(db.prepare('SELECT features_json FROM saves WHERE id = ?').get(saveId)?.features_json, null)));
    return cache.get(saveId);
  };
  const set = (saveId, patch) => {
    const next = normalize({ ...get(saveId), ...(patch || {}) });
    db.prepare('UPDATE saves SET features_json = ? WHERE id = ?').run(j(next), saveId);
    cache.set(saveId, next);
    return next;
  };
  return { get, set };
}
