// 2.0 D3: a diary per world day after 23:00, tomorrow's intention from it, and forgetting rewrites it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshLab } from './helpers/lab.mjs';

const diaries = (lab, saveId) => lab.diary.live(saveId, 'lan');
const nowText = (lab, saveId) => lab.context.build({ mode: 'memory', saveId, charId: 'lan', input: '早', inputSeq: lab.ledger.lastSeq(saveId) }).sections.find(s => s.name === 'now').text;
const textAbsent = (lab, saveId, text) => [['events', 'payload_json'], ['caches', "text || ' ' || coalesce(intention, '')"], ['turns', "sections_json || prompt_json || coalesce(output_json, '')"]]
  .filter(([t, col]) => lab.db.prepare(`SELECT count(*) n FROM ${t} WHERE save_id = ? AND instr(${col}, ?) > 0`).get(saveId, text).n).map(([t]) => t);

async function dayOne() {
  const t = await freshLab({ sceneId: 'camp' });
  const a = await t.say('前面有条小溪，水很清。');
  const b = await t.say('今天风真大');
  t.lab.session.advance(t.saveId, '23:30');
  await t.lab.session.start(t.saveId);
  await t.lab.jobs.idle(t.saveId);
  return { ...t, a, b };
}

test('past 23:00: one diary for the day, refs only from that day, no thoughts; the next day has 今天想', async () => {
  const { lab, saveId } = await dayOne();
  const list = diaries(lab, saveId);
  assert.equal(list.length, 1);
  assert.equal(list[0].day, '2026-10-20');
  const day = new Set(lab.diary.inputFor(saveId, 'lan', '2026-10-20').events.map(e => e.seq));
  assert.ok(list[0].derived_from.length && list[0].derived_from.every(s => day.has(s)), JSON.stringify(list[0].derived_from));
  for (const r of lab.db.prepare("SELECT thought FROM turns WHERE save_id = ? AND thought IS NOT NULL").all(saveId)) assert.ok(!list[0].text.includes(r.thought), 'no thought in the diary');
  assert.equal(list[0].intention, '把你说的那条溪画上');
  // Still the same night: no intention yet. The next morning: there it is.
  assert.doesNotMatch(nowText(lab, saveId), /今天想/);
  lab.session.advance(saveId, '09:00');
  await lab.session.start(saveId);
  await lab.jobs.idle(saveId);
  assert.match(nowText(lab, saveId), /今天想：把你说的那条溪画上/);
  assert.equal(diaries(lab, saveId).length, 1, 'no second diary for the same day');
});

test('a diary whose ref is refused is retried once with the errors, then dropped and recorded', async () => {
  const t = await freshLab({ sceneId: 'camp' });
  await t.say('你好');
  t.lab.llm.mock.enqueue('diary', { text: '今天很平常。', refs: ['ev:999'], intention: '' });
  t.lab.llm.mock.enqueue('diary', { text: '今天很平常。', refs: ['ev:998'], intention: '' });
  t.lab.session.advance(t.saveId, '23:30');
  await t.lab.session.start(t.saveId);
  await t.lab.jobs.idle(t.saveId);
  assert.equal(diaries(t.lab, t.saveId).length, 0);
  const run = t.lab.jobs.runs(t.saveId).find(r => r.kind === 'diary');
  assert.equal(run?.status, 'failed');
  assert.equal(run.from_seq, 20261020);
  await t.lab.jobs.retry(t.saveId, { id: run.id });
  assert.equal(diaries(t.lab, t.saveId).length, 1, 'retry writes it with the mock default');
});

test('deleting an event the diary cites rewrites the diary and the text is gone from the database', async () => {
  const { lab, saveId, a } = await dayOne();
  const said = lab.ledger.list(saveId, { types: ['user_said'], all: true }).find(e => e.payload.text.includes('小溪'));
  assert.ok(diaries(lab, saveId)[0].derived_from.includes(said.seq));
  const reply = lab.ledger.list(saveId, { types: ['char_said'], all: true }).find(e => e.payload.text.includes('小溪'));
  const job = await lab.forget.propose(saveId, 'lan', { verb: 'delete', refs: [`ev:${said.seq}`, ...(reply ? [`ev:${reply.seq}`] : [])] });
  await lab.forget.confirm(job.id);
  await lab.jobs.idle(saveId);
  const list = diaries(lab, saveId);
  assert.equal(list.length, 1, 'rewritten, not removed: the day still had other things');
  assert.ok(!list[0].derived_from.includes(said.seq));
  assert.deepEqual(textAbsent(lab, saveId, '小溪'), []);
  assert.ok(a.turnId);
});

// 2.0 D4: weekly digests over the diaries, tiered recall, and the event → diary → week cascade.
async function eightDays() {
  const t = await freshLab({ sceneId: 'camp' });
  await t.say('前面有条小溪，水很清。');
  for (let d = 0; d < 8; d++) {
    t.lab.session.advance(t.saveId, '1d');
    await t.lab.session.start(t.saveId);
    await t.say(d === 2 ? '我奶奶以前也画地图' : `第${d + 2}天，风不大`);
  }
  await t.lab.jobs.idle(t.saveId);
  return t;
}

test('8 days: one weekly digest from that week\'s diaries; recall picks it by keyword and drills down', async () => {
  const { lab, saveId } = await eightDays();
  const weeks = lab.diary.liveWeeks(saveId, 'lan');
  assert.equal(weeks.length, 1);
  assert.equal(weeks[0].day, '2026-10-25');
  const diaryIds = new Set(lab.diary.weekDiaries(saveId, 'lan', '2026-10-25').map(d => `cache:${d.id}`));
  assert.ok(weeks[0].refs.length && weeks[0].refs.every(r => diaryIds.has(r)));
  assert.ok([...weeks[0].text].length <= 300);
  const mem = text => lab.context.build({ mode: 'memory', saveId, charId: 'lan', input: text, inputSeq: lab.ledger.lastSeq(saveId) }).sections.find(s => s.name === 'memories');
  const hit = mem('你还记得那条小溪吗');
  assert.equal(hit.refs[0], `cache:${weeks[0].id}`);
  assert.match(hit.why, /周小结/);
  assert.ok(hit.refs.slice(1, 4).some(r => diaryIds.has(r)), 'drills into that week\'s diaries');
  assert.ok(hit.tokens <= 1200 + 50);
  // No digest yet (day one): the 1.0 way.
  const one = await dayOne();
  const plain = one.lab.context.build({ mode: 'memory', saveId: one.saveId, charId: 'lan', input: '那条小溪', inputSeq: one.lab.ledger.lastSeq(one.saveId) }).sections.find(s => s.name === 'memories');
  assert.doesNotMatch(plain?.why || '', /周小结/);
});

test('deleting an event at the bottom of the chain rebuilds diary and digest; the text is gone', async () => {
  const { lab, saveId } = await eightDays();
  const said = lab.ledger.list(saveId, { types: ['user_said'], all: true }).find(e => e.payload.text.includes('小溪'));
  const reply = lab.ledger.list(saveId, { types: ['char_said'], all: true }).find(e => e.payload.text.includes('小溪'));
  const before = lab.diary.liveWeeks(saveId, 'lan')[0];
  assert.ok(before.derived_from.includes(said.seq));
  const job = await lab.forget.propose(saveId, 'lan', { verb: 'delete', refs: [`ev:${said.seq}`, `ev:${reply.seq}`] });
  await lab.forget.confirm(job.id);
  await lab.jobs.idle(saveId);
  const after = lab.diary.liveWeeks(saveId, 'lan');
  assert.equal(after.length, 1, 'rebuilt');
  assert.notEqual(after[0].id, before.id);
  assert.ok(!after[0].derived_from.includes(said.seq));
  assert.deepEqual(textAbsent(lab, saveId, '小溪'), []);
});
