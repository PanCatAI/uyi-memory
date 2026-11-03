// 2.0 D8: the simulated user (mock) plays two days; the report has the metrics, and an old value that comes back in
// her lines after the user took it back is counted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLab } from '../lib/lab.mjs';
import { simulate, rng } from '../lib/simulate.mjs';

process.env.LAB_QUIET = '1';

test('爱改口 for two days with the mock: at least one change a day, no G failures, no recurrence, a full report', async () => {
  const lab = createLab();
  const r = await simulate(lab, { persona: '爱改口', days: 2, seed: 1 });
  assert.equal(r.days.length, 2);
  for (const d of r.days) assert.ok(d.turns >= 6 && d.turns <= 12);
  assert.ok(r.olds.length >= 2, 'one change per day');
  assert.equal(r.totals.g, 0);
  assert.equal(r.totals.recurrences, 0);
  assert.match(r.markdown, /## 第 1 天/);
  assert.match(r.markdown, /## 第 2 天/);
  assert.match(r.markdown, /\| 合计 \|/);
  assert.match(r.markdown, /## 旧值复现\n\n（无）/);
  // The user's model only gets what a player sees: no memory sections in its prompt.
  const prompts = lab.db.prepare("SELECT count(*) n FROM llm_calls WHERE purpose = 'sim_user'").get().n;
  assert.equal(prompts, r.totals.turns);
});

test('an old value in her line after the correction is a recurrence; her answer to the correction is not', async () => {
  const lab = createLab();
  // Seed 1: day 1 has 12 turns, the name 林舟 is told first and changed later that day.
  for (let i = 0; i < 12; i++) lab.llm.mock.enqueue('reply', { thought: '', mood: '平常', say: '好的，林舟。', action: null, used: [], self_claims: [] });
  const r = await simulate(lab, { persona: '爱改口', days: 1, seed: 1 });
  assert.equal(r.olds[0].value, '林舟');
  assert.ok(r.totals.recurrences >= 1);
  assert.ok(r.recurrences.every(x => x.value === '林舟' && x.field === '名字'));
  assert.match(r.markdown, /名字旧值「林舟」/);
});

test('the cost cap stops the run and says so', async () => {
  const lab = createLab();
  const r = await simulate(lab, { persona: '冷淡', days: 3, seed: 2, maxUsd: -1 });
  assert.equal(r.totals.turns, 0);
  assert.match(r.stopped, /上限/);
});

test('the seeded generator replays', () => {
  const a = rng(7), b = rng(7);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
});

test('3.0 E5: 好奇 for two days with all features and the judge: the fun table, the intent mix, a judge score', async () => {
  const lab = createLab();
  const { ALL_ON } = await import('../lib/features.mjs');
  const r = await simulate(lab, { persona: '好奇', days: 2, seed: 2, features: ALL_ON, judge: true });
  assert.match(r.markdown, /## 有没有意思（3\.0 E5）\n/);
  assert.match(r.markdown, /\| 天 \| 口头禅率 \| 反复问题 \| 复述开头 \| 打听 \| 给东西 \| 世界相关 \| 裁判 \|/);
  assert.match(r.markdown, /意图分布：分享 \d+/);
  assert.equal(r.totals.judgeAvg, 3);
  assert.equal(lab.features(r.saveId).voice, true);
  assert.equal(r.totals.fun.n, r.days.reduce((n, d) => n + d.said.length, 0));
});

test('3.0 E5: the S2 lines score 5/8 for catchphrases and the lexical rule finds no question asked 3 times', async () => {
  const { funMetrics } = await import('../lib/fun.mjs');
  const S2 = ['先说好，这杯子我不离手。火灭了，你拾柴还是我拾？', '周四……还有两天。先说好，守夜不是坐着聊天，得轮着看火。柴你拾还是我拾？', '坐就坐。先说好，柴的事你还没答我。', '长凳是新的吧，我坐了一天。阿砾下山去镇上，十天后才回。先说好，柴你到底拾不拾？', '在手里。说了不离手，就真没离。', '回来了。脚没起泡吧？今晚守夜，你答应的。', '行，不提了。火还旺着，今晚你先看着，我去看看雾散没散。', '守就守。先说好，雾这么大，守到半夜我换你。多远的路你今晚也别走。'];
  const m = funMetrics(S2.map(text => ({ text, user: '', intent: null })), [{ phrase: '先说好', every: 6 }, { phrase: '多远', every: 4 }]);
  assert.equal(m.tics['先说好'], 5);
  assert.equal(m.ticRate, 0.63);
  assert.equal(m.nagging.length, 0);
  assert.equal(m.intents['回应'], 8);
  assert.equal(m.giveRate, 0);
  assert.ok(m.worldRate >= 0.5, `${m.worldRate}`);
});
