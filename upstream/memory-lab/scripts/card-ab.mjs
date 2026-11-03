// npm run card-ab        → B8 blind comparison of 岚's thin (1.0-style) card vs her full 2.0 card, mock model.
// npm run card-ab:live   → the same with the real model from .env (30 × 2 replies; LAB_ALLOW_PAID=1 required).
// Each input gets two fresh saves in the same world state (camp, 18:00, session open); the page shows the user's
// line and both replies in random left/right order, keeps the picks in the browser and exports them as JSON.
import path from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createLab } from '../lib/lab.mjs';
import { loadEnv } from '../lib/env.mjs';
import { thinCard, parseCardV2 } from '../lib/card.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const live = process.argv.includes('--live');
const limit = Number((process.argv.find(a => a.startsWith('--limit=')) || '').split('=')[1]) || Infinity;
if (live && process.env.LAB_ALLOW_PAID !== '1') { console.error('card-ab:live 会调用真模型并产生费用，需要 LAB_ALLOW_PAID=1'); process.exit(2); }
process.env.LAB_QUIET = '1';
const env = live ? await loadEnv(process.env.LAB_ENV_FILE || path.join(root, '.env')) : { LLM_PROVIDER: 'mock' };
if (live && !env.LLM_API_KEY) { console.error('.env 里没有 LLM_API_KEY'); process.exit(2); }

const lab = createLab({ getEnv: () => env });
const { inputs } = JSON.parse(await readFile(path.join(root, 'test/fixtures/card-ab-inputs.json'), 'utf8'));
const full = lab.scene(lab.saves.createSave({ name: 'probe', sceneId: 'camp' }).id).characters.find(c => c.id === 'lan');
const thin = thinCard(parseCardV2(full.cardText));

async function answer(text, card) {
  const saveId = lab.saves.createSave({ name: `card-ab ${card}`, sceneId: 'camp' }).id;
  if (card === 'thin') lab.cards.save(saveId, 'lan', thin, 'B8 旧卡（设定 + 说话方式 + 禁止）');
  lab.session.advance(saveId, '18:00');
  await lab.session.start(saveId);
  const r = await lab.turns.runTurn({ saveId, charId: 'lan', text });
  return r.reply.delivered ?? r.reply.say;
}

// Seeded shuffle of sides, so the same run always renders the same page.
let seed = 20261020;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const items = [];
for (const [i, inp] of inputs.slice(0, limit).entries()) {
  const [a, b] = [await answer(inp.text, 'full'), await answer(inp.text, 'thin')];
  const newLeft = rand() < 0.5;
  items.push({ n: i + 1, kind: inp.kind, text: inp.text, left: newLeft ? a : b, right: newLeft ? b : a, newSide: newLeft ? 'left' : 'right' });
  process.stdout.write(`\r${i + 1}/${Math.min(inputs.length, limit)}`);
}
console.log('');

const day = new Date().toISOString().slice(0, 10);
const dir = path.join(process.env.LAB_DATA_DIR || path.join(root, 'data'), 'reports');
await mkdir(dir, { recursive: true });
const file = path.join(dir, `card-ab-${day}${live ? '' : '-mock'}.html`);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const u = lab.db.prepare("SELECT count(*) calls, sum(input_tokens) i, sum(output_tokens) o, sum(cost_usd) cost FROM llm_calls WHERE purpose = 'reply'").get();
const html = `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>岚 新旧卡盲评</title>
<style>
:root{--bg:#f6f4ef;--fg:#222;--card:#fff;--line:#ddd;--muted:#777;--pick:#2f7d6d}
@media (prefers-color-scheme:dark){:root{--bg:#1c1d1f;--fg:#e8e6e1;--card:#26282b;--line:#3a3d41;--muted:#9a9a9a;--pick:#5bb5a2}}
body{background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,sans-serif;margin:0;padding:16px;max-width:900px;margin:auto}
.q{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:12px 0}
.user{font-weight:600}.kind{color:var(--muted);font-size:12px;margin-left:6px}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:8px 0}
.reply{border:1px solid var(--line);border-radius:8px;padding:8px 10px;white-space:pre-wrap}
.btns{display:flex;gap:8px;flex-wrap:wrap}
button{font:inherit;padding:4px 12px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
button[aria-pressed=true]{background:var(--pick);color:#fff;border-color:var(--pick)}
footer{position:sticky;bottom:0;background:var(--bg);padding:10px 0;border-top:1px solid var(--line)}
@media (max-width:600px){.pair{grid-template-columns:1fr}}
</style>
<h1>岚：哪边更像一个真人？</h1>
<p>每题是同一句话，左右两条回复分别来自两张不同的角色卡（左右随机）。凭感觉选「更像人」的那边。全部选完才显示结果。${live ? '' : '<b>（mock 模型生成，只用来检查页面）</b>'}</p>
<div id="list">${items.map(it => `<div class="q" data-n="${it.n}"><div class="user">${it.n}. 你：${esc(it.text)}<span class="kind">${esc(it.kind)}</span></div>
<div class="pair"><div class="reply">${esc(it.left)}</div><div class="reply">${esc(it.right)}</div></div>
<div class="btns"><button data-v="left">左更像人</button><button data-v="same">差不多</button><button data-v="right">右更像人</button></div></div>`).join('')}</div>
<footer><span id="sum"></span> <button id="export">导出结果 JSON</button></footer>
<script>
const SIDES = ${JSON.stringify(Object.fromEntries(items.map(it => [it.n, it.newSide])))};
const KEY = 'card-ab-${day}${live ? '' : '-mock'}';
let picks = {};
try { picks = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { picks = {}; }
const total = ${items.length};
function draw() {
  for (const q of document.querySelectorAll('.q')) for (const b of q.querySelectorAll('button')) b.setAttribute('aria-pressed', String(picks[q.dataset.n] === b.dataset.v));
  const done = Object.keys(picks).length;
  const wins = Object.entries(picks).filter(([n, v]) => v === SIDES[n]).length;
  const losses = Object.entries(picks).filter(([n, v]) => v !== 'same' && v !== SIDES[n]).length;
  document.getElementById('sum').textContent = done < total ? '已选 ' + done + ' / ' + total : '新卡胜 ' + wins + ' / ' + total + '，旧卡胜 ' + losses + '，差不多 ' + (total - wins - losses) + (wins >= 18 ? '（过关线 18：达到）' : '（过关线 18：没达到）');
}
document.getElementById('list').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  picks[b.closest('.q').dataset.n] = b.dataset.v;
  try { localStorage.setItem(KEY, JSON.stringify(picks)); } catch {}
  draw();
});
document.getElementById('export').addEventListener('click', () => {
  const rows = Object.keys(SIDES).map(n => ({ n: Number(n), pick: picks[n] || null, new_side: SIDES[n], winner: !picks[n] ? null : picks[n] === 'same' ? 'same' : picks[n] === SIDES[n] ? 'new' : 'old' }));
  const blob = new Blob([JSON.stringify({ key: KEY, exported_at: new Date().toISOString(), new_wins: rows.filter(r => r.winner === 'new').length, rows }, null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: KEY + '-result.json' });
  a.click();
});
draw();
</script></html>`;
await writeFile(file, html);
console.log(`回复调用 ${u.calls} 次，输入 ${u.i} token，输出 ${u.o} token${u.cost != null ? `，花费 $${u.cost.toFixed(4)}` : ''}`);
console.log(`页面：${file}`);
process.exit(0);
