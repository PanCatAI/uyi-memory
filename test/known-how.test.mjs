// 2.0 D6: how 岚 knows things — 你说的 / 我看见的 / 我猜的 — and what she did not see stays a bare result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshLab } from './helpers/lab.mjs';

const sections = (lab, saveId, input = '嗯') => {
  const seq = lab.ledger.append(saveId, { type: 'user_said', actor: 'user', payload: { text: input, to: 'lan' } }).seq;
  return Object.fromEntries(lab.context.build({ mode: 'memory', saveId, charId: 'lan', input, inputSeq: seq }).sections.map(s => [s.name, s]));
};
const facts = (lab, saveId) => lab.facts.active(saveId, 'lan');
const enterTent = (lab, saveId) => lab.ledger.append(saveId, { type: 'char_action', actor: 'lan', action: 'enter', target: 'tent-1', outcome: 'ok', payload: { args: {} } });

test('told: from what the user said; seen: a gift she watched; both labelled in the context', async () => {
  const { lab, saveId, say } = await freshLab({ sceneId: 'camp' });
  await say('这杯子是我妈妈留下的');
  await lab.jobs.idle(saveId);
  lab.turns.act(saveId, { action: 'give', target: 'cup', args: { to: 'lan' } });
  const f = facts(lab, saveId);
  assert.equal(f.find(x => x.object.includes('妈妈')).known_how, 'told');
  const gift = f.find(x => x.known_how === 'seen');
  assert.equal(gift.object, '用户把潮青陶杯给了岚');
  const s = sections(lab, saveId);
  assert.match(s.facts.text, /妈妈.*（你说的，/);
  assert.match(s.facts.text, /用户把潮青陶杯给了岚（我看见的，/);
  assert.match(s.world.text, /｜我看见的/);
});

test('in the tent she does not see the cup moved: no seen fact, no event line, only where it is now', async () => {
  const { lab, saveId } = await freshLab({ sceneId: 'camp' });
  enterTent(lab, saveId);
  const [move] = lab.turns.act(saveId, { action: 'move_object', target: 'cup', args: { room: 'supply' } });
  assert.equal(facts(lab, saveId).filter(x => x.known_how === 'seen').length, 0, 'no seen from a move she did not perceive');
  lab.ledger.append(saveId, { type: 'char_action', actor: 'lan', action: 'leave', target: null, outcome: 'ok', payload: { args: {} } });
  const w = sections(lab, saveId, '我的杯子呢？').world;
  assert.ok(!w.refs.includes(`ev:${move.seq}`));
  assert.match(w.text, /潮青陶杯现在在物资角（不知道谁挪的）/);
  // Watching it happen is different: a seen fact and the event itself.
  lab.turns.act(saveId, { action: 'move_object', target: 'cup', args: { room: 'fireside' } });
  assert.ok(facts(lab, saveId).some(x => x.known_how === 'seen' && x.object === '用户把潮青陶杯挪到了篝火边'));
  assert.doesNotMatch(sections(lab, saveId).world.text, /不知道谁挪的/);
});

test('the system prompt asks her to speak by the label', async () => {
  const { lab, saveId } = await freshLab({ sceneId: 'camp' });
  assert.match(lab.context.system(saveId, 'lan'), /「你说的」就说「你跟我说过……」/);
});
