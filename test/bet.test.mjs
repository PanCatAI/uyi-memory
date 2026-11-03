import { test } from 'node:test';
import assert from 'node:assert/strict';
import { worldLab } from './helpers/world.mjs';
import { dayOf, addDays } from '../lib/climate.mjs';
import { weatherPick } from '../lib/bets.mjs';

const reply = (say, bet = null) => ({ say, action: null, used: [], self_claims: [], bet });
const lastRejected = (lab, saveId) => JSON.parse(lab.db.prepare('SELECT rejected_json FROM turns WHERE save_id = ? AND committed = 1 ORDER BY rowid DESC LIMIT 1').get(saveId).rejected_json || '{}');
const kinds = ['晴', '阴', '起雾', '小雨', '大雨', '大风', '雪'];

test('G4: picks: 下雨 covers both rains; words that are no weather are not picks', () => {
  assert.deepEqual(weatherPick('下雨', kinds), ['小雨', '大雨']);
  assert.deepEqual(weatherPick('明天会下雨', kinds), ['小雨', '大雨']);
  assert.deepEqual(weatherPick('晴天', kinds), ['晴']);
  assert.deepEqual(weatherPick('大风', kinds), ['大风']);
  assert.equal(weatherPick('冰雹', kinds), null);
});

/** A bet on tomorrow made tonight; tomorrow's morning is set to `kind`; → the resolved event. */
async function betOn(kind, her = '下雨', user = '晴') {
  const w = await worldLab({ id: 's_bet1', features: { director: false } });
  const { lab, saveId, say, goTo, evs } = w;
  goTo('2026-10-20T20:00:00');
  const tomorrow = addDays(dayOf(lab.clock.now(saveId)), 1);
  lab.worldsim.setVar(saveId, 'weather_overrides', { [tomorrow]: kind }, '测试', lab.clock.now(saveId));
  lab.llm.mock.enqueue('reply', reply('赌就赌。', { about: '明天天气', her_pick: her, user_pick: user, stake: '输的人明天拾柴' }));
  await say('我赌明天晴');
  assert.equal(evs('bet').length, 1);
  assert.equal(evs('bet')[0].payload.phase, 'made');
  const ctx = lab.context.build({ mode: 'memory', saveId, charId: 'lan', input: '嗯', inputSeq: lab.ledger.lastSeq(saveId) });
  assert.match(ctx.sections.find(s => s.name === 'now').text, /你们打了个赌：明天天气，你押「下雨」/);
  goTo('2026-10-21T04:00:00');
  assert.equal(evs('bet').length, 1, 'not before 05:00');
  goTo('2026-10-21T06:00:00');
  assert.equal(lab.ledger.world(saveId).weather.am, kind);
  return { ...w, resolved: evs('bet').at(-1) };
}

test('G4: she bet on rain and it rained → she wins, no promise for her', async () => {
  const { lab, saveId, resolved } = await betOn('小雨');
  assert.equal(resolved.payload.phase, 'resolved');
  assert.equal(resolved.payload.winner, 'lan');
  assert.equal(lab.commitments.list(saveId, 'lan', 'open').filter(k => k.text.includes('拾柴')).length, 0);
  assert.equal(lab.bets.open(saveId), null);
});

test('G4: it was clear → he wins; the stake is her open promise for 18:00', async () => {
  const { lab, saveId, resolved } = await betOn('晴');
  assert.equal(resolved.payload.winner, 'user');
  const k = lab.commitments.list(saveId, 'lan', 'open').find(x => x.text === '输的人明天拾柴');
  assert.ok(k, 'her promise');
  assert.equal(new Date(k.due_at + 9 * 3_600_000).toISOString().slice(11, 16), '18:00');
});

test('G4: fog → nobody wins (draw)', async () => {
  const { resolved } = await betOn('起雾');
  assert.equal(resolved.payload.winner, 'draw');
});

test('G4: bad bets are dropped and noted: same pick, an unknown topic, a second one the same day', async () => {
  const { lab, saveId, say, goTo, evs } = await worldLab({ id: 's_bet2', features: { director: false } });
  goTo('2026-10-20T20:00:00');
  lab.llm.mock.enqueue('reply', reply('嗯。', { about: '明天天气', her_pick: '晴', user_pick: '晴天', stake: '拾柴' }));
  await say('都押晴');
  assert.match(lastRejected(lab, saveId).bet, /押的不对/);
  lab.llm.mock.enqueue('reply', reply('嗯。', { about: '谁先睡着', her_pick: '你', user_pick: '你', stake: '拾柴' }));
  await say('赌谁先睡');
  assert.match(lastRejected(lab, saveId).bet, /只能赌/);
  lab.llm.mock.enqueue('reply', reply('好。', { about: '雪线', her_pick: '往上', user_pick: '往下退', stake: '拾柴' }));
  await say('赌雪线');
  assert.equal(evs('bet').length, 1);
  lab.llm.mock.enqueue('reply', reply('再赌。', { about: '明天天气', her_pick: '下雨', user_pick: '晴', stake: '拾柴' }));
  await say('再赌一个');
  assert.match(lastRejected(lab, saveId).bet, /还没分输赢/);
  goTo('2026-10-21T06:00:00');
  assert.equal(evs('bet').at(-1).payload.phase, 'resolved');
  lab.llm.mock.enqueue('reply', reply('再赌。', { about: '明天天气', her_pick: '下雨', user_pick: '晴', stake: '拾柴' }));
  await say('早上好，再赌');
  assert.equal(evs('bet').at(-1).payload.phase, 'made', 'a new day, a new bet');
  lab.setFeatures(saveId, { practices: false });
  lab.llm.mock.enqueue('reply', reply('赌。', { about: '雪线', her_pick: '上', user_pick: '下', stake: '拾柴' }));
  await say('赌雪线');
  assert.equal(lastRejected(lab, saveId).bet, '打赌没开');
});
