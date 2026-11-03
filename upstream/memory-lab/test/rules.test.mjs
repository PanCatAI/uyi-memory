import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rand01 } from '../lib/rand.mjs';
import { match, specificity, KEYS, compare } from '../lib/rules.mjs';
import { createLab } from '../lib/lab.mjs';
import { ALL_ON } from '../lib/features.mjs';
import { foldWorld } from '../lib/world.mjs';
import { loadScene } from '../lib/scene.mjs';
process.env.LAB_QUIET = '1';

const at = s => Date.parse(`${s}+09:00`);
const base = {
  t: at('2026-10-21T22:30:00'), day: 2, weather: '大风', yesterday: ['晴', '晴'], sky: '夜里', temp: 1,
  vars: { food: 2, wood_covered: false, snowline_seen: 2210, pass_height: 2200, crate_secure_until: null },
  objects: { cup: { holder: null, state: {} }, 'campfire-1': { state: { lit: true } } },
  stage: '熟悉', userPresent: true, charOutdoors: true, active: { tent_rope: {} }, starts: { wolf_howl: at('2026-10-21T22:00:00') },
  untold: ['hunter_news'], custom: { snow_up: true }, sign: '晚霞', practice: null, dueToday: ['今晚守夜'], scoutedToday: true, betResolvedToday: false
};

test('F1: every key has a case that holds and one that does not', () => {
  const cases = {
    weather_in: [['大风'], ['晴']], sky_in: [['夜里'], ['白天']], hour_between: [['21:00', '05:00'], ['08:00', '12:00']],
    day_gte: [2, 3], temp_lte: [2, 0], temp_gte: [0, 5], var: [{ food: { lte: 2 }, wood_covered: false }, { food: { gte: 3 } }],
    object: [{ cup: { holder: null }, 'campfire-1': { lit: true } }, { 'campfire-1': { lit: false } }], stage_gte: ['熟悉', '亲近'],
    user_present: [true, false], char_outdoors: [true, false], incident_active: ['tent_rope', 'fox_food'],
    incident_not_active: ['fox_food', 'tent_rope'], incident_recent_h: [{ id: 'wolf_howl', h: 1 }, { id: 'meteor', h: 1 }],
    has_untold: ['hunter_news', 'meteor'], sign_today: [['晚霞'], ['山顶戴帽']], practice_active: [null, 'watch'],
    commitment_due_today: ['守夜', '烤松子'], user_scouted_today: [true, false], bet_resolved_today: [false, true],
    yesterday_weather_in: [['晴'], ['大雨']], var_future: ['snowline_seen', 'crate_secure_until'], not: [{ weather_in: ['晴'] }, { weather_in: ['大风'] }], custom: ['snow_up', 'map_clue']
  };
  assert.deepEqual(Object.keys(cases).sort(), [...KEYS].sort(), 'a case for every key');
  for (const [k, [yes, no]] of Object.entries(cases)) {
    // var_future compares the var with t: a time far ahead is in the future.
    const ctx = k === 'var_future' ? { ...base, vars: { ...base.vars, snowline_seen: base.t + 1000 } } : base;
    assert.equal(match({ [k]: yes }, ctx), true, `${k} holds`);
    assert.equal(match({ [k]: no }, ctx), false, `${k} does not hold`);
  }
  assert.equal(match({ no_such_key: 1 }, base), false, 'an unknown key never passes');
});

test('F1: hour_between crosses midnight; specificity counts keys; $var and $now compare against values', () => {
  for (const [h, ok] of [['21:00', true], ['23:59', true], ['00:30', true], ['04:59', true], ['05:00', false], ['12:00', false]]) {
    assert.equal(match({ hour_between: ['21:00', '05:00'] }, { ...base, t: at(`2026-10-22T${h}:00`) }), ok, h);
  }
  assert.equal(specificity({ weather_in: ['大风'], var: { a: 1, b: 2 } }), 2);
  assert.equal(specificity({}), 0);
  assert.equal(compare(2210, { gte: '$pass_height' }, base), true);
  assert.equal(compare(2100, { gte: '$pass_height' }, base), false);
  assert.equal(compare(base.t - 1, { lt: '$now' }, base), true);
  assert.equal(compare(undefined, false, base), true, 'a missing flag is false');
});

test('F1: rand01 is fixed by its keys and spreads evenly', () => {
  assert.equal(rand01('s_a', 'weather', '2026-10-21'), rand01('s_a', 'weather', '2026-10-21'));
  assert.notEqual(rand01('s_a', 'weather', '2026-10-21'), rand01('s_b', 'weather', '2026-10-21'));
  const bins = Array(10).fill(0);
  for (let i = 0; i < 10_000; i++) bins[Math.floor(rand01('s_x', 'k', i) * 10)]++;
  for (const n of bins) assert.ok(n >= 900 && n <= 1100, `bin ${n}`);
});

test('F1: vars start from the rules, var_changed folds into them; scenes without rules have none', () => {
  const lab = createLab();
  const saveId = lab.saves.createSave({ sceneId: 'camp', id: 's_rules1' }).id;
  assert.deepEqual(lab.ledger.world(saveId).vars, {}, 'features off: the camp is 2.0');
  lab.setFeatures(saveId, ALL_ON);
  assert.equal(lab.ledger.world(saveId).vars.wood, 6);
  lab.ledger.append(saveId, { type: 'var_changed', actor: 'host', payload: { var: 'wood', from: 6, to: 4, cause: '测试' } });
  assert.equal(lab.ledger.world(saveId).vars.wood, 4);
  assert.deepEqual(foldWorld(loadScene('island'), []).vars, {});
  assert.ok(lab.scene(saveId).actions.gather_wood && !loadScene('camp').actions.gather_wood, 'rule actions only with the feature');
});
