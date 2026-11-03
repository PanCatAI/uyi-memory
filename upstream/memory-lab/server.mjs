import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadStream } from 'node:fs';
import { stat, mkdir, readFile, readdir, writeFile, rm, rename } from 'node:fs/promises';
import { createLab } from './lib/lab.mjs';
import { createScenarios } from './lib/scenarios.mjs';
import { loadEnv, saveEnv, mask } from './lib/env.mjs';
import { llmSettings } from './lib/llm.mjs';
import { formatWorldTime } from './lib/clock.mjs';
import { listScenes } from './lib/scene.mjs';
import { pj } from './lib/db.mjs';
import { ALL_ON, FEATURE_TITLES, PACES } from './lib/features.mjs';
import { eventText } from './lib/memory/common.mjs';
import { addDays } from './lib/climate.mjs';
import { CardError, draftCard } from './lib/cards.mjs';
import { StudioError, studioBase, fetchState, catalog, importStudio } from './lib/studio-import.mjs';

const baseDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(baseDir, 'public');
const dataDir = process.env.LAB_DATA_DIR || path.join(baseDir, 'data');
const envFile = process.env.LAB_ENV_FILE || path.join(baseDir, '.env');
const PORT = Number(process.env.PORT) || 4340;
const { version } = JSON.parse(await readFile(path.join(baseDir, 'package.json'), 'utf8'));

export class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm' };

function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
function safeJoin(root, rel) { const p = path.resolve(root, rel); if (!p.startsWith(root + path.sep)) throw new HttpError(404, 'NOT_FOUND', '未找到。'); return p; }
async function serveFile(req, res, file) {
  let info; try { info = await stat(file); } catch { throw new HttpError(404, 'NOT_FOUND', '未找到。'); }
  if (!info.isFile()) throw new HttpError(404, 'NOT_FOUND', '未找到。');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': info.size, 'Cache-Control': 'no-cache' });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

await mkdir(dataDir, { recursive: true });
let env = await loadEnv(envFile);
// A provider set in the process environment (tests, sandboxes) wins over the file.
const getEnv = () => (process.env.LLM_PROVIDER ? { ...env, LLM_PROVIDER: process.env.LLM_PROVIDER } : env);
const savesDir = path.join(dataDir, 'saves');
const lab = createLab({ file: path.join(dataDir, 'lab.sqlite'), getEnv, savesDir });
const scenarios = createScenarios(lab);
const { db } = lab;

async function jsonBody(req) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > 1024 * 1024) throw new HttpError(413, 'TOO_LARGE', '请求太大。'); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new HttpError(400, 'BAD_JSON', '请求格式无效。'); }
}
function needSave(id) {
  const save = id && lab.saves.getSave(id);
  if (!save) throw new HttpError(404, 'NO_SAVE', '没有这个存档。');
  return save;
}
function cardCall(fn) {
  try { return fn(); } catch (e) { if (e instanceof CardError) throw new HttpError(400, 'BAD_CARD', e.message); throw e; }
}
function studioCall(fn) {
  return fn().catch(e => { if (e instanceof StudioError) throw new HttpError(400, 'STUDIO', e.message); throw e; });
}
// 造物台 address: LAB_STUDIO_URL (tests) or 127.0.0.1:<STUDIO_PORT from settings, default 4320>.
const studioUrl = () => process.env.LAB_STUDIO_URL || studioBase(env);
function needChar(saveId, id) {
  if (!lab.scene(saveId).characters.some(c => c.id === id)) throw new HttpError(400, 'NO_CHARACTER', '没有这个角色。');
  return id;
}
// GLBs imported from 造物台: display only, stored beside the database, never in the ledger.
const assetsDir = path.join(dataDir, 'assets');
const ASSET_ID = /^[a-z0-9_-]{1,64}$/i;
const MAX_GLB = 50 * 1024 * 1024;
async function listAssets(saveId) {
  const names = await readdir(path.join(assetsDir, saveId)).catch(() => []);
  return names.filter(n => n.endsWith('.glb')).map(n => ({ id: n.slice(0, -4), url: `/api/assets/${saveId}/${n}` }));
}
/** Throws a readable 400 unless buf is a complete binary glTF 2.0 with a parseable JSON chunk. */
export function checkGlb(buf) {
  const bad = msg => new HttpError(400, 'NOT_GLB', msg);
  if (buf.length < 20 || buf.toString('latin1', 0, 4) !== 'glTF') throw bad('这不是 .glb 文件（造物台导出的二进制 glTF）。');
  if (buf.readUInt32LE(4) !== 2) throw bad(`只支持 glTF 2.0，这个文件是版本 ${buf.readUInt32LE(4)}。`);
  const declared = buf.readUInt32LE(8);
  if (declared !== buf.length) throw bad(`文件不完整或已损坏：文件头写着 ${declared} 字节，实际 ${buf.length} 字节。`);
  const jsonLen = buf.readUInt32LE(12);
  if (buf.readUInt32LE(16) !== 0x4e4f534a || 20 + jsonLen > buf.length) throw bad('文件已损坏：找不到 glTF 的 JSON 部分。');
  let gltf;
  try { gltf = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen)); } catch { throw bad('文件已损坏：glTF 的 JSON 部分读不出来。'); }
  if (!gltf?.asset?.version || !Array.isArray(gltf.meshes) || !gltf.meshes.length) throw bad('这个 glTF 里没有模型网格。');
  // The binary chunk must hold what the JSON says it holds (a cut or patched file usually fails here).
  const binAt = 20 + jsonLen;
  const binLen = binAt + 8 <= buf.length && buf.readUInt32LE(binAt + 4) === 0x004e4942 ? buf.readUInt32LE(binAt) : 0;
  const views = gltf.bufferViews || [], accessors = gltf.accessors || [];
  if ((gltf.buffers || []).some((b, i) => i === 0 && !b.uri && b.byteLength > binLen)) throw bad('文件已损坏：二进制数据比文件里写的短。');
  if (views.some(v => (v.byteOffset || 0) + v.byteLength > (gltf.buffers?.[v.buffer]?.byteLength ?? 0))) throw bad('文件已损坏：数据段超出了缓冲区。');
  if (accessors.some(a => a.bufferView != null && !views[a.bufferView])) throw bad('文件已损坏：引用了不存在的数据段。');
  if (accessors.some(a => ![5120, 5121, 5122, 5123, 5125, 5126].includes(a.componentType) || !['SCALAR', 'VEC2', 'VEC3', 'VEC4', 'MAT2', 'MAT3', 'MAT4'].includes(a.type))) throw bad('文件已损坏：顶点数据的格式不对。');
  const prims = gltf.meshes.flatMap(m => m.primitives || []);
  if (prims.some(p => Object.values(p.attributes || {}).some(i => !accessors[i]))) throw bad('文件已损坏：网格引用了不存在的顶点数据。');
}
async function putAsset(req, saveId, id) {
  needSave(saveId);
  const scene = lab.scene(saveId);
  const known = scene.characters.some(c => c.id === id) || scene.objects.some(o => o.id === id) || scene.palette.some(p => p.id === id) || lab.ledger.world(saveId).objects[id];
  if (!ASSET_ID.test(id) || !known) throw new HttpError(400, 'BAD_TARGET', '场景里没有这个角色或物件。');
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > MAX_GLB) throw new HttpError(413, 'TOO_LARGE', 'GLB 不能超过 50MB。'); chunks.push(c); }
  const buf = Buffer.concat(chunks);
  checkGlb(buf);
  // Write beside the old file and rename: a failed upload never replaces a working model.
  await mkdir(path.join(assetsDir, saveId), { recursive: true });
  const file = path.join(assetsDir, saveId, `${id}.glb`);
  await writeFile(`${file}.uploading`, buf);
  await rename(`${file}.uploading`, file);
  return { id, url: `/api/assets/${saveId}/${id}.glb?v=${buf.length}` };
}

const wrap = fn => async (...a) => { try { return await fn(...a); } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, 'BAD_REQUEST', e.message); } };
// calls = actual attempts (one row each); logical = calls as the caller made them (retries folded in).
// cost sums priced attempts only; unpriced counts attempts without known usage or prices, so it is never a fake 0.
function usage(saveId) {
  const rows = db.prepare(`SELECT purpose, count(DISTINCT coalesce(logical_id, id)) logical, count(*) calls, sum(input_tokens) input, sum(cached_tokens) cached, sum(output_tokens) output,
      sum(coalesce(cache_reported, 0)) cache_reported, sum(CASE WHEN cache_reported = 1 THEN input_tokens ELSE 0 END) cache_input,
      sum(cost_usd) cost, sum(cost_usd IS NULL) unpriced, sum(coalesce(usage_known, ok) = 0) usage_unknown, avg(latency_ms) latency, sum(ok = 0) errors,
      sum(stage = 'network') err_network, sum(stage = 'http') err_http, sum(stage = 'json') err_json, sum(stage = 'shape') err_shape, sum(finish_reason = 'length') truncated
    FROM llm_calls WHERE ${saveId ? 'save_id = ?' : '1'} GROUP BY purpose ORDER BY calls DESC`).all(...(saveId ? [saveId] : []));
  const total = rows.reduce((t, r) => ({ logical: t.logical + r.logical, calls: t.calls + r.calls, cost: t.cost + (r.cost || 0), unpriced: t.unpriced + r.unpriced, errors: t.errors + r.errors }), { logical: 0, calls: 0, cost: 0, unpriced: 0, errors: 0 });
  return { rows, total };
}
const withText = (saveId, evs) => {
  const scene = lab.scene(saveId);
  const flags = lab.ledger.flagMap(saveId);
  return evs.map(e => ({ ...e, text: eventText(scene, e), flags: [...(flags.get(e.seq) || [])] }));
};
function needDebug(saveId) {
  const id = needSave(saveId).id;
  if (!lab.scene(id).rules) throw new HttpError(400, 'NO_WORLD', '这个存档没开「天气和营地的量」。');
  if (!lab.features(id).debug) throw new HttpError(403, 'NO_DEBUG', '先在「世界」页打开「调试」。');
  return id;
}

/** 3.0 F6: everything the 世界 tab shows. Tomorrow's weather only with peek (looking changes nothing). */
function worldView(saveId, peek) {
  const features = lab.features(saveId);
  const scene = lab.scene(saveId);
  if (!scene.rules) return { on: false, features };
  const t = lab.clock.now(saveId);
  const c = lab.environment.climate(saveId, t);
  const tomorrow = lab.environment.planned(saveId, addDays(c.date, 1));
  const st = lab.ledger.world(saveId);
  const text = e => eventText(scene, e);
  const recent = (types, n, f = () => true) => lab.ledger.list(saveId, { types, desc: true, limit: 400 }).filter(f).slice(0, n).map(e => ({ seq: e.seq, t: e.t, text: text(e), payload: e.payload }));
  return {
    on: true, features, paces: PACES, now: t,
    today: { date: c.date, day: c.day, am: c.am, pm: c.pm, kind: c.kind, temp: c.temp, hi: c.hi, lo: c.lo, wind: c.wind, sign: st.sign?.day === c.date ? st.sign.sign : null },
    tomorrow: peek ? { am: tomorrow.am, pm: tomorrow.pm } : null,
    vars: st.vars, varChanges: recent(['var_changed'], 10),
    active: Object.values(st.incidents || {}).map(o => ({ ...o, name: scene.incidents.find(i => i.id === o.id)?.name || o.id, left: o.deadline ? Math.max(0, o.deadline - t) : null, help: scene.incidents.find(i => i.id === o.id)?.resolve?.some(r => r.by !== 'char') ?? false })),
    history: recent(['incident'], 60, e => e.t >= t - 3 * 86_400_000),
    incidents: scene.incidents.map(i => ({ id: i.id, name: i.name, sev: i.sev })),
    weatherKinds: scene.rules.weather.kinds,
    scout: lab.scout.on(saveId) ? { dirs: lab.scout.dirs(saveId).map(d => ({ dir: d, blocked: lab.scout.blocked(saveId, d) })), plan: st.vars.scout_plan || null, sessionOpen: st.sessionOpen, latest: lab.scout.latest(saveId) } : null,
    map: st.vars.map || [],
    practice: st.practice ? { ...st.practice, name: (scene.practices || []).find(x => x.id === st.practice.id)?.name || st.practice.id } : null,
    bet: st.bet || null,
    log: lab.director.recentLog(saveId, 30)
  };
}

function settingsView() {
  const s = llmSettings(env);
  return { provider: env.LLM_PROVIDER === 'mock' ? 'mock' : 'openai_compat', baseUrl: s.baseUrl, model: s.model, modelBackground: env.LLM_MODEL_BACKGROUND || '', modelJudge: env.LLM_MODEL_JUDGE || '', studioPort: env.STUDIO_PORT || '', extraBody: env.LLM_EXTRA_BODY || '', prices: { input: env.LLM_PRICE_INPUT || '', cached: env.LLM_PRICE_CACHED || '', output: env.LLM_PRICE_OUTPUT || '' }, keySet: Boolean(env.LLM_API_KEY), keyMasked: mask(env.LLM_API_KEY) };
}

// API routes: [method, pattern, handler({ req, url, params, body })]. Patterns use :name segments.
const ROUTES = [
  ['GET', '/api/health', () => ({ ok: true, version, provider: getEnv().LLM_PROVIDER === 'mock' ? 'mock' : 'openai_compat' })],
  ['GET', '/api/scenes', () => listScenes()],
  // Browser tests only (LAB_DEV_MOCK=1): queue the mock model's next answer for a purpose.
  ...(process.env.LAB_DEV_MOCK === '1' ? [['POST', '/api/dev/mock', ({ body }) => { lab.llm.mock.enqueue(String(body.purpose), body.answer); return { ok: true }; }]] : []),
  ['GET', '/api/clips', async () => JSON.parse(await readFile(path.join(baseDir, 'scenes', 'clips.json'), 'utf8'))],
  ['GET', '/api/saves', () => lab.saves.listSaves().map(s => ({ id: s.id, name: s.name, scene_id: s.scene_id, clock_ms: s.clock_ms, clockText: formatWorldTime(s.clock_ms), session_open: Boolean(s.session_id), created_at: s.created_at, mock: lab.mockSaves.has(s.id) }))],
  // 3.0 E4: saves made here get every 3.0 feature; tests and scenarios that build saves directly get none.
  ['POST', '/api/saves', ({ body }) => { const s = lab.saves.createSave({ name: body.name, sceneId: body.sceneId || 'island', userName: body.userName }); lab.setFeatures(s.id, body.features && typeof body.features === 'object' ? body.features : ALL_ON); return lab.saves.getSave(s.id); }],
  ['GET', '/api/saves/:id/features', ({ params }) => ({ features: lab.features(needSave(params.id).id), titles: FEATURE_TITLES, paces: PACES })],
  ['PUT', '/api/saves/:id/features', ({ params, body }) => ({ features: lab.setFeatures(needSave(params.id).id, body || {}) })],
  // 3.0 F6: the 世界 tab, and its debug buttons (only with the save's 调试 switch on).
  ['GET', '/api/saves/:id/world', ({ params, url }) => worldView(needSave(params.id).id, url.searchParams.get('peek') === '1')],
  // 3.0 G2: book a scout (while away); what the user saw on the latest one.
  ['POST', '/api/saves/:id/scout', ({ params, body }) => { const id = needSave(params.id).id; lab.scout.book(id, String(body.dir || '')); return worldView(id, false); }],
  ['GET', '/api/saves/:id/scout/latest', ({ params }) => ({ scout: lab.scout.latest(needSave(params.id).id) })],
  ['GET', '/api/saves/:id/director', ({ params }) => ({ log: lab.director.recentLog(needSave(params.id).id, 100) })],
  ['POST', '/api/saves/:id/debug/weather', ({ params, body }) => { const id = needDebug(params.id); return { events: withText(id, lab.worldsim.forceWeather(id, String(body.kind || ''))) }; }],
  ['POST', '/api/saves/:id/debug/incident', ({ params, body }) => { const id = needDebug(params.id); return { events: withText(id, lab.director.force(id, String(body.id || ''))) }; }],
  ['DELETE', '/api/saves/:id', async ({ params }) => { needSave(params.id); lab.saves.deleteSave(params.id); lab.ledger.forget(params.id); await rm(safeJoin(assetsDir, params.id), { recursive: true, force: true }); await rm(safeJoin(savesDir, params.id), { recursive: true, force: true }); return { ok: true }; }],
  // 2.0 C1: read-only import from 造物台.
  ['GET', '/api/studio/catalog', () => studioCall(async () => ({ url: studioUrl(), ...catalog(await fetchState(studioUrl())) }))],
  ['POST', '/api/saves/:id/import-studio', ({ params, body }) => studioCall(async () => {
    const save = needSave(params.id);
    const out = await importStudio(lab, { saveId: save.id, sceneAssetId: String(body.scene || ''), chars: body.characters || {}, base: studioUrl(), assetsDir });
    return { changed: out.changed, edits: out.edits.length, files: out.files.length, bytes: out.files.reduce((a, f) => a + f.bytes, 0), objects: out.scene.objects.length, rooms: out.scene.rooms.length };
  })],
  ['GET', '/api/assets', ({ url }) => listAssets(needSave(url.searchParams.get('save')).id)],
  ['GET', '/api/state', ({ url }) => {
    const save = needSave(url.searchParams.get('save'));
    return { save: { ...save, session_open: Boolean(save.session_id) }, scene: lab.scene(save.id), world: lab.ledger.world(save.id), clockText: formatWorldTime(save.clock_ms), env: lab.environment.now(save.id), life: Object.fromEntries(lab.scene(save.id).characters.map(c => [c.id, lab.life.now(save.id, c.id)])), jobsPending: lab.jobs.pending(save.id), jobErrors: lab.jobs.errors(save.id), usage: usage(save.id).total, lastSeq: lab.ledger.lastSeq(save.id) };
  }],
  ['POST', '/api/session', async ({ body }) => {
    const save = needSave(body.save);
    const events = body.op === 'start' ? await lab.session.start(save.id) : body.op === 'end' ? lab.session.end(save.id) : null;
    if (!events) throw new HttpError(400, 'BAD_OP', 'op 只能是 start 或 end');
    return { events: withText(save.id, events) };
  }],
  // 2.0 D1: the page calls this every 45 real seconds while a session is open.
  ['POST', '/api/saves/:id/playtest-notes', ({ params, body }) => ({ note: lab.saves.addPlaytestNote(needSave(params.id).id, body.text), notes: lab.saves.playtestNotes(params.id) })],
  ['POST', '/api/saves/:id/tick', async ({ params }) => { const save = needSave(params.id); const r = await lab.session.tick(save.id); return { events: withText(save.id, r.events), skipped: r.skipped, idle: r.idle.map(x => ({ character: x.character, turnId: x.turnId, spoke: x.spoke, say: x.say })), clockText: formatWorldTime(lab.clock.now(save.id)) }; }],
  ['POST', '/api/time', ({ body }) => { const save = needSave(body.save); return { events: withText(save.id, lab.session.advance(save.id, body.advance)) }; }],
  ['POST', '/api/chat', async ({ body }) => {
    const save = needSave(body.save);
    const r = await lab.turns.runTurn({ saveId: save.id, charId: needChar(save.id, body.character), text: body.text, compare: Boolean(body.compare) });
    return { ...r, opened: withText(save.id, r.opened), events: withText(save.id, r.events), userEvent: withText(save.id, [r.userEvent])[0] };
  }],
  ['POST', '/api/delivered', ({ body }) => lab.proactive.recordDelivered(body.turnId)],
  ['POST', '/api/act', ({ body }) => { const save = needSave(body.save); return { events: withText(save.id, lab.turns.act(save.id, body)) }; }],
  ['GET', '/api/events', ({ url }) => {
    const save = needSave(url.searchParams.get('save'));
    const q = url.searchParams;
    return withText(save.id, lab.ledger.list(save.id, { after: Number(q.get('after')) || 0, target: q.get('target') || undefined, types: q.get('types') ? q.get('types').split(',') : undefined, limit: Math.min(2000, Number(q.get('limit')) || 500) }));
  }],
  ['GET', '/api/memory', ({ url }) => {
    const save = needSave(url.searchParams.get('save'));
    const c = needChar(save.id, url.searchParams.get('character'));
    const s = save.id;
    return {
      facts: lab.facts.all(s, c),
      rejected: db.prepare('SELECT * FROM rejected_facts WHERE save_id = ? AND character_id = ? ORDER BY at DESC LIMIT 50').all(s, c).map(r => ({ ...r, candidate: pj(r.candidate_json, {}) })),
      commitments: lab.commitments.list(s, c),
      caches: db.prepare('SELECT * FROM caches WHERE save_id = ? AND character_id = ? ORDER BY from_seq, created_at').all(s, c).map(r => ({ ...r, derived_from: pj(r.derived_from, []) })),
      selfCanon: lab.selfCanon.list(s, c),
      relationship: { ...lab.relationship.compute(s, c), card: lab.relationship.card(s, c), history: lab.relationship.history(s, c) },
      suppressions: lab.admission.activeSuppressions(s, c),
      forgetJobs: lab.forget.list(s, c),
      mentions: db.prepare('SELECT * FROM mentions WHERE save_id = ? AND character_id = ? ORDER BY t DESC LIMIT 50').all(s, c),
      idle: lab.idle.recentThoughts(s, c),
      playtestNotes: lab.saves.playtestNotes(s)
    };
  }],
  ['GET', '/api/turns', ({ url }) => {
    const save = needSave(url.searchParams.get('save'));
    const c = url.searchParams.get('character');
    return db.prepare(`SELECT id, character_id, mode, committed, user_seq, reply_seq, t, generation FROM turns WHERE save_id = ?${c ? ' AND character_id = ?' : ''} ORDER BY t DESC, rowid DESC LIMIT ?`).all(...[save.id, ...(c ? [c] : []), Math.min(200, Number(url.searchParams.get('limit')) || 30)]);
  }],
  ['GET', '/api/turn-groups', ({ url }) => {
    const save = needSave(url.searchParams.get('save'));
    return lab.turns.groups(save.id, needChar(save.id, url.searchParams.get('character')), { limit: Math.min(500, Number(url.searchParams.get('limit')) || 200) });
  }],
  ['GET', '/api/turns/:id', ({ params }) => {
    const t = db.prepare('SELECT * FROM turns WHERE id = ?').get(params.id);
    if (!t) throw new HttpError(404, 'NOT_FOUND', '没有这一轮。');
    return { ...t, sections: pj(t.sections_json, []), prompt: pj(t.prompt_json, []), output: pj(t.output_json, null), rejected: pj(t.rejected_json, null), view: lab.turns.view(t) };
  }],
  ['POST', '/api/forget', async ({ body }) => {
    const save = needSave(body.save);
    if (!['suppress', 'forget', 'delete'].includes(body.verb)) throw new HttpError(400, 'BAD_VERB', 'verb 只能是 suppress / forget / delete');
    if (!Array.isArray(body.refs) || !body.refs.length) throw new HttpError(400, 'NO_REFS', '要选中至少一条记忆。');
    return lab.forget.propose(save.id, needChar(save.id, body.character), { verb: body.verb, topic: body.topic || '', requestSeq: 0, refs: body.refs });
  }],
  ['POST', '/api/forget/:id/confirm', async ({ params }) => { const job = lab.forget.getJob(params.id); if (!job) throw new HttpError(404, 'NOT_FOUND', '没有这个任务。'); lab.forget.confirm(params.id); await lab.jobs.idle(job.save_id); return lab.forget.getJob(params.id); }],
  ['POST', '/api/forget/:id/cancel', ({ params }) => lab.forget.cancel(params.id)],
  ['GET', '/api/jobs', ({ url }) => lab.jobs.runs(needSave(url.searchParams.get('save')).id)],
  ['POST', '/api/jobs/retry', async ({ body }) => { const save = needSave(body.save); return lab.jobs.retry(save.id, { id: body.id || undefined }); }],
  ['GET', '/api/settings', () => settingsView()],
  ['POST', '/api/settings', async ({ body }) => {
    const next = { ...env };
    const set = (k, v) => { if (v === undefined) return; const s = String(v ?? '').trim(); if (/[\r\n]/.test(s)) throw new HttpError(400, 'BAD_VALUE', '设置里不能有换行。'); if (s) next[k] = s; else delete next[k]; };
    if (body.provider !== undefined) set('LLM_PROVIDER', body.provider === 'mock' ? 'mock' : 'openai_compat');
    set('LLM_BASE_URL', body.baseUrl); set('LLM_MODEL', body.model); set('LLM_MODEL_BACKGROUND', body.modelBackground); set('LLM_MODEL_JUDGE', body.modelJudge);
    if (body.studioPort !== undefined && String(body.studioPort).trim() && !/^\d{2,5}$/.test(String(body.studioPort).trim())) throw new HttpError(400, 'BAD_VALUE', '造物台端口要是数字。');
    set('STUDIO_PORT', body.studioPort);
    if (body.extraBody !== undefined && String(body.extraBody).trim()) { try { JSON.parse(body.extraBody); } catch { throw new HttpError(400, 'BAD_JSON', '额外参数必须是 JSON。'); } }
    set('LLM_EXTRA_BODY', body.extraBody);
    if (body.prices) { set('LLM_PRICE_INPUT', body.prices.input); set('LLM_PRICE_CACHED', body.prices.cached); set('LLM_PRICE_OUTPUT', body.prices.output); }
    if (body.apiKey) set('LLM_API_KEY', body.apiKey);
    if (body.clearKey) delete next.LLM_API_KEY;
    await saveEnv(envFile, next);
    env = next;
    return settingsView();
  }],
  ['POST', '/api/settings/test', () => lab.llm.testConnection()],
  ['GET', '/api/usage', ({ url }) => usage(url.searchParams.get('save'))],
  ['GET', '/api/scenarios', () => scenarios.list().map(s => ({ id: s.id, title: s.title, steps: s.steps.length }))],
  ['POST', '/api/scenarios/:id/run', async ({ params, body }) => {
    const provider = body.provider === 'live' ? 'live' : 'mock';
    if (provider === 'live' && !getEnv().LLM_API_KEY) throw new HttpError(400, 'NO_KEY', '用真模型跑剧本前先在设置里填 API Key。');
    return scenarios.start(params.id, { provider, requestId: body.requestId ?? null, stepOnly: Boolean(body.step) });
  }],
  // 2.0 D7: three-arm runs and their side-by-side page.
  ['POST', '/api/scenarios/:id/arms', async ({ params, body }) => {
    const provider = body.provider === 'live' ? 'live' : 'mock';
    if (provider === 'live' && !getEnv().LLM_API_KEY) throw new HttpError(400, 'NO_KEY', '用真模型跑剧本前先在设置里填 API Key。');
    return scenarios.startArms(params.id, { provider, requestId: body.requestId ?? null });
  }],
  ['GET', '/api/arms', () => scenarios.armGroups()],
  ['GET', '/api/arms/:group', ({ params }) => scenarios.arms(params.group) || (() => { throw new HttpError(404, 'NOT_FOUND', '没有这组三路运行。'); })()],
  ['PUT', '/api/arms/:group/notes/:step', ({ params, body }) => scenarios.setArmNote(params.group, params.step, body.text) || (() => { throw new HttpError(404, 'NOT_FOUND', '没有这组三路运行。'); })()],
  ['GET', '/api/scenario-runs', ({ url }) => scenarios.history(Math.min(200, Number(url.searchParams.get('limit')) || 30))],
  ['GET', '/api/scenario-runs/:id/export', ({ params }) => scenarios.exportRun(params.id, llmSettings(getEnv())) || (() => { throw new HttpError(404, 'NOT_FOUND', '没有这次运行。'); })()],
  ['POST', '/api/scenario-runs/:id/step', ({ params }) => scenarios.step(params.id)],
  // 2.0 B5: card versions per save. A bad card is a 400 whose message carries the line number.
  ['GET', '/api/saves/:id/characters/:char/card', ({ params }) => cardCall(() => lab.cards.current(needSave(params.id).id, needChar(params.id, params.char)))],
  ['PUT', '/api/saves/:id/characters/:char/card', ({ params, body }) => cardCall(() => lab.cards.save(needSave(params.id).id, needChar(params.id, params.char), String(body.text ?? ''), body.note))],
  ['GET', '/api/saves/:id/characters/:char/card/versions', ({ params }) => cardCall(() => lab.cards.versions(needSave(params.id).id, needChar(params.id, params.char)))],
  ['POST', '/api/saves/:id/characters/:char/card/restore', ({ params, body }) => cardCall(() => lab.cards.restore(needSave(params.id).id, needChar(params.id, params.char), body.version))],
  ['POST', '/api/cards/draft', ({ body }) => draftCard(lab, { saveId: body.save ? needSave(body.save).id : null, sceneId: body.sceneId, looks: body.looks, persona: body.persona })],
  ['GET', '/api/scenario-runs/:id', ({ params }) => scenarios.get(params.id) || (() => { throw new HttpError(404, 'NOT_FOUND', '没有这次运行。'); })()]
].map(([method, pattern, fn]) => ({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), fn: wrap(fn) }));

async function route(req, res, url) {
  const p = decodeURIComponent(url.pathname);
  const asset = /^\/api\/assets\/([^/]+)\/([^/]+)$/.exec(p);
  const studioFile = /^\/api\/assets\/([^/]+)\/studio\/([^/]+)$/.exec(p);
  if (studioFile && ['GET', 'HEAD'].includes(req.method)) return serveFile(req, res, safeJoin(assetsDir, `${studioFile[1]}/studio/${studioFile[2]}`));
  if (asset && req.method === 'PUT') return json(res, 200, await putAsset(req, asset[1], asset[2]));
  if (asset && ['GET', 'HEAD'].includes(req.method)) return serveFile(req, res, safeJoin(assetsDir, `${asset[1]}/${asset[2]}`));
  for (const r of ROUTES) {
    const m = r.method === req.method && r.re.exec(p);
    if (m) return json(res, 200, await r.fn({ req, url, params: m.groups || {}, body: ['POST', 'PUT'].includes(req.method) ? await jsonBody(req) : {} }));
  }
  if (p.startsWith('/api/')) throw new HttpError(404, 'NOT_FOUND', '没有这个接口。');
  if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, 'METHOD', '不支持。');
  if (p.startsWith('/vendor/three/')) return serveFile(req, res, safeJoin(path.join(baseDir, 'node_modules', 'three'), p.slice('/vendor/three/'.length)));
  return serveFile(req, res, safeJoin(publicDir, p === '/' ? 'index.html' : p.slice(1)));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  // Local-only tool: answer loopback host names only, refuse cross-site writes.
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '')) return json(res, 403, { error: { code: 'LOCAL_ONLY', message: '只接受本机访问。' } });
  const origin = req.headers.origin;
  if (req.method !== 'GET' && req.method !== 'HEAD' && origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return json(res, 403, { error: { code: 'CROSS_SITE', message: '拒绝跨站请求。' } });
  try { await route(req, res, url); }
  catch (e) {
    if (res.headersSent) return res.end();
    const status = e.status || 500;
    if (status >= 500) console.error(e);
    json(res, status, { error: { code: e.code || 'ERROR', message: e.message || '服务器错误' } });
  }
});

server.keepAliveTimeout = 65000; server.headersTimeout = 66000;
server.listen(PORT, '127.0.0.1', () => console.log(`记忆实验台：http://127.0.0.1:${PORT}`));
// Launched by the Mac app: exit with it, even if the app is force-quit.
if (process.env.LAB_APP) { const parent = process.ppid; setInterval(() => { if (process.ppid !== parent) process.exit(0); }, 2000).unref(); }
