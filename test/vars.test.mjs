import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { worldLab } from './helpers/world.mjs';
import { checkAction, actionEvents } from '../lib/arbiter.mjs';
import { morning } from '../lib/climate.mjs';

const W = JSON.parse(readFileSync(new URL('../scenes/camp.rules.json', import.meta.url), 'utf8')).weather;
/** Her action through the arbiter, written like a reply's action. → { ok, reason } */
function act(lab, saveId, name, target = null) {
  const st = lab.ledger.world(saveId), scene = lab.scene(saveId);
  const a = { name, target, args: {} };
  const check = checkAction(st, scene, 'lan', a);
  lab.ledger.appendMany(saveId, actionEvents(st, scene, 'lan', a, check));
  return check;
}

test('F3: tend_fire uses wood; no wood or wet wood and the fire cannot be tended', async () => {
  const { lab, saveId, vars } = await worldLab({ id: 's_vars1', features: { director: false } });
  act(lab, saveId, 'walk_to', 'campfire-1');
  for (let i = 0; i < 3; i++) assert.equal(act(lab, saveId, 'tend_fire', 'campfire-1').ok, true);
  assert.equal(vars().wood, 3);
  lab.worldsim.setVar(saveId, 'wood', 0, '测试', lab.clock.now(saveId));
  assert.deepEqual(act(lab, saveId, 'tend_fire', 'campfire-1'), { ok: false, reason: '没柴了', rule: true });
  lab.worldsim.setVar(saveId, 'wood', 2, '测试', lab.clock.now(saveId));
  lab.worldsim.setVar(saveId, 'wood_wet', true, '测试', lab.clock.now(saveId));
  assert.equal(act(lab, saveId, 'tend_fire', 'campfire-1').reason, '柴是湿的');
  const failed = lab.ledger.list(saveId, { types: ['char_action'], desc: true, limit: 1 })[0];
  assert.equal(failed.outcome, 'failed');
});

test('F3: rain on uncovered wood wets it; six dry hours by a lit fire dry it', async () => {
  const { lab, saveId, vars, hours } = await worldLab({ id: 's_vars2', features: { director: false } });
  lab.worldsim.forceWeather(saveId, '小雨');
  assert.equal(vars().wood_wet, true);
  lab.worldsim.forceWeather(saveId, '阴');
  act(lab, saveId, 'walk_to', 'campfire-1');
  lab.worldsim.setVar(saveId, 'wood_wet', false, '测试', lab.clock.now(saveId)); // light it with dry wood …
  act(lab, saveId, 'tend_fire', 'campfire-1');
  lab.worldsim.setVar(saveId, 'wood_wet', true, '测试', lab.clock.now(saveId)); // … then the pile is wet again
  const keepLit = () => lab.ledger.append(saveId, { type: 'object_changed', actor: 'host', target: 'campfire-1', payload: { field: 'state.tended_at', from: null, to: lab.clock.now(saveId) } });
  for (let i = 0; i < 5; i++) { hours(1); keepLit(); }
  assert.equal(vars().wood_wet, true, 'five hours is not enough');
  hours(1);
  assert.equal(vars().wood_wet, false);
  const covered = await worldLab({ id: 's_vars2b', features: { director: false } });
  covered.lab.turns.act(covered.saveId, { action: 'cover_wood' });
  assert.equal(covered.vars().wood_covered, true, 'the user covered the wood');
  covered.lab.worldsim.forceWeather(covered.saveId, '大雨');
  assert.equal(covered.vars().wood_wet, false, 'covered wood stays dry');
});

test('F3: supper at 19:00 eats a day of food; pine nuts add one; 阿砾 brings ten on his day', async () => {
  const { lab, saveId, vars, goTo, evs } = await worldLab({ id: 's_vars3', features: { director: false } });
  goTo('2026-10-20T19:30:00');
  assert.equal(vars().food, 4);
  assert.equal(evs('var_changed', e => e.payload.var === 'food').at(-1).payload.cause, '晚饭');
  lab.turns.act(saveId, { action: 'give', target: 'pine-nuts', args: { to: 'lan' } });
  assert.equal(vars().food, 5);
  goTo('2026-10-22T19:30:00'); goTo('2026-10-24T19:30:00'); goTo('2026-10-26T19:30:00'); goTo('2026-10-28T19:30:00');
  goTo('2026-10-30T17:00:00');
  assert.equal(vars().food, 0, 'never below zero');
  goTo('2026-10-30T18:30:00'); // day 11 = first day + 10
  assert.equal(vars().food, 10);
  assert.equal(vars().ali_eta_days, 20);
});

test('F3: five sunny mornings lift the snowline 1900 → 2200 and open the pass; she only knows what she looked at', async () => {
  let id = null;
  for (let i = 0; i < 2000 && !id; i++) { const c = []; morning(`s_sun${i}`, W, '2026-10-20', 6, c); if (c.slice(0, 5).every(k => k === '晴')) id = `s_sun${i}`; }
  assert.ok(id);
  const { lab, saveId, vars, goTo } = await worldLab({ id, features: { director: false } });
  const nowText = () => lab.context.build({ mode: 'memory', saveId, charId: 'lan', input: '雪线呢', inputSeq: lab.ledger.lastSeq(saveId) }).sections.find(s => s.name === 'now').text;
  goTo('2026-10-22T06:00:00'); goTo('2026-10-24T06:00:00'); goTo('2026-10-25T06:00:00');
  assert.equal(vars().snowline, 2200);
  assert.equal(vars().pass_open, true);
  assert.doesNotMatch(nowText(), /雪线/, 'she has not looked at the north slope');
  act(lab, saveId, 'walk_to', 'path');
  act(lab, saveId, 'look_at', 'path');
  assert.equal(vars().snowline_seen, 2200);
  assert.match(nowText(), /雪线在 2200 米，山口要 2200 米/);
});

test('F3: the new actions: allowed where they can be done, refused with a reason where not', async () => {
  const { lab, saveId, vars } = await worldLab({ id: 's_vars5', features: { director: false } });
  assert.equal(act(lab, saveId, 'gather_wood').reason, '得先走到南侧小路');
  act(lab, saveId, 'walk_to', 'path');
  assert.equal(act(lab, saveId, 'gather_wood').ok, true);
  assert.equal(vars().wood, 9);
  assert.equal(act(lab, saveId, 'forage').ok, true);
  assert.equal(act(lab, saveId, 'forage').reason, '今天已经找过了');
  assert.equal(act(lab, saveId, 'cover_wood', 'wood-crate-1').reason, '木箱不在这里');
  act(lab, saveId, 'walk_to', 'wood-crate-1');
  assert.equal(act(lab, saveId, 'cover_wood', 'wood-crate-1').ok, true);
  assert.equal(act(lab, saveId, 'cover_wood', 'wood-crate-1').reason, '柴已经盖好了');
  assert.equal(act(lab, saveId, 'secure_crate', 'wood-crate-1').ok, true);
  assert.ok(vars().crate_secure_until > lab.clock.now(saveId));
  act(lab, saveId, 'walk_to', 'tent-1');
  assert.equal(act(lab, saveId, 'fix_tent', 'cup').reason, '潮青陶杯不能这样用');
  assert.equal(act(lab, saveId, 'fix_tent', 'tent-1').ok, true);
});
