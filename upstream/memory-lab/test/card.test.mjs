import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCardV2, thinCard } from '../lib/card.mjs';
import { parseCard } from '../lib/scene.mjs';

const lan = readFileSync(new URL('../characters/lan.md', import.meta.url), 'utf8');
const P = parseCardV2(lan);
const card = (sections) => `# 测\n\n${sections}`;

test('lan: meta, canon, looks, traits', () => {
  assert.equal(P.name, '岚');
  assert.deepEqual(P.meta, { id: 'lan', 语言: '中文', 年龄: '26', 性别: '女' });
  assert.equal(P.canon.length, 5);
  assert.match(P.canon[1], /铜羽短剑/);
  assert.match(P.card.looks, /深色短发/);
  assert.deepEqual(P.card.traits.map(t => t.name), ['急', '较真', '嘴硬心软', '怕被看出害怕', '爱打赌', '会逗人']);
  assert.match(P.card.wants, /^想要/);
  assert.match(P.card.knows, /那玩意儿/);
});

test('lan: voice', () => {
  const v = P.card.voice;
  assert.match(v.length, /最多 5 句/);
  assert.match(v.habits[0], /每 6 句最多 1 次/);
  assert.equal(v.habits.length, 3);
  assert.equal(v.metaphors.length, 3);
  assert.deepEqual(v.never, ['网络流行语', '「亲」', '长篇大道理', '英文']);
});

test('lan: examples, moods, lore', () => {
  assert.equal(P.card.examples.length, 10);
  assert.deepEqual(P.card.examples[0], { occasion: '打招呼', user: '我回来了。', speaker: '岚', reply: '回来了？脚没起泡吧。火刚添过，过来烤烤。' });
  assert.deepEqual(P.card.moods.map(m => m.name), ['平常', '高兴', '紧张', '生气', '难过']);
  assert.equal(P.card.moods[2].action, '摸短剑的剑柄。');
  assert.equal(P.card.lore.length, 10);
  const sword = P.card.lore.find(l => l.id === 'lore_sword');
  assert.deepEqual(sword.keywords, ['剑', '短剑', '铜羽', '腰上']);
  assert.equal(sword.stage, '初识');
  assert.equal(P.card.lore.find(l => l.id === 'lore_harbor').stage, '亲近');
});

test('lan: routine covers the day with parsed steps', () => {
  const r = P.card.routine;
  assert.equal(r.length, 6);
  assert.deepEqual(r[1].steps, [{ name: 'walk_to', target: 'log-bench-1', args: {} }, { name: 'sit', target: 'log-bench-1', args: {} }, { name: 'draw_map', target: null, args: { with: 'cup' } }]);
  assert.equal(r[5].from, '22:00');
  assert.equal(r[5].to, '05:30');
});

test('lan: secrets, arc, reminder, forbid', () => {
  assert.equal(P.card.secrets.length, 1);
  assert.equal(P.card.secrets[0].stage, '挚友');
  assert.deepEqual(Object.keys(P.card.arc), ['初识', '熟悉', '亲近', '挚友']);
  assert.equal(P.card.reminder.length, 3);
  assert.equal(P.card.forbid.length, 2);
});

test('old cards keep their canon exactly', () => {
  for (const f of ['rin', 'qiao']) {
    const text = readFileSync(new URL(`../characters/${f}.md`, import.meta.url), 'utf8');
    const old = [];
    let inCanon = false;
    for (const line of text.split(/\r?\n/)) {
      if (/^##\s/.test(line)) { inCanon = /^##\s*设定/.test(line); continue; }
      if (inCanon && /^\s*-\s+/.test(line)) old.push(line.replace(/^\s*-\s+/, '').trim());
    }
    const p = parseCard(text);
    assert.deepEqual(p.canon, old, f);
    assert.equal(p.text, text.trim());
    assert.equal(p.card.moods[0].name, '平常');
    assert.ok(p.card.voice.length.length > 0, `${f} 说话方式整段当句长`);
  }
});

test('error: overlapping routine', () => {
  assert.throws(() => parseCardV2(card('## 作息\n- 00:00–12:00｜a｜b｜idle\n- 11:00–00:00｜a｜b｜idle')), /第 5 行：作息时间段重叠（和第 4 行）/);
});

test('error: routine gap', () => {
  assert.throws(() => parseCardV2(card('## 作息\n- 00:00–12:00｜a｜b｜idle\n- 13:00–00:00｜a｜b｜idle')), /没有覆盖 24 小时（12:00 没安排）/);
});

test('error: duplicate mood name', () => {
  assert.throws(() => parseCardV2(card('## 情绪模式\n- 平常：快｜动作：走\n- 平常：慢')), /第 5 行：情绪模式重名：平常/);
});

test('error: lore without id', () => {
  assert.throws(() => parseCardV2(card('## 过往\n- 没有 id 的一条｜正文')), /第 4 行：过往要以 \[id\] 开头/);
});

test('error: unknown stage', () => {
  assert.throws(() => parseCardV2(card('## 过往\n- [x1] 题｜文｜关键词：a｜可说：陌生')), /阶段名不认识：陌生/);
  assert.throws(() => parseCardV2(card('## 成长弧\n- 路人：嗨')), /第 4 行：阶段名不认识：路人/);
});

test('error: too many reminders, bad example', () => {
  assert.throws(() => parseCardV2(card('## 深度提醒\n- a\n- b\n- c\n- d')), /第 7 行：深度提醒最多 3 条/);
  assert.throws(() => parseCardV2(card('## 示例对话\n随便一句话')), /第 4 行：示例对话要写成/);
});

test('unknown sections are kept, thinCard keeps canon + voice + forbid', () => {
  const p = parseCardV2(card('## 小秘方\n一些文字\n\n## 设定\n- 甲'));
  assert.equal(p.extra['小秘方'], '一些文字');
  const thin = parseCard(thinCard(P));
  assert.deepEqual(thin.canon, P.canon);
  assert.equal(thin.card.lore.length, 0);
  assert.match(thin.text, /先说好/);
});
