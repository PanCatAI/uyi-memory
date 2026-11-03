import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { morning, afternoon, stationary, signFor, temps, addDays } from '../lib/climate.mjs';
import { worldLab } from './helpers/world.mjs';

const W = JSON.parse(readFileSync(new URL('../scenes/camp.rules.json', import.meta.url), 'utf8')).weather;
const FIRST = '2026-10-20';

test('F2: same save, same day → same weather; day 1 is 晴; no snow before day 8', () => {
  const a = [], b = [];
  assert.equal(morning('s_x', W, FIRST, 1, a), '晴');
  assert.equal(morning('s_x', W, FIRST, 40, a), morning('s_x', W, FIRST, 40, b));
  assert.deepEqual(a, b);
  for (let s = 0; s < 200; s++) {
    const c = [];
    morning(`s_${s}`, W, FIRST, 7, c);
    assert.ok(!c.includes('雪'), `save ${s}: ${c.join(',')}`);
  }
  let snow = 0;
  for (let s = 0; s < 50; s++) { const c = []; morning(`s_${s}`, W, FIRST, 60, c); snow += c.filter(k => k === '雪').length; }
  assert.ok(snow > 0, 'snow happens later in autumn');
});

test('F2: over 1000 days each weather is within 3 points of the table\'s stationary share', () => {
  const noSnow = { ...W, snow_from_day: Infinity };
  const seq = [];
  morning('s_long', noSnow, FIRST, 1000, seq);
  const want = stationary(noSnow);
  for (const [k, p] of Object.entries(want)) {
    const got = seq.filter(x => x === k).length / seq.length;
    assert.ok(Math.abs(got - p) <= 0.03, `${k}: ${got.toFixed(3)} vs ${p.toFixed(3)}`);
  }
});

test('F2: the afternoon turn, temperatures cooling by day, and signs right 70–85% of the time', () => {
  assert.ok(['晴', '阴'].includes(afternoon('s_x', W, FIRST, '起雾')));
  assert.equal(afternoon('s_x', W, FIRST, '大雨'), '大雨', 'no turn listed: stays');
  assert.deepEqual(temps(W, '晴', 1), { hi: 12, lo: 0, wind: '1–2 级' });
  assert.deepEqual(temps(W, '晴', 11), { hi: 9, lo: -3, wind: '1–2 级' });
  const right = { 晚霞: ['晴'], 山顶戴帽: ['小雨', '大雨'], 云跑得快: ['大风'], '傍晚没风、地上返潮': ['起雾'], 天边发灰: ['阴'], 冷得发干: ['雪'] };
  const seq = [];
  morning('s_signs', W, FIRST, 1001, seq);
  let ok = 0;
  for (let i = 0; i < 1000; i++) ok += right[signFor('s_signs', W, addDays(FIRST, i), seq[i + 1])].includes(seq[i + 1]) ? 1 : 0;
  assert.ok(ok >= 700 && ok <= 850, `${ok} / 1000`);
});

test('F2: the world writes the morning weather with temperatures, the 14:00 turn and the 17:00 sign; now shows four lines', async () => {
  const { lab, saveId, goTo, evs } = await worldLab({ id: 's_clim1' });
  goTo('2026-10-22T18:00:00'); // 57 hours: all of it simulated hour by hour
  const days = evs('weather').map(e => e.payload);
  assert.deepEqual(days.map(d => d.day), ['2026-10-20', '2026-10-21', '2026-10-22']);
  assert.ok(days.every(d => typeof d.temp_hi === 'number' && typeof d.temp_lo === 'number' && d.wind));
  assert.equal(evs('sky_sign').length, 3);
  for (const d of days) {
    const p = lab.environment.planned(saveId, d.day);
    assert.equal(d.kind, p.am);
    const turned = evs('weather_change').find(e => new Date(e.t + 9 * 3600e3).toISOString().startsWith(d.day));
    assert.equal(Boolean(turned), p.pm !== p.am, d.day);
  }
  const now = lab.context.build({ mode: 'memory', saveId, charId: 'lan', input: '冷吗', inputSeq: lab.ledger.lastSeq(saveId) }).sections.find(s => s.name === 'now').text;
  for (const re of [/天气：/, /气温：大约 -?\d+℃，夜里会到 -?\d+℃/, /风：/, /天象：.*（你知道这多半说明明天/]) assert.match(now, re);
});

test('F2: a forced weather turns now and stays until the next morning', async () => {
  const { lab, saveId, goTo } = await worldLab({ id: 's_clim2' });
  lab.worldsim.forceWeather(saveId, '大风');
  assert.equal(lab.environment.now(saveId).weather, '大风');
  goTo('2026-10-20T16:00:00');
  assert.equal(lab.environment.now(saveId).weather, '大风', 'the 14:00 turn does not undo it');
  goTo('2026-10-21T06:00:00');
  assert.equal(lab.environment.now(saveId).weather, lab.environment.planned(saveId, '2026-10-21').am);
  assert.throws(() => lab.worldsim.forceWeather(saveId, '冰雹'), /没有这种天气/);
});
