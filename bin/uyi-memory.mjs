#!/usr/bin/env node
// 启动本机记忆服务。
//   uyi-memory serve [--port 4350] [--data <目录>] [--env <.env 文件>]
// 环境变量：UYI_MEMORY_PORT、UYI_MEMORY_DATA、UYI_MEMORY_ENV、UYI_MEMORY_TOKEN（可选，设了就要 Bearer token）。
// 桌面端把它当子进程拉起来时，读 stdout 第一行的 JSON 拿到真实端口：{"ready":true,"port":4350}
import path from 'node:path';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { loadEnv } from '../lib/env.mjs';
import { createMemory } from '../index.mjs';
import { createHttpServer } from '../server/http.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { port: { type: 'string' }, data: { type: 'string' }, env: { type: 'string' }, help: { type: 'boolean', short: 'h' } }
});
if (values.help || (positionals[0] && positionals[0] !== 'serve')) {
  console.log('用法：uyi-memory serve [--port 4350] [--data <目录>] [--env <.env 文件>]\n--port 0 让系统挑空闲端口。');
  process.exit(values.help ? 0 : 1);
}

const dataDir = path.resolve(values.data || process.env.UYI_MEMORY_DATA || path.join(os.homedir(), '.uyi-memory'));
const envFile = path.resolve(values.env || process.env.UYI_MEMORY_ENV || path.join(dataDir, '.env'));
const port = Number(values.port ?? process.env.UYI_MEMORY_PORT ?? 4350);

let env = await loadEnv(envFile);
// LLM_PROVIDER 在进程环境里设了就以它为准（测试、沙箱）
const getEnv = () => (process.env.LLM_PROVIDER ? { ...env, LLM_PROVIDER: process.env.LLM_PROVIDER } : env);
const mem = await createMemory({ dataDir, getEnv });
const server = createHttpServer(mem);
server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ ready: true, port: server.address().port, api: mem.apiVersion, version: mem.version }));
  if (!process.env.LAB_QUIET) console.error(`UYI 记忆服务：http://127.0.0.1:${server.address().port}  数据：${dataDir}`);
});
// 改了 .env 不用重启：收到 SIGHUP 重新读
process.on('SIGHUP', async () => { env = await loadEnv(envFile); });
const stop = async () => { server.close(); await mem.close().catch(() => {}); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
