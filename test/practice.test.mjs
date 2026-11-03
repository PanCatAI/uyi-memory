import { test } from 'node:test';
import assert from 'node:assert/strict';
import { worldLab } from './helpers/world.mjs';
import { dayOf, atTime } from '../lib/climate.mjs';

const reply = (say, practice = null) => ({ say, action: null, used: [], self_claims: [], practice });
const lastRejected = (lab, saveId) => JSON.parse(lab.db.prepare('SELECT rejected_json FROM turns WHERE save_id = ? AND committed = 1 ORDER BY rowid DESC LIMIT 1').get(saveId).rejected_json || '{}');
const phases = evs => evs('practice').map(e => `${e.payload.phase}${e.payload.step ?? ''}`);

test('G3: stars on a clear night: start → his 想 → two steps of hers → end, a memory, a step on the relationship', async () => {
  const { lab, saveId, say, goTo, evs } = await worldLab({ id: 's_prac1', features: { director: false } });
  lab.worldsim.forceWeather(saveId, '晴');
  goTo('2026-10-20T22:00:00');
  assert.deepEqual(lab.practice.startable(saveId, 'lan').map(p => p.id), ['stars']);
  const sec = () => lab.context.build({ mode: 'memory', saveId, charId: 'lan', input: '嗯', inputSeq: lab.ledger.lastSeq(saveId) }).sections.find(s => s.name === 'practice');
  assert.match(sec().text, /认星（id stars）/);
  lab.llm.mock.enqueue('reply', reply('想学认星吗？', { start: 'stars' }));
  await say('星星好多');
  assert.deepEqual(phases(evs), ['start0']);
  lab.llm.mock.enqueue('reply', reply('你抬头，自己找找看。')); // no step word: her step 1 is not done by this line
  await say('想！'); // his words finish step 0
  assert.deepEqual(phases(evs), ['start0', 'step1']);
  assert.match(sec().text, /第 2 步，共 3 步/);
  lab.llm.mock.enqueue('reply', reply('对，就是那颗。', { step_done: true }));
  await say('那个？');
  lab.llm.mock.enqueue('reply', reply('叫铜钩星，师父教的。', { step_done: true }));
  await say('它叫什么');
  assert.deepEqual(phases(evs), ['start0', 'step1', 'step2', 'end']);
  assert.equal(lab.ledger.world(saveId).practice, null);
  const mem = lab.db.prepare("SELECT text, priority FROM caches WHERE save_id = ? AND text LIKE '%一起做的%'").all(saveId);
  assert.equal(mem.length, 1);
  assert.match(mem[0].text, /铜钩星/);
  assert.equal(mem[0].priority, 1);
  const r = lab.relationship.compute(saveId, 'lan');
  assert.equal(r.together, 1);
  assert.equal(r.gifts_received, 1, 'counts like a gift');
});

test('G3: no start in the rain, nor of a practice that does not exist; a step_done with nothing going on is noted', async () => {
  const { lab, saveId, say, goTo, evs } = await worldLab({ id: 's_prac2', features: { director: false } });
  lab.worldsim.forceWeather(saveId, '小雨');
  goTo('2026-10-20T22:00:00');
  lab.llm.mock.enqueue('reply', reply('来认星吧。', { start: 'stars' }));
  await say('看星星吗');
  assert.equal(lastRejected(lab, saveId).practice, '现在不能认星');
  lab.llm.mock.enqueue('reply', reply('来。', { start: 'dance' }));
  await say('跳舞吗');
  assert.match(lastRejected(lab, saveId).practice, /没有这个活动/);
  lab.llm.mock.enqueue('reply', reply('好了。', { step_done: true }));
  await say('嗯');
  assert.equal(lastRejected(lab, saveId).practice, '没有在进行的活动');
  assert.deepEqual(evs('practice'), []);
});

test('G3: not finished within max_turns → abandoned, no memory; the session ending drops one too', async () => {
  const { lab, saveId, say, goTo, evs } = await worldLab({ id: 's_prac3', features: { director: false } });
  lab.worldsim.forceWeather(saveId, '晴');
  goTo('2026-10-20T22:00:00');
  lab.llm.mock.enqueue('reply', reply('想学认星吗？', { start: 'stars' }));
  await say('星星好多');
  for (let i = 0; i < 7; i++) { lab.llm.mock.enqueue('reply', reply('嗯。')); await say(`别的事${i}`); }
  assert.deepEqual(phases(evs), ['start0', 'abandon']);
  assert.match(evs('practice').at(-1).payload.outcome, /6 轮没做完/);
  assert.equal(lab.db.prepare("SELECT count(*) n FROM caches WHERE save_id = ? AND text LIKE '%一起做的%'").get(saveId).n, 0);
  assert.equal(lab.relationship.compute(saveId, 'lan').together, 0);

  lab.llm.mock.enqueue('reply', reply('再来一次？', { start: 'stars' }));
  await say('再试试');
  assert.equal(lab.ledger.world(saveId).practice.id, 'stars');
  lab.session.end(saveId);
  assert.equal(evs('practice').at(-1).payload.phase, 'abandon');
  assert.equal(evs('practice').at(-1).payload.outcome, '会话结束了');
});

test('G3: keeping watch makes a meteor three times as likely (director_log); the end marks the 守夜 promise done', async () => {
  const pOf = async watch => {
    const { lab, saveId, say, goTo } = await worldLab({ id: 's_prac4', features: { director: true } });
    lab.worldsim.forceWeather(saveId, '晴');
    goTo('2026-10-20T21:00:00');
    const t = lab.clock.now(saveId);
    lab.commitments.add(saveId, 'lan', { owner: 'character', text: '今晚守夜', dueAt: atTime(dayOf(t), '23:30'), sourceSeqs: [], at: t });
    if (watch) {
      lab.llm.mock.enqueue('reply', reply('我守前半夜。', { start: 'watch' }));
      await say('今晚一起守夜吧');
      assert.equal(lab.ledger.world(saveId).practice?.id, 'watch');
    }
    lab.director.check(saveId, lab.clock.now(saveId) + 3_600_000);
    const row = lab.director.recentLog(saveId).find(x => x.incident === 'meteor' && /[<≥] \d\.\d\d/.test(x.reason));
    assert.ok(row, 'the meteor was rolled for');
    return { p: Number(row.reason.match(/[<≥] (\d\.\d\d)/)[1]), lab, saveId, say };
  };
  const off = await pOf(false), on = await pOf(true);
  assert.equal(on.p, Math.min(1, Number((off.p * 3).toFixed(2))));
  for (let i = 0; i < 3; i++) { on.lab.llm.mock.enqueue('reply', reply('嗯。', { step_done: true })); await on.say(`守着${i}`); }
  assert.equal(on.lab.ledger.world(on.saveId).practice, null);
  assert.equal(on.lab.commitments.list(on.saveId, 'lan', 'open').filter(k => k.text.includes('守夜')).length, 0, 'the promise is kept');
  assert.equal(on.lab.ledger.world(on.saveId).vars.lan_tired >= 1, true);
});

test('G3: the model forgot the field: start_any in his words starts it, say_any in her line does a model step', async () => {
  const { lab, saveId, say, goTo, evs } = await worldLab({ id: 's_prac5', features: { director: false } });
  lab.worldsim.forceWeather(saveId, '晴');
  goTo('2026-10-20T22:00:00');
  lab.llm.mock.enqueue('reply', reply('认得几颗，想学吗？'));
  await say('天这么清，你认得星星吗？');
  assert.deepEqual(phases(evs), ['start0']);
  assert.equal(evs('practice')[0].payload.by, 'host');
  lab.llm.mock.enqueue('reply', reply('对，北边勺子形的那几颗。'));
  await say('好啊');
  assert.deepEqual(phases(evs), ['start0', 'step1', 'step2']);
  lab.llm.mock.enqueue('reply', reply('那叫铜钩星。'));
  await say('最亮那颗？');
  assert.deepEqual(phases(evs), ['start0', 'step1', 'step2', 'end']);
  lab.llm.mock.enqueue('reply', reply('认星好玩吧。'));
  await say('再认一颗星星');
  assert.equal(evs('practice').length, 5, 'starts again only when it can (still a clear night: yes)');
});
