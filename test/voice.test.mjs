import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshLab } from './helpers/lab.mjs';
import { analyzeLines, voiceLines, catchphrases, questions, echoOpening, stripPhrase } from '../lib/memory/voice.mjs';

// PLAN-3.0 附录 E: 岚's 8 lines in the S2 live run, oldest first.
const S2 = [
  '先说好，这杯子我不离手。火灭了，你拾柴还是我拾？',
  '周四……还有两天。先说好，守夜不是坐着聊天，得轮着看火。柴你拾还是我拾？',
  '坐就坐。先说好，柴的事你还没答我。',
  '长凳是新的吧，我坐了一天。阿砾下山去镇上，十天后才回。先说好，柴你到底拾不拾？',
  '在手里。说了不离手，就真没离。',
  '回来了。脚没起泡吧？今晚守夜，你答应的。',
  '行，不提了。火还旺着，今晚你先看着，我去看看雾散没散。',
  '守就守。先说好，雾这么大，守到半夜我换你。多远的路你今晚也别走。'
];
const PHRASES = [{ phrase: '先说好', every: 4 }, { phrase: '多远', every: 4 }];
const newestFirst = arr => arr.map(text => ({ text, user: '', intent: null })).reverse();

test('catchphrases come from the card habits; 「……吧。」 is not one; 每 N 句 sets the window', () => {
  const card = { voice: { habits: ['「先说好，……」（立规矩）（每 6 句最多 1 次）', '「多远？」（追问）', '句末常用「……吧。」表示拿定主意'] } };
  assert.deepEqual(catchphrases(card), [{ phrase: '先说好', every: 6 }, { phrase: '多远', every: 4 }]);
});

test('S2: 先说好 five times, the 柴 question asked twice in the same words, and the voice section says so', () => {
  const a = analyzeLines(newestFirst(S2), PHRASES);
  assert.equal(a.tics.find(t => t.phrase === '先说好').n, 5);
  const chai = a.nagging.find(g => /柴/.test(g.text));
  assert.ok(chai, JSON.stringify(a.nagging));
  assert.equal(chai.n, 2, '「柴你到底拾不拾」shares too few words to count as the same question');
  const lines = voiceLines(a);
  assert.ok(lines.some(l => l.includes('「先说好」') && l.includes('别用')));
  assert.ok(lines.some(l => l.includes('问了 2 次')));
});

test('echo openings: 「小远。」 opening a reply to the user\'s own words, three times in S1', () => {
  const s1 = [['我叫阿远，以后这么叫我。', '阿远。行，记住了。那先说路吧，今天走到哪儿了？'], ['不对，我写错了，是小远。', '小远。好，这个不会错。路呢，今天走到哪儿了？'], ['还记得我叫什么吗？小远', '小远。这个不会错。……三天没见，先说好，今天走到哪儿了？']];
  assert.equal(s1.filter(([u, r]) => echoOpening(r, u)).length, 3);
  assert.equal(echoOpening('回来了？脚没起泡吧。', '我回来了。'), null, 'a question is not an echo');
  const a = analyzeLines(s1.map(([user, text]) => ({ user, text, intent: '打听' })).reverse(), PHRASES);
  assert.equal(a.echoes.length, 3);
  assert.ok(a.askingRun);
  assert.ok(voiceLines(a).some(l => l.includes('拿他的话开头')));
  assert.ok(voiceLines(a).some(l => l.includes('三句都在问问题')));
});

test('nothing wrong → no lines; questions split by sentence; strip drops an opening catchphrase', () => {
  assert.deepEqual(voiceLines(analyzeLines(newestFirst(['火刚添过。', '给你看个东西。']), PHRASES)), []);
  assert.deepEqual(questions('回来了？脚没起泡吧。多远，说得出来吗？'), ['回来了', '说得出来吗']);
  assert.equal(stripPhrase('先说好，这杯子我不离手。', '先说好'), '这杯子我不离手。');
  assert.equal(stripPhrase('坐就坐。先说好，柴的事你还没答我。', '先说好'), '坐就坐。柴的事你还没答我。');
});

const camp = async (features = { voice: true }) => {
  const t = await freshLab({ sceneId: 'camp' });
  t.lab.setFeatures(t.saveId, features);
  return t;
};
const lastTurn = lab => lab.db.prepare("SELECT * FROM turns WHERE mode = 'memory' ORDER BY rowid DESC LIMIT 1").get();

test('E1: the voice section shows up only with the feature and only when something is wrong', async () => {
  const { lab, saveId, say } = await camp();
  lab.llm.mock.enqueue('reply', { say: '火刚添过，过来烤烤。', action: null, used: [], self_claims: [] });
  await say('我回来了');
  let ctx = lab.context.build({ saveId, charId: 'lan', input: '嗯' });
  assert.ok(!ctx.sections.some(s => s.name === 'voice'));
  lab.llm.mock.enqueue('reply', { say: '先说好，柴你拾还是我拾？', action: null, used: [], self_claims: [] });
  await say('坐下歇会儿');
  ctx = lab.context.build({ saveId, charId: 'lan', input: '嗯' });
  const v = ctx.sections.find(s => s.name === 'voice');
  assert.ok(v && v.text.includes('先说好'), JSON.stringify(ctx.sections.map(s => s.name)));
  assert.equal(ctx.sections.at(-3).name, 'voice', 'voice sits just before reminder and input');
  lab.setFeatures(saveId, { voice: false });
  assert.ok(!lab.context.build({ saveId, charId: 'lan', input: '嗯' }).sections.some(s => s.name === 'voice'));
});

test('E2: a repeated catchphrase / question gets one retry; a second miss strips the catchphrase', async () => {
  const { lab, say } = await camp();
  lab.llm.mock.enqueue('reply', { say: '先说好，柴你拾还是我拾？', intent: '打听', action: null, used: [], self_claims: [] });
  await say('我回来了');
  assert.equal(lastTurn(lab).intent, '打听');
  // same question again → retry; the retry is clean and is what gets said
  lab.llm.mock.enqueue('reply', { say: '先说好，柴你拾还是我拾？', action: null, used: [], self_claims: [] });
  lab.llm.mock.enqueue('reply', { say: '火我先添上，你歇着。', intent: '提议', action: null, used: [], self_claims: [] });
  let r = await say('坐下歇会儿');
  assert.equal(r.reply.delivered, '火我先添上，你歇着。');
  let rej = JSON.parse(lastTurn(lab).rejected_json);
  assert.deepEqual(rej.voice.tics, ['先说好']);
  assert.equal(rej.voice.repeats.length, 1);
  // both tries open with 先说好 → the retry is said with it cut off
  lab.llm.mock.enqueue('reply', { say: '先说好，今晚我守前半夜。', action: null, used: [], self_claims: [] });
  lab.llm.mock.enqueue('reply', { say: '先说好，今晚我守前半夜。', action: null, used: [], self_claims: [] });
  r = await say('今晚守夜吧');
  assert.equal(r.reply.delivered, '今晚我守前半夜。');
  rej = JSON.parse(lastTurn(lab).rejected_json);
  assert.deepEqual(rej.voice.stripped.phrases, ['先说好']);
  assert.equal(lastTurn(lab).intent, '回应', 'missing intent is 回应');
});

test('E2: without the feature nothing is checked (old saves and scenarios stay 2.0)', async () => {
  const { lab, say } = await camp({});
  for (let i = 0; i < 2; i++) {
    lab.llm.mock.enqueue('reply', { say: '先说好，柴你拾还是我拾？', action: null, used: [], self_claims: [] });
    const r = await say(`第${i}句`);
    assert.equal(r.reply.delivered, '先说好，柴你拾还是我拾？');
  }
  assert.equal(lab.llm.mock.pending('reply'), 0);
});

test('E2: an idle line over the catchphrase limit is not said', async () => {
  const { lab, saveId, say } = await camp();
  lab.llm.mock.enqueue('reply', { say: '先说好，火我看着。', action: null, used: [], self_claims: [] });
  await say('我回来了');
  lab.llm.mock.enqueue('idle', { thought: '想', urge: 0.9, intent: '提议', say: '先说好，今晚早点睡。', ref: null, action: null });
  const out = await lab.idle.run(saveId, 'lan', { now: Date.now() + 120_000 });
  assert.equal(out.spoke, false);
  assert.match(out.why, /说话重复/);
});
