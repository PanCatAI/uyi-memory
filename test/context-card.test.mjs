import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { freshLab } from './helpers/lab.mjs';
import { selectLore } from '../lib/memory/lore.mjs';
import { loadScene } from '../lib/scene.mjs';

const lan = loadScene('camp').characters[0];
const build = (lab, saveId, input, mode = 'memory') => {
  const seq = lab.ledger.append(saveId, { type: 'user_said', actor: 'user', payload: { text: input, to: 'lan' } }).seq;
  return lab.context.build({ mode, saveId, charId: 'lan', input, inputSeq: seq });
};
const names = ctx => ctx.sections.map(s => s.name);
const sec = (ctx, n) => ctx.sections.find(s => s.name === n);

test('2.0 system prompt: fixed sections in order, identical across builds, within budget', async () => {
  const { lab, saveId } = await freshLab({ sceneId: 'camp' });
  const a = lab.context.system(saveId, 'lan');
  const b = build(lab, saveId, '你好').system;
  assert.equal(a, b);
  const order = ['## 设定', '## 外貌', '## 核心性格', '## 想要 / 需要', '## 价值观与底线', '## 说话方式', '## 对用户的初始看法', '## 知识边界', '## 禁止', '## 示例对话'];
  const at = order.map(h => a.indexOf(h));
  assert.ok(at.every(i => i >= 0), JSON.stringify(at));
  assert.deepEqual([...at].sort((x, y) => x - y), at);
  assert.equal((a.match(/^<[^>]+> 用户：/gm) || []).length, 10);
  for (const leak of ['lore_harbor', '地图背面', '深度提醒', '作息']) assert.ok(!a.includes(leak), leak);
});

test('2.0 C7: the system prompt is byte-identical for 10 turns in a row (so the provider can cache it)', async () => {
  const { lab, saveId, say } = await freshLab({ sceneId: 'camp' });
  for (const text of ['你好', '今天天气怎么样', '你腰上那把剑哪来的？', '我叫阿远', '我们去溪边吧', '嗯', '你累吗', '火真暖', '明天见', '晚安']) await say(text);
  const hashes = lab.db.prepare("SELECT prompt_json FROM turns WHERE save_id = ? AND mode = 'memory' ORDER BY t, rowid").all(saveId)
    .map(r => createHash('sha256').update(JSON.parse(r.prompt_json).find(m => m.role === 'system').content).digest('hex'));
  assert.ok(hashes.length >= 10, String(hashes.length));
  assert.equal(new Set(hashes).size, 1);
});

test('1.0 cards keep their text verbatim', async () => {
  const { lab, saveId, scene } = await freshLab();
  assert.ok(lab.context.system(saveId, 'rin').includes(scene.characters.find(c => c.id === 'rin').cardText));
});

test('lore: keyword hit, stage gate, at most 3', async () => {
  const { lab, saveId } = await freshLab({ sceneId: 'camp' });
  const ctx = build(lab, saveId, '你腰上那把剑是哪来的？');
  assert.ok(sec(ctx, 'lore').refs.includes('lore:lore_sword'));
  assert.match(sec(ctx, 'lore').text, /你可以自己决定说不说/);
  const water = build(lab, saveId, '你会游泳吗？前面有条溪');
  assert.ok(!(sec(water, 'lore')?.refs || []).includes('lore:lore_harbor'), '初识 does not get 亲近 lore');
  const real = lab.relationship.compute;
  lab.relationship.compute = (...a) => ({ ...real(...a), stage: '亲近' });
  const close = build(lab, saveId, '你会游泳吗？前面有条溪');
  assert.ok(sec(close, 'lore').refs.includes('lore:lore_harbor'));
  lab.relationship.compute = real;
  assert.ok(selectLore(lan.card.lore, { input: '剑 星星 吃 阿砾 第一张', stage: '挚友' }).length <= 3);
  assert.deepEqual(selectLore(lan.card.lore, { input: '今天天气不错' }), []);
  // recent talk counts once, the latest line twice
  const r = selectLore(lan.card.lore, { input: '晚上看星星吗', recent: ['你那把剑', '剑柄上缠的什么'] });
  assert.deepEqual(r.map(x => x.id), ['lore_stars', 'lore_sword']); // 2 hits × 2 beats 2 hits × 1
  assert.deepEqual(selectLore(lan.card.lore, { input: '想吃点啥', recent: ['剑', '短剑', '铜羽'] }).map(x => x.id), ['lore_sword', 'lore_food']);
  assert.equal(sec(build(lab, saveId, '剑', 'full'), 'lore'), undefined, 'comparison modes have no lore');
});

test('mood follows the last reply; reminder is the last section before input; arc line', async () => {
  const { lab, saveId, say } = await freshLab({ sceneId: 'camp' });
  let ctx = build(lab, saveId, '你好');
  assert.match(sec(ctx, 'mood').text, /^你现在：平常。/);
  lab.llm.mock.enqueue('reply', { say: '你确定？', mood: '紧张', action: null, used: [], self_claims: [] });
  await say('我们明天翻山吧');
  ctx = build(lab, saveId, '你还好吗');
  assert.equal(sec(ctx, 'mood').text, '你现在：紧张。句子变短，反复确认「你确定？」。会摸短剑的剑柄。');
  lab.llm.mock.enqueue('reply', { say: '嗯。', mood: '不存在的情绪', action: null, used: [], self_claims: [] });
  await say('好吧');
  assert.match(sec(build(lab, saveId, '嗯'), 'mood').text, /^你现在：平常。/, 'unknown mood falls back to the default');
  for (const mode of ['memory', 'full', 'none']) {
    const n = names(build(lab, saveId, '嗯', mode));
    assert.equal(n.at(-1), 'input');
    assert.equal(n.at(-2), 'reminder', mode);
    assert.ok(n.includes('mood'), mode);
  }
  assert.match(sec(ctx, 'relationship').text, /这个阶段的你：客气、立规矩/);
});
