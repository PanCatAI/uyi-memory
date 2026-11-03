// 2.0 D5: the relationship stage changes what she may say and how often she speaks up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshLab } from './helpers/lab.mjs';
import { STAGE_TABLE, IDLE_BUDGET, cooldownTurns } from '../lib/memory/relationship.mjs';

const SECRET = '给师父的信';
const build = (lab, saveId, input) => {
  const seq = lab.ledger.append(saveId, { type: 'user_said', actor: 'user', payload: { text: input, to: 'lan' } }).seq;
  return lab.context.build({ mode: 'memory', saveId, charId: 'lan', input, inputSeq: seq });
};

test('初识: the secret is nowhere in the context; 挚友 (floor): it is in lore, marked, and the stage change is an event', async () => {
  const { lab, saveId } = await freshLab({ sceneId: 'camp' });
  for (const mode of ['memory', 'full', 'none']) {
    const ctx = lab.context.build({ mode, saveId, charId: 'lan', input: '地图背面写的什么？', inputSeq: 0 });
    assert.ok(!`${ctx.system}\n${ctx.user}`.includes(SECRET), mode);
  }
  lab.relationship.setFloor(saveId, '挚友');
  assert.equal(lab.relationship.compute(saveId, 'lan').stage, '挚友');
  const ev = lab.relationship.sync(saveId, 'lan');
  assert.deepEqual(ev.payload, { from: '初识', to: '挚友' });
  assert.equal(lab.relationship.sync(saveId, 'lan'), null, 'once per change');
  const lore = build(lab, saveId, '地图背面写的什么？').sections.find(s => s.name === 'lore');
  assert.match(lore.text, new RegExp(`${SECRET}.*（这是你的秘密，被问到才说`));
  assert.ok(lore.refs.includes('secret:0'));
  assert.deepEqual(lab.relationship.history(saveId, 'lan').map(h => h.to), ['挚友']);
});

test('the table: idle budget and proactive cooldown by stage; address uses the name once close', async () => {
  assert.deepEqual(['初识', '熟悉', '亲近', '挚友'].map(s => IDLE_BUDGET[s]), [1, 2, 3, 4]);
  assert.deepEqual(['初识', '熟悉', '亲近', '挚友'].map(cooldownTurns), [8, 5, 4, 4]);
  assert.equal(STAGE_TABLE.挚友.secrets, true);
  const { lab, saveId, say } = await freshLab({ sceneId: 'camp' });
  await say('我叫阿远');
  await lab.jobs.idle(saveId);
  assert.match(lab.relationship.card(saveId, 'lan'), /称呼用户：叫「你」/);
  lab.relationship.setFloor(saveId, '亲近');
  assert.match(lab.relationship.card(saveId, 'lan'), /称呼用户：叫名字「阿远」/);
  const r = lab.relationship.compute(saveId, 'lan');
  assert.equal(r.next.stage, '挚友');
  assert.ok(r.next.missing.some(m => /再对话/.test(m)));
});

test('earning 熟悉 the normal way (10 talks, a day) writes one relationship_stage', async () => {
  const { lab, saveId, say } = await freshLab({ sceneId: 'camp' });
  for (let i = 0; i < 9; i++) await say(`第${i}句`);
  lab.session.advance(saveId, '1d');
  await say('又见面了');
  const evs = lab.ledger.list(saveId, { types: ['relationship_stage'], all: true });
  assert.deepEqual(evs.map(e => e.payload), [{ from: '初识', to: '熟悉' }]);
  assert.equal(lab.relationship.compute(saveId, 'lan').next.stage, '亲近');
  await say('嗯');
  assert.equal(lab.ledger.list(saveId, { types: ['relationship_stage'], all: true }).length, 1);
});
