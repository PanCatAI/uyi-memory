// 2.0 D2 check: a camp session at 18:00, the user says one line and then nothing for 5 minutes (7 ticks of 45 s,
// simulated real time, no waiting). Prints every idle moment: what she thought, how much she wanted to speak, what she
// said. node scripts/idle-try.mjs [--live]   (--live needs LAB_ALLOW_PAID=1 and .env, like eval:live)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLab } from '../lib/lab.mjs';
import { loadEnv } from '../lib/env.mjs';
import { realNow, formatWorldTime } from '../lib/clock.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const live = process.argv.includes('--live');
if (live && process.env.LAB_ALLOW_PAID !== '1') { console.error('--live 会调用真模型并产生费用，需要 LAB_ALLOW_PAID=1'); process.exit(2); }
process.env.LAB_QUIET = '1';
const env = live ? await loadEnv(process.env.LAB_ENV_FILE || path.join(root, '.env')) : { LLM_PROVIDER: 'mock' };
const lab = createLab({ getEnv: () => env });
const saveId = lab.saves.createSave({ name: 'idle-try', sceneId: 'camp' }).id;
lab.session.advance(saveId, '18:00');
await lab.session.start(saveId);
await lab.turns.runTurn({ saveId, charId: 'lan', text: '我回来了，今天走了好远。' });
const t0 = realNow();
let spoke = 0;
for (let i = 1; i <= 7; i++) {
  const r = await lab.session.tick(saveId, { now: t0 + i * 45_000 });
  for (const x of r.idle) {
    if (x.spoke) { spoke++; lab.proactive.recordDelivered(x.turnId); }
    console.log(`${formatWorldTime(lab.clock.now(saveId))}  想：${x.thought}  劲 ${x.urge}  ${x.spoke ? `说：${x.say}` : `没说（${x.why}）`}`);
  }
  if (!r.idle.length) console.log(`${formatWorldTime(lab.clock.now(saveId))}  （这次没轮到空闲想法：${r.skipped || '用户刚说过话不到 1 分钟'}）`);
  for (const e of r.events.filter(e => e.payload?.routine)) console.log(`    作息：${e.action} ${e.target || ''}`);
}
const u = lab.db.prepare("SELECT count(*) n, sum(input_tokens) i, sum(output_tokens) o FROM llm_calls WHERE purpose = 'idle'").get();
console.log(`5 分钟里开口 ${spoke} 次；idle 调用 ${u.n} 次，输入 ${u.i} token，输出 ${u.o} token`);
