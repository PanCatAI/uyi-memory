// Starts server.mjs on a free port against a throwaway data dir and an empty .env with the mock model,
// so tests never touch real data, real keys or paid APIs.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const lab = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const freePort = () => new Promise((resolve, reject) => { const s = createServer().once('error', reject).listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

export async function startSandbox({ extraEnv = {}, envText = '' } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'memory-lab-test-'));
  const dataDir = path.join(dir, 'data'), envFile = path.join(dir, '.env');
  await writeFile(envFile, envText, { mode: 0o600 });
  const port = await freePort();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.mjs'], { cwd: lab, env: { PATH: process.env.PATH, HOME: dir, PORT: String(port), LAB_DATA_DIR: dataDir, LAB_ENV_FILE: envFile, LLM_PROVIDER: 'mock', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${log}`)), 15000);
    const onData = c => { log += c; if (log.includes(`127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData); child.stderr.on('data', c => { log += c; });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${log}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, headers: r.headers, body: r.headers.get('content-type')?.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
  return {
    base, dataDir, dir,
    get: p => call('GET', p),
    post: (p, body = {}) => call('POST', p, body),
    put: (p, body = {}) => call('PUT', p, body),
    del: p => call('DELETE', p),
    async stop() { child.removeAllListeners('exit'); child.kill(); await new Promise(r => child.once('close', r)); await rm(dir, { recursive: true, force: true }); }
  };
}
