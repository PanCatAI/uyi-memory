// 本机 HTTP 服务：给不是 Node 写的桌面端（Unity、Tauri、原生）用。每个接口一对一对应 index.mjs 的一个方法。
// 只监听 127.0.0.1。设了 UYI_MEMORY_TOKEN 时，每个请求都要带 Authorization: Bearer <token>。
// 接口说明见 docs/INTEGRATION.md。
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { MemoryError, API_VERSION } from '../index.mjs';

const MAX_BODY = 1024 * 1024;

async function body(req) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > MAX_BODY) throw new MemoryError('TOO_LARGE', '请求太大', 413); chunks.push(c); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new MemoryError('BAD_JSON', '请求不是合法 JSON'); }
}

/** [method, pattern, handler(params, body, query)] */
function routes(mem) {
  const q = (query, k) => query.get(k);
  return [
    ['GET', '/v1/health', () => ({ ok: true, api: API_VERSION, version: mem.version, provider: mem.lab.llm.settings().provider })],
    ['POST', '/v1/llm/test', () => mem.testConnection()],

    ['GET', '/v1/spaces', () => mem.listSpaces()],
    ['POST', '/v1/spaces', (_, b) => mem.createSpace(b)],
    ['GET', '/v1/spaces/:space', p => mem.getSpace(p.space)],
    ['DELETE', '/v1/spaces/:space', p => mem.deleteSpace(p.space)],
    ['PUT', '/v1/spaces/:space/scene', (p, b) => mem.updateScene(p.space, b.scene ?? b)],
    ['PUT', '/v1/spaces/:space/features', (p, b) => mem.setFeatures(p.space, b)],

    ['POST', '/v1/spaces/:space/clock', (p, b) => mem.syncClock(p.space, Number(b.now))],
    ['POST', '/v1/spaces/:space/session/open', (p, b) => mem.openSession(p.space, { now: b.now })],
    ['POST', '/v1/spaces/:space/session/close', p => mem.closeSession(p.space)],
    ['POST', '/v1/spaces/:space/tick', (p, b) => mem.tick(p.space, { now: b.now })],

    ['POST', '/v1/spaces/:space/chat', (p, b) => mem.chat(p.space, String(b.character || ''), b.text)],
    ['POST', '/v1/turns/:turn/delivered', p => mem.delivered(p.turn)],
    ['GET', '/v1/turns/:turn', p => mem.turn(p.turn)],

    ['POST', '/v1/spaces/:space/user-action', (p, b) => mem.userAction(p.space, b)],
    ['POST', '/v1/spaces/:space/events', (p, b) => mem.recordEvent(p.space, b)],
    ['GET', '/v1/spaces/:space/events', (p, _, query) => mem.events(p.space, { after: q(query, 'after'), limit: q(query, 'limit'), types: q(query, 'types')?.split(',') })],
    ['GET', '/v1/spaces/:space/world', p => mem.world(p.space)],

    ['GET', '/v1/spaces/:space/characters/:char/memory', p => mem.memory(p.space, p.char)],
    ['POST', '/v1/spaces/:space/characters/:char/forget', (p, b) => mem.proposeForget(p.space, p.char, b)],
    ['POST', '/v1/forget/:job/confirm', p => mem.confirmForget(p.job)],
    ['POST', '/v1/forget/:job/cancel', p => mem.cancelForget(p.job)],

    ['GET', '/v1/usage', (_, __, query) => mem.usage(q(query, 'space'))],
    ['GET', '/v1/spaces/:space/job-errors', p => mem.jobErrors(p.space)]
  ].map(([m, pattern, fn]) => {
    const names = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; })}$`);
    return { m, re, names, fn };
  });
}

const tokenOk = (req, token) => {
  if (!token) return true;
  const got = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
};

/** mem: createMemory() 的结果。返回 node:http Server（还没 listen）。 */
export function createHttpServer(mem, { token = process.env.UYI_MEMORY_TOKEN || '' } = {}) {
  const table = routes(mem);
  const send = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (!tokenOk(req, token)) throw new MemoryError('UNAUTHORIZED', '缺少或错误的 token', 401);
      for (const r of table) {
        if (r.m !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
        const b = req.method === 'GET' || req.method === 'DELETE' ? {} : await body(req);
        return send(res, 200, await r.fn(params, b, url.searchParams));
      }
      throw new MemoryError('NOT_FOUND', '没有这个接口', 404);
    } catch (e) {
      const status = e instanceof MemoryError ? e.status : 400;
      send(res, status, { error: { code: e.code || 'BAD_REQUEST', message: e.message } });
    }
  });
}
