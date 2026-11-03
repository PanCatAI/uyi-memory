// 2.0 D-gate (Jonathan, after the 5-day simulation): she said 「掀被子我可不动手」 one day and 「起不来我掀被子」 the
// next. A line whose self-claims say the opposite of an earlier one gets one retry with both sayings; still the
// opposite → delivered but flagged (G6) and not learned. An idle line that does it is not said at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshLab } from './helpers/lab.mjs';
import { realNow } from '../lib/clock.mjs';
import { pj } from '../lib/db.mjs';
import { turnProblems } from '../lib/scenarios.mjs';

const line = (say, claims) => ({ thought: '', mood: '平常', say, action: null, used: [], self_claims: claims });
const NO = '我不会掀你被子';
const YES = '我会掀你被子';
const status = (lab, saveId, charId, text) => lab.selfCanon.list(saveId, charId).find(r => r.text === text)?.status;
const rejected = (lab, id) => pj(lab.db.prepare('SELECT rejected_json FROM turns WHERE id = ?').get(id).rejected_json, {});

test('the opposite of an earlier stance, twice: delivered, flagged G6, stored as conflicts_self, the old one stays', async () => {
  const { lab, saveId, say } = await freshLab();
  lab.llm.mock.enqueue('reply', line('先说好，掀被子我可不动手。', [NO]));
  await say('明早你叫我');
  assert.equal(status(lab, saveId, 'rin', NO), 'active');
  for (let i = 0; i < 2; i++) lab.llm.mock.enqueue('reply', line('起不来我掀你被子。', [YES])); // the model insists
  const r = await say('起不来怎么办');
  const rj = rejected(lab, r.turnId);
  assert.equal(rj.self_retry.conflicts[0].text, NO);
  assert.equal(rj.self_conflict[0].text, NO);
  assert.equal(status(lab, saveId, 'rin', YES), 'conflicts_self');
  assert.equal(status(lab, saveId, 'rin', NO), 'active');
  assert.ok(turnProblems(lab, saveId, r.turnId).some(p => p.startsWith('G6')));
  // Only active claims reach the context: the contradicting one never does.
  const r2 = await say('那就这样');
  const self = pj(lab.db.prepare('SELECT sections_json FROM turns WHERE id = ?').get(r2.turnId).sections_json, []).find(s => s.name === 'self').text;
  assert.match(self, new RegExp(NO));
  assert.doesNotMatch(self, new RegExp(YES));
});

test('the retry fixes it: the consistent second line is delivered and learned, nothing flagged', async () => {
  const { lab, saveId, say } = await freshLab();
  lab.llm.mock.enqueue('reply', line('掀被子我可不动手。', [NO]));
  await say('明早你叫我');
  lab.llm.mock.enqueue('reply', line('起不来我掀你被子。', [YES]));
  lab.llm.mock.enqueue('reply', line('起不来我喊两声，被子我不掀。', ['我起不来时只喊两声']));
  const r = await say('起不来怎么办');
  assert.equal(r.reply.delivered, '起不来我喊两声，被子我不掀。');
  const rj = rejected(lab, r.turnId);
  assert.ok(rj.self_retry && !rj.self_conflict);
  assert.equal(status(lab, saveId, 'rin', '我起不来时只喊两声'), 'active');
  assert.equal(status(lab, saveId, 'rin', YES), undefined);
  assert.deepEqual(turnProblems(lab, saveId, r.turnId), []);
});

test('an explicit change of mind is not a contradiction: the old stance is superseded', async () => {
  const { lab, saveId, say } = await freshLab();
  lab.llm.mock.enqueue('reply', line('掀被子我可不动手。', [NO]));
  await say('明早你叫我');
  const old = lab.selfCanon.list(saveId, 'rin').find(x => x.text === NO);
  lab.llm.mock.enqueue('reply', line('算了，我改主意了，起不来我就掀。', ['我改主意了，起不来会掀你被子']));
  lab.llm.mock.enqueue('self_check', { conflicts: [], superseded: [`sc:${old.id}`] });
  await say('你确定？');
  assert.equal(status(lab, saveId, 'rin', NO), 'superseded');
  assert.equal(status(lab, saveId, 'rin', '我改主意了，起不来会掀你被子'), 'active');
});

test('no claims or nothing earlier → no check call; a self_check answer citing an unknown ref is retried', async () => {
  const { lab, saveId, say } = await freshLab();
  await say('你好');
  lab.llm.mock.enqueue('reply', line('我会掀被子。', [YES]));
  await say('明早');
  assert.equal(lab.db.prepare("SELECT count(*) n FROM llm_calls WHERE purpose = 'self_check'").get().n, 0);
  lab.llm.mock.enqueue('self_check', { conflicts: [{ ref: 'sc:nope', why: 'x' }], superseded: [] });
  const out = await lab.selfCanon.check(saveId, 'rin', { line: '我不会掀被子', claims: [NO] });
  assert.equal(lab.db.prepare("SELECT count(*) n FROM llm_calls WHERE purpose = 'self_check'").get().n, 2);
  assert.equal(out.conflicts[0].text, YES); // the retry (mock rule) finds the real one
});

test('an idle line that contradicts her is not said; the prompt shows what she said about herself', async () => {
  const { lab, saveId, say } = await freshLab({ sceneId: 'camp' });
  lab.llm.mock.enqueue('reply', line('先说好，掀被子我可不动手。', [NO]));
  await say('明早你叫我');
  lab.llm.mock.enqueue('idle', { thought: '明早得叫他', urge: 0.9, say: '起不来我掀你被子。', ref: null, action: null, self_claims: [YES] });
  const r = await lab.idle.run(saveId, 'lan', { now: realNow() + 61_000 });
  assert.equal(r.spoke, false);
  assert.match(r.why, /说反了/);
  assert.equal(lab.ledger.list(saveId, { types: ['char_said'], all: true }).filter(e => e.payload.idle).length, 0);
  // The idle prompt carries her own sayings, so she can keep to them in the first place.
  const { template } = await import('../lib/prompts.mjs');
  assert.match(template('idle'), /\{\{self\}\}/);
  assert.match(lab.context.section('self', { saveId, charId: 'lan', inputSeq: lab.ledger.lastSeq(saveId) }).text, new RegExp(NO));
});
