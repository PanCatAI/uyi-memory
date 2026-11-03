import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshLab } from './helpers/lab.mjs';
import { CardError } from '../lib/cards.mjs';

test('canon change rechecks self claims; scene sees the new card; budget enforced', async () => {
  const { lab, saveId } = await freshLab({ sceneId: 'camp' });
  lab.selfCanon.add(saveId, 'lan', ['我怕打雷'], 1);
  assert.equal(lab.selfCanon.list(saveId, 'lan')[0].status, 'active');
  const v0 = lab.cards.current(saveId, 'lan');
  const r = lab.cards.save(saveId, 'lan', v0.text.replace('## 外貌', '- 不怕打雷。\n\n## 外貌'), '加一条设定');
  assert.deepEqual(r.selfCanonChanged.map(x => x.status), ['conflicts_canon']);
  assert.equal(lab.selfCanon.list(saveId, 'lan')[0].status, 'conflicts_canon');
  assert.ok(lab.scene(saveId).characters[0].canon.includes('不怕打雷。'));
  assert.equal(lab.scene(saveId).characters[0].cardVersion, 1);
  lab.cards.restore(saveId, 'lan', 0);
  assert.equal(lab.selfCanon.list(saveId, 'lan')[0].status, 'active', 'restoring the old canon clears the conflict');
  const long = v0.text.replace('## 外貌\n', `## 外貌\n${'很长的外貌描写。'.repeat(300)}\n`);
  assert.throws(() => lab.cards.save(saveId, 'lan', long), e => e instanceof CardError && /超过上限 1400/.test(e.message));
  assert.throws(() => lab.cards.save(saveId, 'lan', '没有标题'), CardError);
  assert.equal(lab.cards.current(saveId, 'lan').version, 2);
  // other saves keep the file card
  const other = lab.saves.createSave({ name: 'b', sceneId: 'camp' }).id;
  assert.equal(lab.cards.current(other, 'lan').version, 0);
  assert.ok(!lab.scene(other).characters[0].canon.includes('不怕打雷。'));
});

test('draft: mock draft parses; bad then good costs exactly two calls; bad twice returns the raw text', async () => {
  const { draftCard } = await import('../lib/cards.mjs');
  const { parseCardV2 } = await import('../lib/card.mjs');
  const { lab, saveId } = await freshLab({ sceneId: 'camp' });
  const calls = () => lab.db.prepare("SELECT count(*) n FROM llm_calls WHERE purpose = 'card_draft'").get().n;
  const d = await draftCard(lab, { saveId, looks: '深色短发，青蓝外套', persona: '急性子的女绘图员，师父失踪了' });
  assert.equal(d.ok, true);
  assert.match(parseCardV2(d.text).card.looks, /深色短发/);
  assert.equal(calls(), 1);
  const good = d.text;
  lab.llm.mock.enqueue('card_draft', { card: good.replace('00:00–24:00', '00:00–12:00') });
  lab.llm.mock.enqueue('card_draft', { card: good });
  const d2 = await draftCard(lab, { saveId, looks: 'x', persona: 'y' });
  assert.deepEqual([d2.ok, d2.attempts, calls()], [true, 2, 3]);
  lab.llm.mock.enqueue('card_draft', { card: '# 坏\n## 作息\n- 01:00–02:00｜a｜b｜idle' });
  lab.llm.mock.enqueue('card_draft', { card: '# 坏\n## 作息\n- 01:00–02:00｜a｜b｜idle' });
  const d3 = await draftCard(lab, { saveId });
  assert.equal(d3.ok, false);
  assert.match(d3.error, /^第 \d+ 行：作息没有覆盖 24 小时/);
  assert.match(d3.text, /^# 坏/);
  assert.equal(calls(), 5);
  assert.equal(lab.cards.current(saveId, 'lan').version, 0, 'drafting never saves');
});
