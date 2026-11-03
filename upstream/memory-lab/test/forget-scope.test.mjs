// R4 / P0-03: forgetting or deleting holds on every read and rebuild path — rebuilt caches, restarts, compare modes,
// learned self-claims and late background results. Ported from the audit counterexamples (now asserting the fix).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { freshLab } from './helpers/lab.mjs';
import { createLab } from '../lib/lab.mjs';

process.env.LAB_QUIET = '1';
const ctx = (lab, saveId, mode = 'memory') => lab.context.build({ mode, saveId, charId: 'rin', input: '接着聊吧' });
const confirmJob = async (lab, saveId, job) => { await lab.forget.confirm(job.id); await lab.jobs.idle(saveId); return lab.forget.getJob(job.id); };
const textIn = (lab, saveId, text) => ['caches:text', 'self_canon:text', "user_facts:object || evidence", 'events:payload_json', "turns:sections_json || prompt_json || coalesce(output_json, '') || coalesce(rejected_json, '')"]
  .filter(spec => { const [t, col] = spec.split(':'); return lab.db.prepare(`SELECT count(*) n FROM ${t} WHERE save_id = ? AND instr(${col}, ?) > 0`).get(saveId, text).n > 0; });

for (const verb of ['forget', 'delete']) {
  test(`${verb} a chosen experience: rebuilding, re-observing and restarting do not bring it back`, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'memory-lab-forget-'));
    const file = path.join(dir, 'lab.sqlite');
    try {
      const lab = createLab({ file });
      const saveId = lab.saves.createSave({ name: '忘记' }).id;
      await lab.session.start(saveId);
      lab.llm.mock.enqueue('reply', { say: '嗯嗯。', action: null, used: [], self_claims: [] }); // the default mock echoes the input
      await lab.turns.runTurn({ saveId, charId: 'rin', text: '我喜欢独立复核青梨酥' });
      await lab.turns.runTurn({ saveId, charId: 'rin', text: '今天天气不错' });
      await lab.jobs.idle(saveId);
      await lab.observe.run(saveId, 'rin', { force: true });
      const old = lab.observe.live(saveId, 'rin', 'observation').find(c => c.text.includes('青梨酥'));
      assert.ok(old);
      const job = await lab.forget.propose(saveId, 'rin', { verb, refs: [`cache:${old.id}`] });
      assert.equal((await confirmJob(lab, saveId, job)).state, 'reported');
      const back = () => lab.observe.live(saveId, 'rin', 'observation').filter(c => c.text.includes('青梨酥'));
      assert.deepEqual(back(), []);
      assert.ok(lab.observe.live(saveId, 'rin', 'observation').some(c => c.text.includes('天气')), 'the rest of the batch was rebuilt');
      assert.doesNotMatch(ctx(lab, saveId).sections.filter(s => s.name !== 'facts').map(s => s.text).join('\n'), /青梨酥/);
      await lab.observe.run(saveId, 'rin', { force: true });
      assert.deepEqual(back(), []);
      // A fact from the same sentence was not selected, so it stays.
      if (verb === 'forget') assert.ok(lab.facts.active(saveId, 'rin').some(f => f.object.includes('青梨酥')));
      // Deleting the experience deletes its original exchange and everything derived from it.
      if (verb === 'delete') assert.deepEqual(textIn(lab, saveId, '青梨酥'), []);
      lab.db.close();

      const again = createLab({ file });
      await again.observe.run(saveId, 'rin', { force: true });
      assert.deepEqual(again.observe.live(saveId, 'rin', 'observation').filter(c => c.text.includes('青梨酥')), []);
      for (const mode of ['memory', 'full', 'none']) assert.doesNotMatch(ctx(again, saveId, mode).sections.filter(s => s.name !== 'facts').map(s => s.text).join('\n'), /青梨酥/, mode);
      again.db.close();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

test('forgetting an experience also covers the reply in the same exchange (it would carry the content back)', async () => {
  const { lab, saveId, say } = await freshLab();
  await say('我最近在学做桂花糕'); // the default mock reply echoes it: "（mock）收到：我最近在学做桂花糕"
  await say('今天风挺大');
  await lab.jobs.idle(saveId);
  await lab.observe.run(saveId, 'rin', { force: true });
  const old = lab.observe.live(saveId, 'rin', 'observation').find(c => c.text.includes('桂花糕'));
  await confirmJob(lab, saveId, await lab.forget.propose(saveId, 'rin', { verb: 'forget', refs: [`cache:${old.id}`] }));
  assert.deepEqual(lab.observe.live(saveId, 'rin', 'observation').filter(c => c.text.includes('桂花糕')), []);
  assert.doesNotMatch(ctx(lab, saveId).sections.map(s => s.text).join('\n'), /桂花糕/);
  assert.match(ctx(lab, saveId).sections.find(s => s.name === 'recent').text, /风挺大/);
});

test('deleting the only source of a learned self-claim removes the claim; the authored card stays', async () => {
  const { lab, saveId, say } = await freshLab();
  const marker = '我喜欢独立复核青梨天文馆';
  lab.llm.mock.enqueue('reply', { say: marker, action: null, used: [], self_claims: [marker] });
  const first = await say('介绍一下你的喜好');
  await lab.jobs.idle(saveId);
  const source = first.events.find(e => e.type === 'char_said');
  const self = lab.selfCanon.list(saveId, 'rin').find(c => c.text === marker);
  assert.ok(self);
  const job = await lab.forget.propose(saveId, 'rin', { verb: 'delete', refs: [`ev:${source.seq}`] });
  const done = await confirmJob(lab, saveId, job);
  assert.equal(done.report.self_claims, 1);
  assert.equal(lab.admission.check(saveId, 'rin', `sc:${self.id}`).ok, false);
  const c = ctx(lab, saveId);
  assert.ok(!c.sections.find(s => s.name === 'self')?.text.includes(marker));
  assert.deepEqual(textIn(lab, saveId, marker), []);
  assert.ok(c.system.includes(lab.scene(saveId).characters.find(x => x.id === 'rin').cardText.slice(0, 20)));
});

test('forgetting the only source of a self-claim deactivates it; a claim with another live source stays', async () => {
  const { lab, saveId, say } = await freshLab();
  lab.llm.mock.enqueue('reply', { say: '我怕打雷，也爱看海。', action: null, used: [], self_claims: ['我爱看海'] });
  const a = await say('你怕什么');
  lab.llm.mock.enqueue('reply', { say: '我喜欢贝壳。', action: null, used: [], self_claims: ['我喜欢贝壳'] });
  await say('你喜欢什么');
  const seq = a.events.find(e => e.type === 'char_said').seq;
  await confirmJob(lab, saveId, await lab.forget.propose(saveId, 'rin', { verb: 'forget', refs: [`ev:${seq}`] }));
  const st = Object.fromEntries(lab.selfCanon.list(saveId, 'rin').map(r => [r.text, r.status]));
  assert.equal(st['我爱看海'], 'forgotten');
  assert.equal(st['我喜欢贝壳'], 'active');
  assert.ok(!ctx(lab, saveId).sections.find(s => s.name === 'self')?.text.includes('看海'));
});

test('compare modes share the retraction policy: a forgotten line is in no prompt', async () => {
  const { lab, saveId, say } = await freshLab();
  lab.llm.mock.enqueue('reply', { say: '好，我记住了。', action: null, used: [], self_claims: [] });
  const a = await say('我的秘密暗号是蓝鲸七号');
  await say('换个话题');
  await confirmJob(lab, saveId, await lab.forget.propose(saveId, 'rin', { verb: 'forget', refs: [`ev:${a.userEvent.seq}`] }));
  const r = await say('我们聊点别的', 'rin', true);
  for (const id of [r.turnId, r.compare.full.turnId, r.compare.none.turnId]) {
    const t = lab.db.prepare('SELECT mode, prompt_json FROM turns WHERE id = ?').get(id);
    assert.doesNotMatch(t.prompt_json, /蓝鲸七号/, t.mode);
  }
});

test('a late observe result never writes back content forgotten while the model was running', async () => {
  const { lab, saveId, say } = await freshLab();
  const a = await say('我喜欢迟到的晚霞糕');
  await say('嗯');
  await lab.jobs.idle(saveId);
  const running = lab.observe.run(saveId, 'rin', { force: true }); // the mock answer is computed now
  lab.db.prepare("INSERT INTO forgotten_seqs (save_id, character_id, seq, job_id, at) VALUES (?, 'rin', ?, 'fj_test', 0)").run(saveId, a.userEvent.seq);
  await running;
  assert.deepEqual(lab.observe.live(saveId, 'rin', 'observation').filter(c => c.text.includes('晚霞糕')), []);
});

test('forgotten_seqs is per character: another character keeps what it perceived', async () => {
  const { lab, saveId, say } = await freshLab();
  lab.turns.act(saveId, { action: 'move_character', target: 'qiao', args: { room: 'cabin' } });
  lab.llm.mock.enqueue('reply', { say: '我拿着。', action: { name: 'pick_up', target: 'red_cup', args: {} }, used: [], self_claims: [] });
  await say('拿着红杯子');
  const seq = lab.ledger.list(saveId, { types: ['char_action'], all: true }).at(-1).seq;
  lab.db.prepare("INSERT INTO forgotten_seqs (save_id, character_id, seq, job_id, at) VALUES (?, 'rin', ?, 'fj_test', 0)").run(saveId, seq);
  assert.equal(lab.admission.allowed(saveId, 'rin', `ev:${seq}`, 'context'), false);
  assert.equal(lab.admission.allowed(saveId, 'qiao', `ev:${seq}`, 'context'), true);
});
