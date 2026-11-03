// 3.0 E6: npm run fun-ab (mock) / fun-ab:live — whole-conversation blind test. Each group: the 好奇 simulated user
// talks 8 turns with 岚 twice from the same start (camp, day 1, 18:00) and the same seed, once with the 3.0 features off
// (= 2.0) and once with all of them on. The page shows both conversations side by side (sides shuffled); Jonathan picks
// the one he would rather keep playing, and the score shows only when every group is picked.
// --groups=10  --turns=8  --model-b=<model>: the 3.0 side uses another chat model (design vs model).
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createLab } from '../lib/lab.mjs';
import { loadEnv } from '../lib/env.mjs';
import { simulate } from '../lib/simulate.mjs';
import { ALL_ON } from '../lib/features.mjs';
import { metricCells, METRIC_HEADS } from '../lib/fun.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
const live = process.argv.includes('--live');
if (live && process.env.LAB_ALLOW_PAID !== '1') { console.error('fun-ab:live 会调用真模型并产生费用，需要 LAB_ALLOW_PAID=1'); process.exit(2); }
process.env.LAB_QUIET = '1';
const env = live ? await loadEnv(process.env.LAB_ENV_FILE || path.join(root, '.env')) : { LLM_PROVIDER: 'mock' };
if (live && !env.LLM_API_KEY) { console.error('.env 里没有 LLM_API_KEY'); process.exit(2); }
const groups = Number(arg('groups') || 10);
const turns = Number(arg('turns') || 8);
const modelB = arg('model-b') || null;
const labA = createLab({ getEnv: () => env });
const labB = modelB ? createLab({ getEnv: () => ({ ...env, LLM_MODEL: modelB }) }) : labA;
const maxUsd = Number(process.env.LAB_SIM_MAX_USD || 1.5) / (groups * 2);

let seed = 20261025;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const items = [];
for (let g = 1; g <= groups; g++) {
  const run = (lab, features) => simulate(lab, { persona: '好奇', days: 1, seed: 100 + g, turnsPerDay: turns, features, maxUsd: live ? maxUsd * 4 : null });
  const off = await run(labA, null);
  const on = await run(labB, ALL_ON);
  const newLeft = rand() < 0.5;
  const pack = r => ({ lines: r.days[0]?.lines || [], fun: r.totals.fun });
  items.push({ n: g, left: pack(newLeft ? on : off), right: pack(newLeft ? off : on), newSide: newLeft ? 'left' : 'right' });
  process.stdout.write(`\r${g}/${groups}`);
}
console.log('');

const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const dir = path.join(process.env.LAB_DATA_DIR || path.join(root, 'data'), 'reports');
await mkdir(dir, { recursive: true });
const name = `fun-ab-${stamp}${live ? '' : '-mock'}`;
const file = path.join(dir, `${name}.html`);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const side = s => `<div class="conv">${s.lines.map(l => `<p class="${l.startsWith('你：') ? 'u' : l.startsWith('（') ? 'n' : 'c'}">${esc(l)}</p>`).join('')}</div>`;
const html = `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>整段对话盲评</title>
<style>
:root{--bg:#f6f4ef;--fg:#222;--card:#fff;--line:#ddd;--muted:#777;--pick:#2f7d6d}
@media (prefers-color-scheme:dark){:root{--bg:#1c1d1f;--fg:#e8e6e1;--card:#26282b;--line:#3a3d41;--muted:#9a9a9a;--pick:#5bb5a2}}
body{background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,sans-serif;margin:0 auto;padding:16px;max-width:1100px}
.q{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:14px 0}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:8px 0}
.conv{border:1px solid var(--line);border-radius:8px;padding:8px 10px}.conv p{margin:4px 0}
.u{color:var(--muted)}.n{color:var(--muted);font-size:13px}
.btns{display:flex;gap:8px;flex-wrap:wrap}
button{font:inherit;padding:4px 12px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
button[aria-pressed=true]{background:var(--pick);color:#fff;border-color:var(--pick)}
footer{position:sticky;bottom:0;background:var(--bg);padding:10px 0;border-top:1px solid var(--line)}
table{border-collapse:collapse;font-size:13px}td,th{border:1px solid var(--line);padding:2px 6px}
#stats{display:none}
@media (max-width:700px){.pair{grid-template-columns:1fr}}
</style>
<h1>哪一段你更想接着玩？</h1>
<p>每组是同一个模拟玩家、同样的开头，和岚各聊 ${turns} 轮。一边是 2.0，一边是 3.0${modelB ? `（3.0 那边换成了对话模型 ${esc(modelB)}）` : ''}，左右随机。全部选完才显示结果。${live ? '' : '<b>（mock 模型生成，只用来检查页面）</b>'}</p>
<div id="list">${items.map(it => `<div class="q" data-n="${it.n}"><b>第 ${it.n} 组</b>
<div class="pair">${side(it.left)}${side(it.right)}</div>
<div class="btns"><button data-v="left">左边更想接着玩</button><button data-v="same">差不多</button><button data-v="right">右边更想接着玩</button></div></div>`).join('')}</div>
<div id="stats"><h2>程序算的指标（选完才显示）</h2><table><tr><th>组</th><th>版本</th>${METRIC_HEADS.map(h => `<th>${h}</th>`).join('')}</tr>
${items.map(it => ['left', 'right'].map(sd => `<tr><td>${it.n}</td><td>${sd === it.newSide ? '3.0' : '2.0'}</td>${metricCells(it[sd].fun).map(c => `<td>${c}</td>`).join('')}</tr>`).join('')).join('')}</table></div>
<footer><span id="sum"></span> <button id="export">导出结果 JSON</button></footer>
<script>
const SIDES = ${JSON.stringify(Object.fromEntries(items.map(it => [it.n, it.newSide])))};
const KEY = '${name}';
let picks = {};
try { picks = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { picks = {}; }
const total = ${items.length};
function draw() {
  for (const q of document.querySelectorAll('.q')) for (const b of q.querySelectorAll('button')) b.setAttribute('aria-pressed', String(picks[q.dataset.n] === b.dataset.v));
  const done = Object.keys(picks).length;
  const wins = Object.entries(picks).filter(([n, v]) => v === SIDES[n]).length;
  const losses = Object.entries(picks).filter(([n, v]) => v !== 'same' && v !== SIDES[n]).length;
  document.getElementById('stats').style.display = done < total ? 'none' : 'block';
  document.getElementById('sum').textContent = done < total ? '已选 ' + done + ' / ' + total : '3.0 胜 ' + wins + ' / ' + total + '，2.0 胜 ' + losses + '，差不多 ' + (total - wins - losses) + (wins >= Math.ceil(total * 0.7) ? '（过关线 7/10：达到）' : '（过关线 7/10：没达到）');
}
document.getElementById('list').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  picks[b.closest('.q').dataset.n] = b.dataset.v;
  try { localStorage.setItem(KEY, JSON.stringify(picks)); } catch {}
  draw();
});
document.getElementById('export').addEventListener('click', () => {
  const rows = Object.keys(SIDES).map(n => ({ n: Number(n), pick: picks[n] || null, v3_side: SIDES[n], winner: !picks[n] ? null : picks[n] === 'same' ? 'same' : picks[n] === SIDES[n] ? '3.0' : '2.0' }));
  const blob = new Blob([JSON.stringify({ key: KEY, exported_at: new Date().toISOString(), v3_wins: rows.filter(r => r.winner === '3.0').length, rows }, null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: KEY + '-result.json' });
  a.click();
});
draw();
</script></html>`;
await writeFile(file, html);
const u = labA.db.prepare('SELECT count(*) calls, sum(cost_usd) cost FROM llm_calls').get();
console.log(`调用 ${u.calls} 次${u.cost != null ? `，花费 $${u.cost.toFixed(4)}` : '（未计价）'}`);
console.log(`页面：${file}`);
process.exit(0);
