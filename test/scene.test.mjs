import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadScene, listScenes, parseCard } from '../lib/scene.mjs';
import { TABLES_BY_SAVE } from '../lib/saves.mjs';
import { freshDb } from './helpers/db.mjs';

test('island loads with cards', () => {
  const s = loadScene('island');
  assert.equal(s.rooms.length, 3);
  assert.equal(s.characters.length, 2);
  const rin = s.characters.find(c => c.id === 'rin');
  assert.ok(rin.canon.includes('不怕黑，但怕打雷。'));
  assert.match(rin.cardText, /灯塔守护人/);
  assert.deepEqual(listScenes().map(x => x.id), ['camp', 'island']);
});

test('parseCard', () => {
  const c = parseCard('# 阿乔\n\n## 设定（作者写的）\n- 打鱼\n- 不会游泳\n\n## 说话方式\n- 爽朗');
  assert.equal(c.name, '阿乔');
  assert.deepEqual(c.canon, ['打鱼', '不会游泳']);
});

test('bad scene is rejected in Chinese', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'scene-'));
  await mkdir(path.join(dir, 'scenes'));
  await writeFile(path.join(dir, 'scenes', 'bad.json'), JSON.stringify({ id: 'bad', rooms: [{ id: 'a' }], objects: [{ id: 'x', room: 'nowhere' }], palette: [], characters: [{ id: 'c', room: 'a', card: 'c.md' }], actions: {} }));
  assert.throws(() => loadScene('bad', dir), /x 所在房间不存在：nowhere/);
});

test('saves create, list, delete without leftovers', () => {
  const { db, saves, ledger, saveId } = freshDb();
  ledger.append(saveId, { type: 'session_start', actor: 'host', payload: { gap_ms: 0 } });
  const other = saves.createSave({ name: '第二个' });
  assert.equal(saves.listSaves().length, 2);
  saves.deleteSave(saveId);
  assert.deepEqual(saves.listSaves().map(s => s.id), [other.id]);
  for (const t of TABLES_BY_SAVE) assert.equal(db.prepare(`SELECT count(*) n FROM ${t} WHERE save_id = ?`).get(saveId).n, 0, t);
});
