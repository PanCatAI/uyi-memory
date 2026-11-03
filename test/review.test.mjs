// R8 / P1-03: a turn can be read back after a reload (all modes of one input, same world), scenario runs keep their
// history with replies, exports carry versions but never the key, and skipped / to-judge steps are not passes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLab } from '../lib/lab.mjs';
import { createScenarios, summarize } from '../lib/scenarios.mjs';
import { freshLab } from './helpers/lab.mjs';

process.env.LAB_QUIET = '1';
const line = (say, action) => ({ say, action, used: [], self_claims: [] });

test('turn groups restore every mode of one input after reopening the database', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'memory-lab-review-'));
  const file = path.join(dir, 'lab.sqlite');
  try {
    const lab = createLab({ file });
    const saveId = lab.saves.createSave({ name: '回看' }).id;
    await lab.session.start(saveId);
    lab.llm.mock.enqueue('reply', line('我去灯塔。', { name: 'walk_to', target: 'lighthouse', args: {} }));
    lab.llm.mock.enqueue('reply', line('我拿贝壳。', { name: 'pick_up', target: 'shell', args: {} })); // full: illegal here
    lab.llm.mock.enqueue('reply', line('我拿杯子。', { name: 'pick_up', target: 'red_cup', args: {} })); // none: legal, not executed
    const r = await lab.turns.runTurn({ saveId, charId: 'rin', text: '去灯塔吧', compare: true });
    assert.equal(r.compare.full.actionResult.ok, false);
    assert.equal(r.compare.none.actionResult.ok, true);
    assert.equal(lab.ledger.world(saveId).characters.rin.holding, null); // compare actions never run
    lab.db.close();

    const again = createLab({ file });
    const [g] = again.turns.groups(saveId, 'rin');
    assert.equal(g.userSeq, r.userEvent.seq);
    assert.deepEqual(Object.keys(g.modes).sort(), ['full', 'memory', 'none']);
    assert.equal(g.modes.memory.delivered, '我去灯塔。');
    assert.deepEqual(g.modes.memory.actionResult, { ok: true });
    assert.equal(g.modes.full.actionResult.ok, false);
    assert.equal(g.modes.full.actionResult.executed, false);
    assert.match(g.modes.full.actionResult.reason, /贝壳不在这里/);
    assert.equal(g.modes.none.actionResult.ok, true);
    for (const m of ['memory', 'full', 'none']) {
      assert.ok(g.modes[m].calls.length >= 1, `${m} has its API attempts`);
      assert.ok(g.modes[m].tokens > 0);
      assert.equal(g.modes[m].inputTokens, null); // mock: no provider-reported tokens, so none claimed
    }
    assert.equal(g.modes.memory.committed, true);
    assert.equal(g.modes.full.committed, false);
    again.db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the transcript comparison says how much was cut', async () => {
  const { lab, saveId, say } = await freshLab();
  await say('你好');
  const ctx = lab.context.build({ mode: 'full', saveId, charId: 'rin', input: 'x' });
  const t = ctx.sections.find(s => s.name === 'transcript');
  assert.match(t.why, /聊天原文，全部 \d+ 条/);
  const none = lab.context.build({ mode: 'none', saveId, charId: 'rin', input: 'x' }).sections.find(s => s.name === 'recent');
  assert.match(none.why, /短上下文，本次会话最近 6 条/);
});

test('scenario runs keep their history with replies across a restart; export has versions, never the key', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'memory-lab-runs-'));
  const file = path.join(dir, 'lab.sqlite');
  try {
    const lab = createLab({ file });
    const v = await createScenarios(lab).start('red-cup', { requestId: 'hist-1' });
    assert.equal(v.state, 'passed');
    lab.db.close();

    const again = createLab({ file });
    const runner = createScenarios(again);
    const [h] = runner.history();
    assert.equal(h.id, v.id);
    const says = h.results.filter(r => r.kind === 'say');
    assert.ok(says.length >= 2 && says.every(r => typeof r.reply === 'string' && r.input));
    assert.deepEqual(h.summary, summarize(h.results));
    const ex = runner.exportRun(h.id, { provider: 'openai_compat', model: 'deepseek-flash', keySet: true, baseUrl: 'https://x' });
    assert.match(ex.versions.code, /^[0-9a-f]{16}$/);
    for (const k of ['prompts', 'contracts', 'scenario', 'scene']) assert.match(ex.versions[k], /^[0-9a-f]{16}$/);
    assert.equal(ex.settings.key_set, true);
    assert.equal('keySet' in ex.settings, false);
    assert.deepEqual(ex.served_models, ['mock']);
    assert.equal(ex.event_cutoff, again.ledger.lastSeq(h.saveId));
    assert.deepEqual(ex.failures, []);
    assert.ok(ex.calls.length > 0);
    again.db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('summary: skipped and to-judge steps are counted apart and are not passes', () => {
  const s = summarize([
    { kind: 'expect', ok: true }, { kind: 'expect', ok: false }, { kind: 'expect', ok: null, skip: true },
    { kind: 'review', ok: null, review: true }, { kind: 'say', ok: true }
  ]);
  assert.deepEqual(s, { auto_pass: 1, auto_fail: 1, skipped: 1, review_pending: 1 });
});
