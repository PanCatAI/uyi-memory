// 2.0 D7: a three-arm run makes three saves that each reply with their own context mode for real, and nothing one
// arm does reaches another.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLab } from '../lib/lab.mjs';
import { createScenarios, loadScenario, ARMS } from '../lib/scenarios.mjs';

process.env.LAB_QUIET = '1';

test('S1 in three arms (mock): one save per arm, replies in that mode, independent ledgers, side-by-side page', async () => {
  const lab = createLab();
  const runner = createScenarios(lab);
  const g = await runner.startArms('s1-sword');
  assert.deepEqual(g.arms.map(a => a.arm), ARMS);
  const saves = g.arms.map(a => a.saveId);
  assert.equal(new Set(saves).size, 3);

  // The memory arm is an ordinary run: every assertion still passes.
  assert.equal(g.arms[0].state, 'passed');
  assert.equal(g.arms[0].summary.auto_fail, 0);

  const says = loadScenario('s1-sword').steps.filter(s => s.say).length;
  for (const a of g.arms) {
    assert.equal(lab.saves.getSave(a.saveId).reply_mode, a.arm);
    const committed = lab.db.prepare('SELECT mode, count(*) n FROM turns WHERE save_id = ? AND committed = 1 GROUP BY mode').all(a.saveId).map(r => ({ ...r }));
    assert.deepEqual(committed, [{ mode: a.arm, n: says }], `${a.arm} delivers in its own mode`);
    // Each save's ledger holds only its own conversation: one user_said and one char_said per say step.
    const evs = lab.ledger.list(a.saveId, { all: true });
    assert.equal(evs.filter(e => e.type === 'user_said').length, says);
    assert.equal(evs.filter(e => e.type === 'char_said' && !e.payload?.idle).length, says);
  }
  // Hints are memory mode only.
  const hinted = lab.db.prepare("SELECT count(*) n FROM turns WHERE save_id IN (?, ?) AND sections_json LIKE '%\"hints\"%'").get(saves[1], saves[2]).n;
  assert.equal(hinted, 0);

  // Something done in one arm does not show up in another.
  const before = saves.map(s => lab.ledger.lastSeq(s));
  const ch = lab.scene(saves[1]).characters[0].id;
  lab.ledger.append(saves[1], { type: 'char_said', actor: ch, payload: { text: '只在全量那一路', to: 'user', used: [], proactive: false } });
  assert.equal(lab.ledger.lastSeq(saves[0]), before[0]);
  assert.equal(lab.ledger.lastSeq(saves[2]), before[2]);
  assert.equal(lab.ledger.lastSeq(saves[1]), before[1] + 1);

  // The page: one row per say and review, three replies each; notes are kept.
  const page = runner.arms(g.group);
  const sayRows = page.steps.filter(r => r.kind === 'say');
  assert.equal(sayRows.length, says);
  for (const r of sayRows) for (const arm of ARMS) assert.equal(typeof r.arms[arm]?.reply, 'string', `step ${r.step} ${arm}`);
  const review = page.steps.find(r => r.kind === 'review');
  assert.ok(review);
  assert.equal(runner.setArmNote(g.group, review.step, '记忆那一路更像她').steps.find(r => r.step === review.step).note, '记忆那一路更像她');
  assert.equal(runner.armGroups()[0].group, g.group);
});

test('the same requestId never starts a second three-arm run', async () => {
  const runner = createScenarios(createLab());
  const [a, b] = await Promise.all([runner.startArms('trust-name', { requestId: 'arms-once' }), runner.startArms('trust-name', { requestId: 'arms-once' })]);
  assert.equal(a.group, b.group);
  const again = await runner.startArms('trust-name', { requestId: 'arms-once' });
  assert.equal(again.group, a.group);
});
