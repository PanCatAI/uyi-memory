import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshLab } from './helpers/lab.mjs';
import { detect } from '../lib/memory/forget.mjs';
import { catchupCount } from '../lib/memory/catchup.mjs';
import { DAY } from '../lib/clock.mjs';

test('fact rules: each rejection reason', async () => {
  const { lab, saveId, say } = await freshLab();
  await say('我叫美林');
  await lab.jobs.idle(saveId);
  const userEv = lab.ledger.list(saveId, { types: ['user_said'], all: true })[0];
  const charEv = lab.ledger.list(saveId, { types: ['char_said'], all: true })[0];
  const f = (ev, cand) => lab.facts.accept(saveId, 'rin', ev, { confidence: 0.9, corrects: null, valid_for: null, ...cand }).reason;
  assert.equal(f(charEv, { predicate: 'name', object: 'x', evidence: '收到' }), 'source_not_user');
  assert.equal(f(userEv, { predicate: 'zodiac', object: 'x', evidence: '我叫' }), 'bad_predicate');
  assert.equal(f(userEv, { predicate: 'likes', object: '猫', evidence: '我喜欢猫' }), 'no_evidence');
  assert.equal(f(userEv, { predicate: 'likes', object: '美林', evidence: '美林', confidence: 0.3 }), 'low_confidence');
  assert.equal(f(userEv, { predicate: 'name', object: '美林', evidence: '我叫美林' }), 'duplicate');
  await say('以后别再提美林了');
  assert.equal(f(userEv, { predicate: 'call_me', object: '美林', evidence: '美林' }), 'suppressed');
  assert.equal(lab.db.prepare('SELECT count(*) n FROM rejected_facts').get().n, 6);
});

test('single-valued replacement bumps generation and logs memory_op; state expires', async () => {
  const { lab, saveId, say } = await freshLab();
  await say('我叫美林');
  await lab.jobs.idle(saveId);
  const gen = lab.saves.getSave(saveId).generation;
  await say('说错了，是美玲不是美林');
  await lab.jobs.idle(saveId);
  assert.deepEqual(lab.facts.all(saveId, 'rin').map(f => [f.object, f.status]), [['美玲', 'active'], ['美林', 'superseded']]);
  assert.equal(lab.saves.getSave(saveId).generation, gen + 1);
  assert.equal(lab.ledger.list(saveId, { types: ['memory_op'], all: true })[0].payload.op, 'correct');
  lab.llm.mock.enqueue('facts', { facts: [{ predicate: 'state', object: '感冒了', evidence: '我感冒了', confidence: 0.9, corrects: null, valid_for: null }], commitments: [] });
  await say('我感冒了');
  await lab.jobs.idle(saveId);
  lab.session.advance(saveId, '2d');
  lab.facts.expire(saveId);
  assert.equal(lab.facts.all(saveId, 'rin').find(f => f.object === '感冒了').status, 'expired');
});

test('commitments get a due date and close via done_commitments', async () => {
  const { lab, saveId, say } = await freshLab();
  await say('那你明天陪我去看灯塔');
  await lab.jobs.idle(saveId);
  const [k] = lab.commitments.list(saveId, 'rin', 'open');
  assert.ok(k.due_at > lab.clock.now(saveId));
  lab.llm.mock.enqueue('reply', { say: '走吧', action: null, used: [], self_claims: [], done_commitments: [`commit:${k.id}`] });
  await say('今天去吧');
  assert.equal(lab.commitments.list(saveId, 'rin')[0].status, 'done');
  assert.equal(lab.relationship.compute(saveId, 'rin').promises_kept, 1);
});

test('observe: 8 events trigger; qiao never sees what the user told rin', async () => {
  const { lab, saveId, say } = await freshLab();
  lab.turns.act(saveId, { action: 'move_character', target: 'qiao', args: { room: 'cabin' } });
  for (let i = 0; i < 4; i++) await say(`秘密${i}号`);
  await lab.jobs.idle(saveId);
  const rin = lab.observe.live(saveId, 'rin', 'observation');
  assert.ok(rin.length >= 4);
  await lab.observe.run(saveId, 'qiao', { force: true });
  const qiao = lab.observe.live(saveId, 'qiao', 'observation').map(c => c.text).join('\n');
  assert.doesNotMatch(qiao, /秘密/);
});

test('catchup: none under 2 hours, ≤3 offscreen and monotonic after 2 days', async () => {
  assert.equal(catchupCount(2 * DAY), 3);
  const { lab, saveId, say } = await freshLab();
  await say('你好');
  lab.session.advance(saveId, '1h');
  assert.equal((await lab.session.start(saveId)).filter(e => e.offscreen).length, 0);
  lab.session.advance(saveId, '2d');
  const evs = await lab.session.start(saveId);
  const off = evs.filter(e => e.offscreen);
  assert.ok(off.length >= 1 && off.length <= 6);
  const all = lab.ledger.list(saveId, { all: true });
  assert.ok(all.every((e, i) => i === 0 || e.t >= all[i - 1].t));
  // a 'give' needs the user: refused offscreen
  lab.llm.mock.enqueue('catchup', { actions: [{ name: 'give', target: 'user', args: {}, why: 'x' }] });
  lab.session.advance(saveId, '1d');
  const evs2 = await lab.session.start(saveId);
  assert.ok(!evs2.some(e => e.action === 'give'));
});

test('proactive: same memory not offered twice within 3 days; delivery writes mentions', async () => {
  const { lab, saveId, say } = await freshLab();
  await say('这个红杯子是我奶奶留下的');
  await lab.jobs.idle(saveId);
  lab.session.advance(saveId, '1d');
  const r1 = await say('早');
  assert.equal(r1.reply.hints[0].rule, 'session_open');
  lab.proactive.recordDelivered(r1.turnId);
  const m = lab.db.prepare('SELECT * FROM mentions').all();
  assert.equal(m.length, 1);
  assert.equal(m[0].proactive, 1);
  assert.equal(lab.admission.allowed(saveId, 'rin', m[0].memory_ref, 'hint'), false);
  assert.equal(lab.admission.allowed(saveId, 'rin', m[0].memory_ref, 'context'), true);
});

test('forget.detect', () => {
  const v = t => detect(t)?.verb ?? null;
  assert.equal(v('请忘了那件事'), 'forget');
  assert.equal(v('忘了吧'), 'forget');
  assert.equal(v('把那件事忘掉'), 'forget');
  assert.equal(v('你忘了吗？'), null);
  assert.equal(v('别忘了明天的事'), null);
  assert.equal(v('你还记得我叫什么吗'), null);
  assert.equal(v('把刚才那件事的记录删掉'), 'delete');
  assert.equal(v('删掉这段对话'), 'delete');
  assert.equal(v('我把照片删了'), null);
  assert.deepEqual(detect('以后别再提猫的事了'), { verb: 'suppress', topic: '猫' });
  assert.deepEqual(detect('不要再问了'), { verb: 'suppress', topic: '' });
});

test('forget removes from context and rebuilds observations without it', async () => {
  const { lab, saveId, say } = await freshLab();
  for (const t of ['我昨天和前任吵架了', '今天天气不错', '我们去海边吧', '好呀']) await say(t);
  lab.session.end(saveId);
  await lab.jobs.idle(saveId);
  assert.ok(lab.observe.live(saveId, 'rin', 'observation').some(c => c.text.includes('前任')));
  await lab.session.start(saveId);
  lab.llm.mock.enqueue('forget_resolve', { topic: '前任的事', seqs: lab.ledger.list(saveId, { types: ['user_said', 'char_said'], all: true }).slice(0, 2).map(e => e.seq), fact_ids: [], cache_ids: [], commit_ids: [] });
  const r = await say('请忘了那件事');
  await lab.forget.confirm(r.forgetJob.id);
  await lab.jobs.idle(saveId);
  const live = lab.observe.live(saveId, 'rin', 'observation').map(c => c.text).join('\n');
  assert.doesNotMatch(live, /前任/);
  assert.match(live, /天气不错/); // the rest of the batch was rebuilt, once
  assert.equal((live.match(/天气不错/g) || []).length, 1);
  const r2 = await say('聊点别的');
  const prompt = lab.db.prepare('SELECT prompt_json FROM turns WHERE id = ?').get(r2.turnId).prompt_json;
  assert.doesNotMatch(prompt, /前任/);
});

test('a corrected name leaves both name slots (name and call_me)', async () => {
  const { lab, saveId, say } = await freshLab();
  lab.llm.mock.enqueue('facts', { facts: [{ predicate: 'name', object: '阿远', evidence: '我叫阿远', confidence: 0.9, corrects: null, valid_for: null }, { predicate: 'call_me', object: '阿远', evidence: '以后这么叫我', confidence: 0.9, corrects: null, valid_for: null }], commitments: [] });
  await say('我叫阿远，以后这么叫我');
  await lab.jobs.idle(saveId);
  const callMe = lab.facts.active(saveId, 'rin').find(f => f.predicate === 'call_me');
  lab.llm.mock.enqueue('facts', { facts: [{ predicate: 'call_me', object: '小远', evidence: '是小远', confidence: 0.9, corrects: callMe.id, valid_for: null }], commitments: [] });
  await say('不对，我写错了，是小远');
  await lab.jobs.idle(saveId);
  assert.deepEqual(lab.facts.active(saveId, 'rin').map(f => [f.predicate, f.object]), [['call_me', '小远']]);
  assert.deepEqual(lab.facts.all(saveId, 'rin').filter(f => f.status === 'superseded').map(f => f.predicate).sort(), ['call_me', 'name']);
});

test('a name correction without a corrects id still replaces the other name slot', async () => {
  const { lab, saveId, say } = await freshLab();
  await say('我叫阿远');
  await lab.jobs.idle(saveId);
  lab.llm.mock.enqueue('facts', { facts: [{ predicate: 'call_me', object: '小远', evidence: '是小远', confidence: 0.9, corrects: null, valid_for: null }], commitments: [] });
  await say('不对，我写错了，是小远');
  await lab.jobs.idle(saveId);
  assert.deepEqual(lab.facts.active(saveId, 'rin').map(f => [f.predicate, f.object]), [['call_me', '小远']]);
  // without correction words a call_me nickname sits next to the name
  lab.llm.mock.enqueue('facts', { facts: [{ predicate: 'name', object: '远山', evidence: '我叫远山', confidence: 0.9, corrects: null, valid_for: null }], commitments: [] });
  await say('我叫远山');
  await lab.jobs.idle(saveId);
  assert.equal(lab.facts.active(saveId, 'rin').length, 2);
});
