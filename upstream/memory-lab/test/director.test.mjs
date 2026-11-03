import { test } from 'node:test';
import assert from 'node:assert/strict';
import { worldLab } from './helpers/world.mjs';
import { HOUR, DAY } from '../lib/clock.mjs';
import { PACE } from '../lib/director.mjs';

const incidents = lab => lab.ledger.list(lab.__save, { types: ['incident'], all: true });
/** n world days, a session open all along, an hour at a time (like ticks, without the routine). */
async function run(id, days, features = {}) {
  const w = await worldLab({ id, features });
  w.lab.__save = w.saveId;
  w.hours(days * 24);
  return w;
}

test('F4: same save, seven days, twice → the same incidents at the same times', async () => {
  const a = await run('s_dir1', 7), b = await run('s_dir1', 7);
  const key = w => incidents(w.lab).map(e => `${e.t}|${e.payload.incident}|${e.payload.phase}`);
  assert.ok(key(a).length > 0);
  assert.deepEqual(key(a), key(b));
});

test('F4: pace 起伏 — at most 4 random severity points a day, rest after a big one, cooldowns hold', async () => {
  for (const id of ['s_dir2', 's_dir3', 's_dir4']) {
    const w = await run(id, 10);
    const inc = w.lab.scene(w.saveId).incidents;
    const starts = incidents(w.lab).filter(e => e.payload.phase === 'start').map(e => ({ ...e, def: inc.find(i => i.id === e.payload.incident) }));
    const random = starts.filter(e => e.def.check !== 'on_weather');
    const byDay = {};
    for (const e of random) { const d = new Date(e.t + 9 * HOUR - 5 * HOUR).toISOString().slice(0, 10); byDay[d] = (byDay[d] || 0) + e.payload.sev; }
    for (const [d, n] of Object.entries(byDay)) assert.ok(n <= PACE.起伏.budget, `${id} ${d}: ${n}`);
    for (const big of random.filter(e => e.payload.sev >= 3)) {
      assert.ok(!random.some(e => e.t > big.t && e.t - big.t < 24 * HOUR && e.payload.sev >= 2), `${id}: rest after ${big.payload.incident}`);
    }
    for (const def of inc.filter(i => i.cooldown_days)) {
      const ts = starts.filter(e => e.def.id === def.id).map(e => e.t);
      for (let i = 1; i < ts.length; i++) assert.ok(ts[i] - ts[i - 1] >= def.cooldown_days * DAY, `${id}: ${def.id} cooled down`);
    }
    for (let i = 1; i < random.length; i++) assert.ok(random[i].t - random[i - 1].t >= 3 * HOUR, `${id}: gap`);
  }
});

test('F4: weather incidents do not use the budget', async () => {
  const { lab, saveId } = await worldLab({ id: 's_dir5' });
  lab.director.force(saveId, 'tent_rope');
  lab.director.force(saveId, 'fox_food');
  lab.worldsim.forceWeather(saveId, '小雨');
  const wet = lab.ledger.list(saveId, { types: ['incident'], all: true }).find(e => e.payload.incident === 'wet_wood');
  assert.equal(wet?.payload.phase, 'start');
  assert.ok(lab.director.recentLog(saveId).some(r => r.incident === 'tent_rope' && r.decision === 'debug'));
});

test('F4: 帐篷绳松了 → she fixes it (char); with the user\'s 搭把手 it is solved together; left alone it expires and the tent comes down', async () => {
  let w = await worldLab({ id: 's_dir6' });
  w.lab.director.force(w.saveId, 'tent_rope');
  assert.equal(w.vars().tent_secure, false);
  w.hours(1);
  const fixed = w.evs('incident', e => e.payload.phase === 'resolved')[0];
  assert.equal(fixed.payload.by, 'char');
  assert.equal(w.vars().tent_secure, true);
  assert.ok(w.evs('char_action', e => e.action === 'fix_tent' && e.payload.incident === 'tent_rope').length === 1);

  w = await worldLab({ id: 's_dir7' });
  w.lab.director.force(w.saveId, 'tent_rope');
  w.lab.clock.advance(w.saveId, 10 * 60_000);
  w.lab.turns.act(w.saveId, { action: 'help', args: { incident: 'tent_rope' } });
  assert.equal(w.evs('incident', e => e.payload.phase === 'resolved')[0]?.payload.by, 'together');

  w = await worldLab({ id: 's_dir8' });
  const sc = w.lab.scene(w.saveId);
  sc.incidents = sc.incidents.map(i => (i.id === 'tent_rope' ? { ...i, auto_fix: null } : i)); // she never gets to it
  w.lab.director.force(w.saveId, 'tent_rope');
  w.hours(2);
  assert.equal(w.vars().tent_down, false);
  w.hours(1);
  assert.equal(w.evs('incident', e => e.payload.phase === 'expired')[0]?.payload.incident, 'tent_rope');
  assert.equal(w.vars().tent_down, true);
  assert.match(w.lab.context.build({ mode: 'memory', saveId: w.saveId, charId: 'lan', input: '嗯', inputSeq: w.lab.ledger.lastSeq(w.saveId) }).sections.find(s => s.name === 'now').text, /帐篷塌了/);
});

test('F4: with the director off nothing happens; with the world off neither does the director', async () => {
  const a = await run('s_dir9', 4, { director: false });
  assert.equal(incidents(a.lab).length, 0);
  const b = await run('s_dir9', 4, { world: false });
  assert.equal(incidents(b.lab).length, 0);
  assert.equal(b.lab.db.prepare('SELECT COUNT(*) n FROM director_log').get().n, 0);
});

test('F5: away overnight — 03:00 the wind loosens the tent, she gets up and fixes it, and tells you in the first turns back', async () => {
  const { lab, saveId, goTo, vars, evs, say } = await worldLab({ id: 's_away1' });
  goTo('2026-10-20T21:00:00');
  lab.session.end(saveId);
  goTo('2026-10-21T03:00:00');
  lab.worldsim.forceWeather(saveId, '大风');
  lab.director.force(saveId, 'tent_rope');
  lab.clock.set(saveId, Date.parse('2026-10-21T18:00:00+09:00'));
  await lab.session.start(saveId);
  const fix = evs('char_action', e => e.action === 'fix_tent')[0];
  assert.ok(fix?.offscreen, 'fixed while you were away');
  assert.equal(evs('incident', e => e.payload.phase === 'resolved')[0].payload.by, 'char');
  assert.ok(evs('var_changed', e => e.payload.var === 'lan_tired' && /半夜/.test(e.payload.cause)).length === 1);
  assert.ok(vars().lan_tired >= 0);
  const ts = lab.ledger.list(saveId, { all: true }).map(e => e.t);
  assert.deepEqual(ts, [...ts].sort((x, y) => x - y), 'the ledger stays in time order');
  const away = () => lab.context.build({ mode: 'memory', saveId, charId: 'lan', input: '嗯', inputSeq: lab.ledger.lastSeq(saveId) }).sections.find(s => s.name === 'while_away');
  for (let i = 0; i < 3; i++) {
    lab.llm.mock.enqueue('reply', { say: '回来了。', action: null, used: [], self_claims: [] });
    if (i < 2) await say(`第${i}句`);
  }
  // turns 1–3 of the session see it (the input counts), turn 4 does not
  lab.ledger.append(saveId, { type: 'user_said', actor: 'user', payload: { text: '第三句', to: 'lan' } });
  assert.match(away()?.text || '', /帐篷/);
  assert.match(away().text, /爬起来重新打了桩（有点没睡好）/);
  lab.ledger.append(saveId, { type: 'user_said', actor: 'user', payload: { text: '第四句', to: 'lan' } });
  assert.ok(!away(), 'gone after three turns');
});

test('F5: five days away — incidents only in the last 72 hours, the daily 量 every day', async () => {
  const { lab, saveId, evs } = await worldLab({ id: 's_away2' });
  lab.session.end(saveId);
  const left = lab.clock.now(saveId);
  lab.clock.set(saveId, left + 5 * DAY);
  await lab.session.start(saveId);
  const back = lab.clock.now(saveId);
  const inc = evs('incident', e => e.payload.phase === 'start' && !lab.scene(saveId).incidents.find(i => i.id === e.payload.incident).check.startsWith('on_'));
  assert.ok(inc.every(e => e.t >= back - 72 * HOUR), inc.map(e => e.payload.incident).join(','));
  assert.equal(evs('var_changed', e => e.payload.var === 'snowline').length, 5, 'every morning, the old days too');
  assert.ok(evs('var_changed', e => e.payload.var === 'food' && e.payload.cause === '晚饭' && e.t < back - 72 * HOUR).length >= 1, 'supper on the old days too');
  assert.equal(evs('weather').length, 6);
});
