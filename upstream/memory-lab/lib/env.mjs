import { readFile, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';

// Server-side settings and the API key live only in .env (mode 600). The key never reaches the browser,
// the database or the logs.
const KEY_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
export function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}
export async function loadEnv(file) {
  return existsSync(file) ? parseEnv(await readFile(file, 'utf8')) : {};
}
export async function saveEnv(file, env) {
  const lines = ['# 记忆实验台的服务端设置。不要提交这个文件。'];
  for (const [k, v] of Object.entries(env)) {
    if (!KEY_RE.test(k) || /[\r\n]/.test(String(v))) continue;
    lines.push(`${k}=${v}`);
  }
  await writeFile(file, lines.join('\n') + '\n', { mode: 0o600 });
  await chmod(file, 0o600);
}
export const mask = v => (v ? `••••${String(v).slice(-4)}` : '');
