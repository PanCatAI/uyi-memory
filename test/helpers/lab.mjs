import { createLab } from '../../lib/lab.mjs';
process.env.LAB_QUIET = '1';
/** A mock-model lab with one save (island unless sceneId says otherwise) and an open session. */
export async function freshLab({ open = true, sceneId, charId: who = sceneId === 'camp' ? 'lan' : 'rin' } = {}) {
  const lab = createLab();
  const saveId = lab.saves.createSave({ name: '测试', ...(sceneId ? { sceneId } : {}) }).id;
  if (open) await lab.session.start(saveId);
  const say = (text, charId = who, compare = false) => lab.turns.runTurn({ saveId, charId, text, compare });
  return { lab, saveId, say, scene: lab.scene(saveId) };
}
