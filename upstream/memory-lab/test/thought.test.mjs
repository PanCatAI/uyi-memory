import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshLab } from './helpers/lab.mjs';

const MARK = 'THOUGHT_MARK_7';
const everywhere = (db, like) => ({
  user_facts: db.prepare('SELECT count(*) n FROM user_facts WHERE object LIKE ? OR evidence LIKE ?').get(like, like).n,
  caches: db.prepare('SELECT count(*) n FROM caches WHERE text LIKE ?').get(like).n,
  self_canon: db.prepare('SELECT count(*) n FROM self_canon WHERE text LIKE ?').get(like).n,
  events: db.prepare('SELECT count(*) n FROM events WHERE payload_json LIKE ?').get(like).n,
  turn_output: db.prepare('SELECT count(*) n FROM turns WHERE output_json LIKE ?').get(like).n,
  turn_thought: db.prepare('SELECT count(*) n FROM turns WHERE thought LIKE ?').get(like).n
});

test('thought stays on the turn row: not in the ledger, facts, caches, self canon or later context', async () => {
  const { lab, saveId, say } = await freshLab({ sceneId: 'camp' });
  const lines = ['我回来了', '我叫阿远，喜欢吃烤松子', '今天在北边看到一条溪', '你那把剑真好看', '明天我们一起去看看吧'];
  for (const text of lines) {
    lab.llm.mock.enqueue('reply', { thought: `${MARK} 想想怎么回`, mood: '高兴', say: '嗯，给你看个东西。', action: null, used: [], self_claims: ['我爱吃烤松子'] });
    // background jobs answer with text that would carry the mark if their input had it
    await say(text);
  }
  await lab.jobs.idle(saveId);
  const n = everywhere(lab.db, `%${MARK}%`);
  assert.deepEqual({ ...n, turn_thought: n.turn_thought > 0 }, { user_facts: 0, caches: 0, self_canon: 0, events: 0, turn_output: 0, turn_thought: true });
  const ctx = lab.context.build({ mode: 'memory', saveId, charId: 'lan', input: '嗯', inputSeq: null });
  assert.ok(!ctx.user.includes(MARK) && !ctx.system.includes(MARK));
  const prompts = lab.db.prepare('SELECT prompt_json FROM turns').all().map(r => r.prompt_json).join('');
  assert.ok(!prompts.includes(MARK), 'no later prompt carries a thought');
  const t = lab.db.prepare("SELECT * FROM turns WHERE mode = 'memory' ORDER BY rowid DESC LIMIT 1").get();
  assert.equal(lab.turns.view(t).thought, `${MARK} 想想怎么回`);
  assert.equal(lab.turns.view(t).mood, '高兴');
});

test('thought is cut to 40 characters; old replies without thought or mood still work', async () => {
  const { lab, say } = await freshLab({ sceneId: 'camp' });
  lab.llm.mock.enqueue('reply', { thought: '想'.repeat(60), say: '好。', action: null, used: [], self_claims: [] });
  await say('你好');
  assert.equal(lab.db.prepare('SELECT thought FROM turns ORDER BY rowid DESC LIMIT 1').get().thought.length, 40);
  const r = await say('第二句');
  assert.match(r.events.at(-1).payload.text, /收到/);
  const row = lab.db.prepare('SELECT thought, output_json FROM turns ORDER BY rowid DESC LIMIT 1').get();
  assert.equal(row.thought, null);
  assert.equal(JSON.parse(row.output_json).mood, '平常', 'missing mood is the default mood');
  const island = await freshLab();
  const r2 = await island.say('你好');
  assert.ok(r2.events.length);
});

test('the reply prompt asks for thought first and lists the card moods', async () => {
  const { lab, saveId } = await freshLab({ sceneId: 'camp' });
  const sys = lab.context.system(saveId, 'lan');
  assert.match(sys, /\{"thought": .*"mood": .*"say":/);
  assert.match(sys, /平常、高兴、紧张、生气、难过/);
});
