// 2.0 D8: a simulated user plays several days. npm run simulate -- --persona=爱改口 --days=5 [--seed=1] [--live]
// 3.0 E5: --features=all (default) | none plays with or without the 3.0 features; the fun judge runs when a judge
// model is set (always with the mock).
// Writes data/reports/sim-<persona>-<date>.md (LAB_DATA_DIR/reports). --live needs LAB_ALLOW_PAID=1 and .env;
// it stops when the save's cost reaches LAB_SIM_MAX_USD (default 2).
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createLab } from '../lib/lab.mjs';
import { loadEnv } from '../lib/env.mjs';
import { simulate } from '../lib/simulate.mjs';
import { ALL_ON } from '../lib/features.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
const live = process.argv.includes('--live');
if (live && process.env.LAB_ALLOW_PAID !== '1') { console.error('--live 会调用真模型并产生费用，需要 LAB_ALLOW_PAID=1'); process.exit(2); }
process.env.LAB_QUIET = '1';
const env = live ? await loadEnv(process.env.LAB_ENV_FILE || path.join(root, '.env')) : { LLM_PROVIDER: 'mock' };
if (live && !env.LLM_API_KEY) { console.error('.env 里没有 LLM_API_KEY'); process.exit(2); }
const lab = createLab({ getEnv: () => env });
const persona = arg('persona') || '爱改口';
const features = arg('features') === 'none' ? null : ALL_ON;
const judge = !live || Boolean(env.LLM_MODEL_JUDGE);
const r = await simulate(lab, {
  persona, days: Number(arg('days') || 2), seed: Number(arg('seed') || 1),
  maxUsd: Number(process.env.LAB_SIM_MAX_USD || 2), features, judge, log: m => process.stderr.write(`\r${m}   `)
});
process.stderr.write('\n');
const dir = path.join(process.env.LAB_DATA_DIR || path.join(root, 'data'), 'reports');
await mkdir(dir, { recursive: true });
const file = path.join(dir, `sim-${persona}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.md`);
await writeFile(file, r.markdown);
const t = r.totals;
console.log(`${persona} ${r.days.length} 天：${t.turns} 轮，她主动开口 ${t.proactive} 次，G 失败 ${t.g}，旧值复现 ${t.recurrences}，口头禅率 ${Math.round(t.fun.ticRate * 100)}%，反复问题 ${t.fun.nagging.length}，给东西 ${Math.round(t.fun.giveRate * 100)}%${t.judgeAvg == null ? '' : `，裁判 ${t.judgeAvg.toFixed(1)}`}，花费 ${t.cost == null ? '未计价' : `$${t.cost.toFixed(4)}`}${r.stopped ? `（${r.stopped}）` : ''}`);
console.log(`报告：${file}`);
process.exit(t.g || t.recurrences ? 1 : 0);
