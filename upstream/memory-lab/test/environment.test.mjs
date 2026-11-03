// 2.0 C5: sky, weather and the campfire in the camp's now section; host weather / fire_out events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshLab } from './helpers/lab.mjs';
import { skyOf, weatherDay, weatherFor, WEATHER } from '../lib/environment.mjs';

const at = s => Date.parse(`${s}+09:00`);
const tend = (lab, saveId) => lab.ledger.append(saveId, { type: 'char_action', actor: 'lan', action: 'tend_fire', target: 'campfire-1', outcome: 'ok', payload: { args: {} } });
const section = (lab, turnId, name) => JSON.parse(lab.db.prepare('SELECT sections_json FROM turns WHERE id = ?').get(turnId).sections_json).find(s => s.name === name);

test('sky by the hour, weather days turn at 05:00, the same save and day always get the same weather', () => {
  assert.deepEqual(['06:00', '12:00', '18:00', '22:00', '04:59'].map(h => skyOf(at(`2026-10-20T${h}:00`))), ['清晨', '白天', '黄昏', '夜里', '夜里']);
  assert.equal(weatherDay(at('2026-10-21T04:00:00')), '2026-10-20');
  assert.equal(weatherDay(at('2026-10-21T05:00:00')), '2026-10-21');
  assert.equal(weatherFor('save_a', '2026-10-21'), weatherFor('save_a', '2026-10-21'));
  assert.ok(WEATHER.includes(weatherFor('save_b', '2026-10-21')));
  const seen = new Set(Array.from({ length: 40 }, (_, i) => weatherFor('save_a', `2026-11-${String(i % 28 + 1).padStart(2, '0')}`)));
  assert.ok(seen.size > 1, 'not one weather forever');
});

test('one weather event per world day, and the now section has 天色, 天气 and 篝火', async () => {
  const { lab, saveId, say } = await freshLab({ sceneId: 'camp' });
  const weather = () => lab.ledger.list(saveId, { types: ['weather'], all: true });
  assert.equal(weather().length, 1);
  assert.equal(weather()[0].payload.day, '2026-10-20');
  const r = await say('今天天气怎么样');
  await say('嗯');
  assert.equal(weather().length, 1, 'no second weather the same day');
  const now = section(lab, r.turnId, 'now').text;
  assert.match(now, /天色：白天/);
  assert.match(now, new RegExp(`天气：${weather()[0].payload.kind}`));
  assert.match(now, /篝火：灭了/); // camp.json starts with the fire out
  lab.session.advance(saveId, '1d');
  await say('早');
  assert.deepEqual(weather().map(e => e.payload.day), ['2026-10-20', '2026-10-21']);
  // Old scenes are not outdoor: no weather at all.
  const island = await freshLab();
  await island.say('你好');
  assert.equal(island.lab.ledger.list(island.saveId, { types: ['weather'], all: true }).length, 0);
});

test('tend_fire, then 3 world hours: one fire_out, the fire is out, and at night it is a hint', async () => {
  const { lab, saveId, say } = await freshLab({ sceneId: 'camp' });
  tend(lab, saveId);
  assert.equal(lab.ledger.world(saveId).objects['campfire-1'].state.lit, true);
  await say('火真暖');
  assert.equal(lab.ledger.list(saveId, { types: ['fire_out'], all: true }).length, 0);
  lab.session.advance(saveId, '2h');
  await say('还烧着吗');
  assert.equal(lab.ledger.list(saveId, { types: ['fire_out'], all: true }).length, 0, '2 hours: still burning');
  // 2.0 D1: her 作息 tends the fire again at 17:40 (the 17:30 slot), so it goes out 3 hours after that.
  lab.session.advance(saveId, '21:00');
  const first = await say('天黑了');
  const outs = lab.ledger.list(saveId, { types: ['fire_out'], all: true });
  assert.equal(outs.length, 1);
  assert.equal(lab.ledger.world(saveId).objects['campfire-1'].state.lit, false);
  assert.match(section(lab, first.turnId, 'now').text, /天色：夜里[\s\S]*篝火：灭了/);
  // Past the proactive cap (the first turn back may bring up the long gap; 2.0 D5 makes the cap 8 turns at 初识),
  // the out fire is offered.
  let offered = false;
  for (let i = 0; i < 10 && !offered; i++) offered = (section(lab, (await say(`有点冷${i}`)).turnId, 'hints')?.refs || []).includes(`ev:${outs[0].seq}`);
  assert.ok(offered);
  await say('嗯嗯');
  assert.equal(lab.ledger.list(saveId, { types: ['fire_out'], all: true }).length, 1, 'an out fire does not go out again');
});
