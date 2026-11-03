// An in-memory lab: database + clock + ledger + one island save. No files, no network.
import { openDb } from '../../lib/db.mjs';
import { createClock } from '../../lib/clock.mjs';
import { createSaves } from '../../lib/saves.mjs';
import { createLedger } from '../../lib/ledger.mjs';
import { loadScene } from '../../lib/scene.mjs';

export function freshDb({ sceneId = 'island', userName = '你' } = {}) {
  const db = openDb(':memory:');
  const clock = createClock(db);
  const saves = createSaves(db);
  const ledger = createLedger({ db, clock });
  const save = saves.createSave({ name: '测试', sceneId, userName });
  return { db, clock, saves, ledger, save, saveId: save.id, scene: loadScene(sceneId) };
}
