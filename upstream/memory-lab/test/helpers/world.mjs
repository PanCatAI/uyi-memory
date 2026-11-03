import { createLab } from '../../lib/lab.mjs';
import { ALL_ON } from '../../lib/features.mjs';
import { HOUR } from '../../lib/clock.mjs';
process.env.LAB_QUIET = '1';

/** A camp save with the 3.0 world on (director 起伏 unless features say otherwise), a fixed id, session open. */
export async function worldLab({ id = 's_world1', features = {}, open = true } = {}) {
  const lab = createLab();
  const saveId = lab.saves.createSave({ name: '世界', sceneId: 'camp', id }).id;
  lab.setFeatures(saveId, { ...ALL_ON, ...features });
  if (open) await lab.session.start(saveId);
  const say = text => lab.turns.runTurn({ saveId, charId: 'lan', text });
  /** Moves world time to t (Tokyo "2026-10-21T03:00:00"), running the world on the way like a session tick does. */
  const goTo = s => { lab.clock.set(saveId, Date.parse(`${s}+09:00`)); return lab.environment.tick(saveId); };
  const hours = n => { const out = []; for (let i = 0; i < n; i++) { lab.clock.advance(saveId, HOUR); out.push(...lab.environment.tick(saveId)); } return out; };
  const vars = () => lab.ledger.world(saveId).vars;
  const evs = (type, f = () => true) => lab.ledger.list(saveId, { types: [type], all: true }).filter(f);
  return { lab, saveId, say, goTo, hours, vars, evs, at: s => Date.parse(`${s}+09:00`) };
}
