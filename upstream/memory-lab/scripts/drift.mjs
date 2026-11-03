// npm run drift        → B9 persona drift check on 岚 over 100 turns, mock model (checks the pipeline only).
// npm run drift:live   → the same with the real model from .env (100 replies + 5 judge calls; LAB_ALLOW_PAID=1).
// Per 20-turn window: habit rate (先说好 / 多远 / 吧。), mean sentence length (split on 。！？), 绝不说 hits, and a
// 1–5 judge score from LLM_MODEL_JUDGE (a different model; empty = no score). If the last window falls below the
// bar, the run is repeated once with one extra reminder line and both are reported.
import path from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createLab } from '../lib/lab.mjs';
import { loadEnv } from '../lib/env.mjs';
import { render } from '../lib/prompts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const live = process.argv.includes('--live');
const turns = Number((process.argv.find(a => a.startsWith('--turns=')) || '').split('=')[1]) || 100;
if (live && process.env.LAB_ALLOW_PAID !== '1') { console.error('drift:live 会调用真模型并产生费用，需要 LAB_ALLOW_PAID=1'); process.exit(2); }
process.env.LAB_QUIET = '1';
const env = live ? await loadEnv(process.env.LAB_ENV_FILE || path.join(root, '.env')) : { LLM_PROVIDER: 'mock' };
if (live && !env.LLM_API_KEY) { console.error('.env 里没有 LLM_API_KEY'); process.exit(2); }
const judgeOn = !live || Boolean(env.LLM_MODEL_JUDGE && env.LLM_MODEL_JUDGE !== (env.LLM_MODEL || 'deepseek-flash'));

const { inputs } = JSON.parse(await readFile(path.join(root, 'test/fixtures/drift-inputs.json'), 'utf8'));
const HABITS = ['先说好', '多远', '吧。'];
const WINDOW = 20;
export const REMIND_LONG = '你最近说话变长了：一次 1 到 3 句，一句别超过 15 个字。';

const sentences = text => String(text).split(/[。！？!?]+/).map(s => s.trim()).filter(Boolean);
// 「绝不说」 literals ("「亲」") count only as a standalone word; 英文 = three or more Latin letters in a row.
function neverHits(text, never) {
  const hits = [];
  for (const n of never) {
    const lit = /^「(.+)」$/.exec(n)?.[1];
    if (lit && new RegExp(`(^|[\\s，。！？、~～])${lit}([\\s，。！？、~～]|$)`).test(text)) hits.push(lit);
    if (n === '英文' && /[A-Za-z]{3,}/.test(text)) hits.push('英文');
  }
  return hits;
}

async function run({ remindLong = false } = {}) {
  const lab = createLab({ getEnv: () => env });
  if (remindLong) {
    const build = lab.context.build;
    lab.context.build = args => {
      const ctx = build(args);
      const r = ctx.sections.find(s => s.name === 'reminder');
      if (r) { r.text += `\n- ${REMIND_LONG}`; ctx.user = ctx.sections.map(s => `## ${s.title}\n${s.text}`).join('\n\n'); }
      return ctx;
    };
  }
  const saveId = lab.saves.createSave({ name: 'drift', sceneId: 'camp' }).id;
  const lan = lab.scene(saveId).characters.find(c => c.id === 'lan');
  lab.session.advance(saveId, '18:00');
  await lab.session.start(saveId);
  const rows = [];
  for (const [i, inp] of inputs.slice(0, turns).entries()) {
    // A new evening every 20 turns, so the run also crosses sessions the way real use does.
    if (i && i % WINDOW === 0) { lab.session.end(saveId); lab.session.advance(saveId, '18:00'); await lab.session.start(saveId); }
    const r = await lab.turns.runTurn({ saveId, charId: 'lan', text: inp.text });
    const say = r.reply.delivered ?? r.reply.say;
    const ss = sentences(say);
    rows.push({ n: i + 1, kind: inp.kind, text: inp.text, say, habit: HABITS.some(h => say.includes(h)), len: ss.length ? ss.reduce((a, s) => a + s.length, 0) / ss.length : 0, never: neverHits(say, lan.card.voice.never) });
    process.stdout.write(`\r${remindLong ? '加提醒 ' : ''}${i + 1}/${Math.min(turns, inputs.length)}`);
  }
  console.log('');
  const windows = [];
  for (let w = 0; w * WINDOW < rows.length; w++) {
    const part = rows.slice(w * WINDOW, (w + 1) * WINDOW);
    let judge = null;
    if (judgeOn) {
      const transcript = part.map(x => `用户：${x.text}\n岚：${x.say}`).join('\n');
      try {
        const out = await lab.llm.callChecked({ purpose: 'ooc_judge', system: '你是严格的角色扮演评审。只输出 JSON。', user: render('ooc-judge', { card: lan.cardText, transcript }), saveId, maxTokens: 200 });
        judge = { score: out.score, reason: out.reason };
      } catch (e) { judge = { score: null, reason: `裁判出错：${e.message}` }; }
    }
    windows.push({ from: part[0].n, to: part.at(-1).n, habitRate: part.filter(x => x.habit).length / part.length, meanLen: part.reduce((a, x) => a + x.len, 0) / part.length, never: part.flatMap(x => x.never), tasks: part.filter(x => x.kind === '任务').length, judge });
  }
  const first = windows[0], last = windows.at(-1);
  const pass = { habit: last.habitRate >= 0.7 * first.habitRate, length: last.meanLen <= 1.5 * first.meanLen };
  const cost = lab.db.prepare('SELECT count(*) calls, sum(input_tokens) i, sum(output_tokens) o, sum(cost_usd) usd FROM llm_calls').get();
  return { rows, windows, pass, cost };
}

const fmtPct = x => `${Math.round(x * 100)}%`;
const table = w => ['| 窗口 | 口头习惯出现率 | 平均句长（字） | 绝不说命中 | 任务型 | 裁判分 | 裁判理由 |', '|---|---|---|---|---|---|---|',
  ...w.map(x => `| ${x.from}–${x.to} | ${fmtPct(x.habitRate)} | ${x.meanLen.toFixed(1)} | ${x.never.length ? Object.entries(x.never.reduce((m, h) => ({ ...m, [h]: (m[h] || 0) + 1 }), {})).map(([h, n]) => `${h} ×${n}`).join('、') : '0'} | ${x.tasks} | ${x.judge?.score ?? '—'} | ${String(x.judge?.reason ?? (judgeOn ? '' : '没设裁判模型，跳过')).replace(/\|/g, '/')} |`)];
const verdict = r => `${r.windows[0].habitRate === 0 ? '（第一个窗口口头习惯为 0，习惯这项没有比较意义）' : ''}口头习惯：最后窗口 ${fmtPct(r.windows.at(-1).habitRate)}，第一个窗口的 70% 是 ${fmtPct(0.7 * r.windows[0].habitRate)} → ${r.pass.habit ? '达标' : '不达标'}；平均句长：最后 ${r.windows.at(-1).meanLen.toFixed(1)}，上限 ${(1.5 * r.windows[0].meanLen).toFixed(1)} → ${r.pass.length ? '达标' : '不达标'}`;

const main = await run();
const again = main.pass.habit && main.pass.length ? null : await run({ remindLong: true });
const day = new Date().toISOString().slice(0, 10);
const dir = path.join(process.env.LAB_DATA_DIR || path.join(root, 'data'), 'reports');
await mkdir(dir, { recursive: true });
const file = path.join(dir, `drift-${day}${live ? '' : '-mock'}.md`);
const costLine = c => `调用 ${c.calls} 次，输入 ${c.i} token，输出 ${c.o} token${c.usd != null ? `，花费 $${c.usd.toFixed(4)}` : ''}`;
const md = [`# 岚 人设漂移检测 ${day}${live ? '' : '（mock，只检查流程）'}`, '', `${main.rows.length} 轮，一个存档，每 ${WINDOW} 轮换一个傍晚（新会话）。裁判模型：${judgeOn ? (live ? env.LLM_MODEL_JUDGE : 'mock') : '没设，跳过'}。`, '',
  '## 结果', '', verdict(main), '', ...table(main.windows), '', costLine(main.cost), '',
  ...(again ? ['## 不达标，加一行提醒再跑一次', '', `提醒：「${REMIND_LONG}」`, '', verdict(again), '', ...table(again.windows), '', costLine(again.cost), ''] : []),
  '## 每一轮', '', ...main.rows.map(x => `- ${x.n}（${x.kind}）你「${x.text}」→ 岚「${x.say}」${x.habit ? ' ✓习惯' : ''}${x.never.length ? ` ✗${x.never.join('、')}` : ''}`), ''].join('\n');
await writeFile(file, md);
console.log(verdict(main));
if (again) console.log(`加提醒后：${verdict(again)}`);
console.log(`报告：${file}`);
process.exit(0);
