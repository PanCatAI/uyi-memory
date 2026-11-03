// npm run draft-sample:live → B6 real-model sample: drafts 岚 from her looks + one line, saves
// data/reports/card-draft-sample.md (never replaces characters/lan.md). Mock without --live.
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createLab } from '../lib/lab.mjs';
import { loadEnv } from '../lib/env.mjs';
import { draftCard } from '../lib/cards.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const live = process.argv.includes('--live');
if (live && process.env.LAB_ALLOW_PAID !== '1') { console.error('会调用真模型并产生费用，需要 LAB_ALLOW_PAID=1'); process.exit(2); }
process.env.LAB_QUIET = '1';
const env = live ? await loadEnv(process.env.LAB_ENV_FILE || path.join(root, '.env')) : { LLM_PROVIDER: 'mock' };
if (live && !env.LLM_API_KEY) { console.error('.env 里没有 LLM_API_KEY'); process.exit(2); }
const lab = createLab({ getEnv: () => env });
const saveId = lab.saves.createSave({ name: 'draft', sceneId: 'camp' }).id;
const looks = lab.scene(saveId).characters.find(c => c.id === 'lan').card.looks;
const d = await draftCard(lab, { saveId, looks, persona: '急性子的女绘图员，师父失踪了' });
const dir = path.join(process.env.LAB_DATA_DIR || path.join(root, 'data'), 'reports');
await mkdir(dir, { recursive: true });
const file = path.join(dir, `card-draft-sample${live ? '' : '-mock'}.md`);
await writeFile(file, `<!-- B6 起草样例：${d.ok ? `解析通过（第 ${d.attempts} 次）` : `解析失败：${d.error}`}；外貌 = 岚卡「外貌」，人设 = 急性子的女绘图员，师父失踪了 -->\n\n${d.text}\n`);
const c = lab.db.prepare("SELECT count(*) n, sum(cost_usd) usd FROM llm_calls WHERE purpose = 'card_draft'").get();
console.log(`${d.ok ? '解析通过' : `解析失败：${d.error}`}，调用 ${c.n} 次${c.usd != null ? `，$${c.usd.toFixed(4)}` : ''}\n样例：${file}`);
