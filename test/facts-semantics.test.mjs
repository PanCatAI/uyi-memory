// R6 / P1-04: a negated substring is not evidence, and refs are checked by save / character / kind / existence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshLab } from './helpers/lab.mjs';
import { negated } from '../lib/memory/facts.mjs';

const cand = (predicate, object, evidence) => ({ predicate, object, evidence, confidence: 0.9, corrects: null, valid_for: null });

test('negation-aware evidence: frozen trap set', () => {
  const cases = [
    ['likes', '我不喜欢香菜', '喜欢香菜', true],
    ['likes', '我不喜欢香菜', '我不喜欢香菜', true],
    ['likes', '我没那么喜欢猫', '喜欢猫', false], // not directly negated: kept (the model's call, still evidence-checked)
    ['likes', '我喜欢香菜', '喜欢香菜', false],
    ['likes', '我不太喜欢下雨', '喜欢下雨', true],
    ['likes', '别以为我喜欢下雨，其实我喜欢下雨', '喜欢下雨', false], // one clean occurrence is enough
    ['dislikes', '我不喜欢香菜', '我不喜欢香菜', false],
    ['dislikes', '我不讨厌香菜', '讨厌香菜', true],
    ['owns', '我没有猫', '有猫', true],
    ['owns', '我有一只猫', '有一只猫', false],
    ['plan', '我不打算去灯塔', '打算去灯塔', true],
    ['name', '是美林不是林', '是美林不是林', false], // single-value names are handled by corrections, not this rule
    ['plan', '我不打算去灯塔了', '我不打算去灯塔了', false, '不去灯塔'], // found live: the object carries the negation
    ['likes', '我不喜欢香菜', '我不喜欢香菜', true, '不喜欢香菜']
  ];
  for (const [p, source, evidence, expected, object] of cases) assert.equal(negated(p, source, evidence, object), expected, `${p} ${source} / ${evidence}`);
});

test('"我不喜欢香菜" does not become likes:香菜 (F5, fault-injected extraction)', async () => {
  const { lab, saveId, say } = await freshLab();
  lab.llm.mock.enqueue('facts', { facts: [cand('likes', '香菜', '喜欢香菜')], commitments: [] });
  await say('我不喜欢香菜');
  await lab.jobs.idle(saveId);
  assert.deepEqual(lab.facts.active(saveId, 'rin').filter(f => f.predicate === 'likes'), []);
  assert.ok(lab.db.prepare("SELECT 1 FROM rejected_facts WHERE save_id = ? AND reason = 'negated'").get(saveId));
  lab.llm.mock.enqueue('facts', { facts: [cand('dislikes', '香菜', '不喜欢香菜')], commitments: [] });
  await say('真的，我不喜欢香菜');
  await lab.jobs.idle(saveId);
  assert.ok(lab.facts.active(saveId, 'rin').some(f => f.predicate === 'dislikes' && f.object === '香菜'));
});

test('refs from another save, another character, an unknown kind or nowhere fail without side effects (F6)', async () => {
  const { lab, saveId, say } = await freshLab();
  await say('我喜欢审查海盐饼');
  await lab.jobs.idle(saveId);
  const f = lab.facts.active(saveId, 'rin')[0];
  const other = lab.saves.createSave({ name: '另一个存档' }).id;
  const jobsBefore = lab.forget.list(saveId).length + lab.forget.list(other).length;
  await assert.rejects(lab.forget.propose(other, 'qiao', { verb: 'forget', refs: [`fact:${f.id}`] }), /不属于/);
  await assert.rejects(lab.forget.propose(saveId, 'qiao', { verb: 'forget', refs: [`fact:${f.id}`] }), /不属于/);
  await assert.rejects(lab.forget.propose(saveId, 'rin', { verb: 'forget', refs: ['fact:f_nope'] }), /不属于/);
  await assert.rejects(lab.forget.propose(saveId, 'rin', { verb: 'forget', refs: [`weird:${f.id}`] }), /不认识/);
  await assert.rejects(lab.forget.propose(saveId, 'rin', { verb: 'forget', refs: ['ev:99999'] }), /不属于/);
  assert.equal(lab.forget.list(saveId).length + lab.forget.list(other).length, jobsBefore);
  assert.equal(lab.facts.all(saveId, 'rin')[0].status, 'active');
  // A legal ref still works.
  const job = await lab.forget.propose(saveId, 'rin', { verb: 'forget', refs: [`fact:${f.id}`] });
  await lab.forget.confirm(job.id); await lab.jobs.idle(saveId);
  assert.equal(lab.facts.all(saveId, 'rin')[0].status, 'forgotten');
});

test('apply only touches its own save even if a job row names a foreign id', async () => {
  const { lab, saveId, say } = await freshLab();
  await say('我喜欢审查海盐饼');
  await lab.jobs.idle(saveId);
  const f = lab.facts.active(saveId, 'rin')[0];
  const other = lab.saves.createSave({ name: '另一个存档' }).id;
  await assert.rejects(lab.forget.propose(other, 'rin', { verb: 'forget', refs: ['ev:0'] }), /不属于/);
  // A job row written by something else (an older version, a hand edit) that names a foreign fact id:
  lab.db.prepare("INSERT INTO forget_jobs (id, save_id, character_id, verb, request_seq, topic, state, candidates_json, created_at) VALUES ('fj_x', ?, 'rin', 'forget', 0, '', 'confirmed', ?, 0)").run(other, JSON.stringify({ seqs: [], fact_ids: [f.id], cache_ids: [], commit_ids: [] }));
  await lab.forget.apply('fj_x');
  assert.equal(lab.facts.all(saveId, 'rin')[0].status, 'active');
});
