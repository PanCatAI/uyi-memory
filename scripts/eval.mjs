// npm run eval       → every scenario with the mock model in a throwaway database; exit 1 on any failure.
// npm run eval:live  → the same with the real model from .env (costs money; LAB_ALLOW_PAID=1 required).
// --features=voice,world,topics → 3.0 G6: run the listed scenarios with these 3.0 features on (instead of the file's).
// --arms s1-sword    → 2.0 D7: each listed scenario in three arms, kept in the app's database (data/lab.sqlite or
//                      LAB_DATA_DIR) so the side-by-side page (/arms.html) shows them; writes arms-*.md too.
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createLab } from '../lib/lab.mjs';
import { createScenarios } from '../lib/scenarios.mjs';
import { loadEnv } from '../lib/env.mjs';
import { formatWorldTime } from '../lib/clock.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const live = process.argv.includes('--live');
const only = process.argv.slice(2).filter(a => !a.startsWith('--'));
const featArg = process.argv.find(a => a.startsWith('--features='))?.split('=')[1];
const features = featArg ? Object.fromEntries(featArg.split(',').filter(Boolean).map(k => [k, true])) : null;
if (live && process.env.LAB_ALLOW_PAID !== '1') { console.error('eval:live 会调用真模型并产生费用，需要 LAB_ALLOW_PAID=1'); process.exit(2); }
process.env.LAB_QUIET = '1';

const env = live ? await loadEnv(process.env.LAB_ENV_FILE || path.join(root, '.env')) : { LLM_PROVIDER: 'mock' };
if (live && !env.LLM_API_KEY) { console.error('.env 里没有 LLM_API_KEY'); process.exit(2); }
const armsMode = process.argv.includes('--arms');
const dataDir = process.env.LAB_DATA_DIR || path.join(root, 'data');
if (armsMode) await mkdir(dataDir, { recursive: true });
const lab = createLab({ getEnv: () => env, ...(armsMode ? { file: path.join(dataDir, 'lab.sqlite') } : {}) });
const runner = createScenarios(lab);
const list = runner.list().filter(s => !only.length || only.includes(s.id));
const rows = [];
let failed = 0;
if (armsMode) {
  const md = ['# 三路平行跑', '', `模型：${live ? lab.llm.settings().model : 'mock'}`, ''];
  for (const s of list) {
    const g = await runner.startArms(s.id, { provider: live ? 'live' : 'mock' });
    const cost = g.arms.reduce((n, a) => n + (a.cost || 0), 0);
    console.log(`${s.id}：${g.arms.map(a => `${a.title} ${a.state} ${a.summary.auto_pass}/${a.summary.auto_fail}`).join(' · ')} · 花费 $${cost.toFixed(4)} · /arms.html?group=${g.group}`);
    md.push(`## ${g.title}（组 ${g.group}，花费 $${cost.toFixed(4)}）`, '', g.arms.map(a => `- ${a.title}：${a.state}，断言 ${a.summary.auto_pass} 过 / ${a.summary.auto_fail} 失败，$${(a.cost || 0).toFixed(4)}`).join('\n'), '');
    for (const r of g.steps) {
      if (r.kind === 'review') { md.push(`**第 ${r.step + 1} 步 待判读：${r.question}**`, ''); continue; }
      md.push(`**第 ${r.step + 1} 步 你：${r.input}**`, '', ...g.arms.map(a => `- ${a.title}：${r.arms[a.arm]?.reply ?? '（没跑到）'}`), '');
    }
  }
  const dir = path.join(dataDir, 'reports');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `arms-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.md`);
  await writeFile(file, md.join('\n'));
  console.log(`报告：${file}`);
  process.exit(0);
}
for (const s of list) {
  const v = await runner.runAll(runner.create(s.id, { provider: live ? 'live' : 'mock', features }).id);
  const pass = v.results.filter(r => r.ok === true && r.kind === 'expect').length;
  const fail = v.results.filter(r => r.ok === false);
  const later = v.results.filter(r => r.skip && /^待 /.test(r.detail)).length; // waits for a later task (e.g. D5)
  const skip = v.results.filter(r => r.skip).length - later;
  const review = v.results.filter(r => r.review).length;
  if (v.state !== 'passed') failed++;
  rows.push({ id: s.id, title: s.title, run: v.id, state: v.state, pass, fail: fail.length, skip, review, failures: fail.map(f => `第 ${f.step + 1} 步 ${f.kind}：${f.detail}`), steps: v.results });
  console.log(`${v.state === 'passed' ? '✓' : '✗'} ${s.id.padEnd(14)} 断言通过 ${pass}  失败 ${fail.length}  ${live ? '跳过' : '仅真模型'} ${skip}${review ? `  待人工判读 ${review}` : ''}${later ? `  待后续任务 ${later}` : ''}`);
  for (const f of fail) console.log(`    第 ${f.step + 1} 步 ${f.kind}：${f.detail}`);
}
if (live) {
  const u = lab.db.prepare("SELECT count(DISTINCT coalesce(logical_id, id)) logical, count(*) calls, sum(input_tokens) i, sum(cached_tokens) c, sum(CASE WHEN cache_reported = 1 THEN input_tokens ELSE 0 END) ci, sum(cache_reported = 1) cr, sum(output_tokens) o, sum(cost_usd) cost, sum(cost_usd IS NULL) unpriced, sum(stage != 'ok') bad FROM llm_calls").get();
  const stages = lab.db.prepare('SELECT purpose, stage, count(*) n, round(avg(latency_ms)) ms FROM llm_calls GROUP BY purpose, stage ORDER BY purpose, stage').all();
  const line = `逻辑调用 ${u.logical} 次，实际尝试 ${u.calls} 次（失败 ${u.bad}），输入 ${u.i} token（缓存命中 ${u.cr ? `${u.c}，命中率 ${Math.round((u.c / (u.ci || 1)) * 100)}%` : '服务商没报'}），输出 ${u.o} token，花费 ${u.unpriced === u.calls ? '未计价（没配价格）' : `$${(u.cost || 0).toFixed(4)}${u.unpriced ? `，另 ${u.unpriced} 次未计价` : ''}`}`;
  console.log(line);
  const dir = path.join(process.env.LAB_DATA_DIR || path.join(root, 'data'), 'reports');
  await mkdir(dir, { recursive: true });
  const name = `eval-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.md`;
  const md = [`# 真模型评测 ${formatWorldTime(Date.parse(new Date().toISOString()))}`, '', `模型：${lab.llm.settings().model}`, '', '跳过和待人工判读都不算通过；「通过」只指自动断言。', '',
    '| 剧本 | 结果 | 自动断言通过 | 失败 | 跳过 | 待人工判读 |', '|---|---|---|---|---|---|', ...rows.map(r => `| ${r.id} | ${r.state} | ${r.pass} | ${r.fail} | ${r.skip} | ${r.review} |`), '', line, '',
    '## 失败的断言', '', ...(rows.some(r => r.failures.length) ? rows.flatMap(r => r.failures.map(f => `- ${r.id}：${f}`)) : ['（无）']), '',
    '## 每一步', '', ...rows.flatMap(r => [`### ${r.title}（${r.id}，运行 ${r.run}）`, '', ...r.steps.map(x => `- ${x.review ? '【待判读】' : x.skip ? '【跳过】' : x.ok === false ? '【失败】' : '【✓】'} 第 ${x.step + 1} 步 ${x.kind}：${x.input ? `你「${x.input}」→ ` : ''}${x.reply != null ? `角色「${x.reply}」` : x.detail}${x.action ? `（🎬 ${x.action.name} ${x.action.target || ''}${x.action.result?.ok === false ? ` 没做成：${x.action.result.reason}` : ''}）` : ''}${x.review || x.kind === 'expect' ? `｜${x.detail}` : ''}`), '']),
    '## 每种调用的尝试', '', '| 用途 | 阶段 | 次数 | 平均延迟 ms |', '|---|---|---|---|', ...stages.map(x => `| ${x.purpose} | ${x.stage} | ${x.n} | ${x.ms} |`), ''].join('\n');
  await writeFile(path.join(dir, name), md);
  console.log(`报告：${path.join(dir, name)}`);
}
process.exit(failed ? 1 : 0);
