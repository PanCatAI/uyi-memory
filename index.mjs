// UYI 记忆插件的公开接口。桌面端只用这里导出的东西；lib/ 下面是内核，随时可能改。
// 一个「空间」(space) = 内核里的一个存档 (save)：一个场景 + 住在里面的角色 + 一个用户。
//
//   import { createMemory } from '@pancat/uyi-memory';
//   const mem = await createMemory({ dataDir, env: { LLM_PROVIDER: 'openai_compat', LLM_API_KEY: '...' } });
//   const space = mem.createSpace({ name: '我的房间', userName: '小林', scene, features: {} });
//   const r = await mem.chat(space.id, 'rin', '这个红杯子是我奶奶留下的');
//
// 所有入参、返回值都是普通 JSON，HTTP 服务（server/http.mjs）一对一映射这些方法。
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { createLab } from './lib/lab.mjs';
import { validateScene, parseCard } from './lib/scene.mjs';
import { formatWorldTime } from './lib/clock.mjs';
import { eventText } from './lib/memory/common.mjs';
import { pj } from './lib/db.mjs';
import { FEATURES } from './lib/features.mjs';
import { EVENT_TYPES } from './contracts/events.mjs';

export const API_VERSION = 1;
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
export const VERSION = pkg.version;

/** 桌面端可以直接写进账本的事件（3D 里真实发生的事）。模型说的话和要做的动作只能经 chat() 进来。 */
export const HOST_EVENT_TYPES = ['user_action', 'char_action', 'char_moved', 'object_changed', 'object_created', 'object_removed', 'weather'];

const ID = /^[a-z0-9_-]{1,64}$/i;

export class MemoryError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

/**
 * dataDir: 数据库和每个空间的场景文件放在这里（桌面端建议放在用户数据目录，例如 Electron 的 app.getPath('userData')/memory）。
 * env / getEnv: 模型设置（LLM_PROVIDER、LLM_BASE_URL、LLM_API_KEY、LLM_MODEL…，见 .env.example）。getEnv 每次调用都会读，改设置不用重启。
 * fetchImpl: 测试用。
 */
export async function createMemory({ dataDir, env = null, getEnv = null, fetchImpl } = {}) {
  if (!dataDir) throw new MemoryError('NO_DATA_DIR', '要给 dataDir');
  mkdirSync(dataDir, { recursive: true });
  const savesDir = path.join(dataDir, 'spaces');
  mkdirSync(savesDir, { recursive: true });
  const readEnv = getEnv || (() => env || { LLM_PROVIDER: 'mock' });
  const lab = createLab({ file: path.join(dataDir, 'memory.sqlite'), getEnv: readEnv, savesDir, ...(fetchImpl ? { fetchImpl } : {}) });
  const { db } = lab;

  const needSpace = id => {
    const s = id && lab.saves.getSave(id);
    if (!s) throw new MemoryError('NO_SPACE', `没有这个空间：${id}`, 404);
    return s;
  };
  const needChar = (spaceId, id) => {
    if (!lab.scene(spaceId).characters.some(c => c.id === id)) throw new MemoryError('NO_CHARACTER', `没有这个角色：${id}`);
    return id;
  };
  const withText = (spaceId, evs) => {
    const scene = lab.scene(spaceId);
    return evs.filter(Boolean).map(e => ({ ...e, text: eventText(scene, e) }));
  };
  const spaceView = s => ({
    id: s.id, name: s.name, userName: s.user_name, sceneId: s.scene_id,
    clock: s.clock_ms, clockText: formatWorldTime(s.clock_ms), sessionOpen: Boolean(s.session_id),
    characters: lab.scene(s.id).characters.map(c => ({ id: c.id, name: c.name })),
    features: lab.features(s.id)
  });

  /** 校验并写下空间自己的 scene.json。角色卡用 card_text（markdown 原文）内联。 */
  function writeScene(spaceId, scene) {
    if (!scene || typeof scene !== 'object') throw new MemoryError('BAD_SCENE', '要给 scene 对象');
    const copy = JSON.parse(JSON.stringify(scene));
    copy.id = copy.id || spaceId;
    copy.rooms ||= []; copy.objects ||= []; copy.palette ||= []; copy.actions ||= {};
    for (const c of copy.characters || []) {
      if (!ID.test(c.id || '')) throw new MemoryError('BAD_SCENE', `角色 id 不合法：${c.id}`);
      if (typeof c.card_text !== 'string' || !c.card_text.trim()) throw new MemoryError('BAD_SCENE', `角色 ${c.id} 要有 card_text（角色卡 markdown）`);
      delete c.card;
      parseCard(c.card_text);
    }
    try { validateScene(JSON.parse(JSON.stringify(copy))); } catch (e) { throw new MemoryError('BAD_SCENE', e.message); }
    const dir = path.join(savesDir, spaceId);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'scene.json');
    writeFileSync(`${file}.tmp`, JSON.stringify(copy, null, 2));
    renameSync(`${file}.tmp`, file); // never leaves a half-written scene behind
    lab.ledger.forget(spaceId);
    return copy;
  }

  const mem = {
    version: VERSION,
    apiVersion: API_VERSION,
    lab, // 调试用：内核对象。桌面端不要依赖它

    // ── 空间 ──────────────────────────────────────────────
    /**
     * { id?, name, userName, scene, features, now } → 空间。
     * features 默认全关（只有记忆，没有营地玩法）。now: 世界时钟起点，默认真实时间（传 null 用内核的固定起点，测试用）。
     */
    createSpace({ id = null, name = '新空间', userName = '你', scene, features = {}, now = Date.now() } = {}) {
      if (id != null && !ID.test(id)) throw new MemoryError('BAD_ID', 'id 只能用字母数字 _ -，最长 64');
      if (id && lab.saves.getSave(id)) throw new MemoryError('EXISTS', `空间已存在：${id}`, 409);
      const sid = id || `sp_${Math.random().toString(36).slice(2, 12)}`;
      const written = writeScene(sid, scene);
      try {
        lab.saves.createSave({ id: sid, name, sceneId: /^[a-z0-9_-]+$/.test(written.id) ? written.id : 'custom', userName, ownScene: true });
      } catch (e) { rmSync(path.join(savesDir, sid), { recursive: true, force: true }); throw e; }
      lab.setFeatures(sid, features);
      if (now != null) mem.syncClock(sid, now);
      return spaceView(lab.saves.getSave(sid));
    },
    listSpaces() { return lab.saves.listSaves().map(spaceView); },
    getSpace(spaceId) { return spaceView(needSpace(spaceId)); },
    /** 场景改了（摆了新家具、加了角色）就整份重新给。已有的记忆不受影响；被删掉的物件在账本里还留着历史。 */
    updateScene(spaceId, scene) { needSpace(spaceId); writeScene(spaceId, scene); return spaceView(lab.saves.getSave(spaceId)); },
    setFeatures(spaceId, patch) { needSpace(spaceId); return lab.setFeatures(spaceId, patch); },
    /** 删掉整个空间：账本、事实、经历、调用记录，全部。 */
    deleteSpace(spaceId) {
      needSpace(spaceId);
      lab.saves.deleteSave(spaceId);
      lab.ledger.forget(spaceId);
      rmSync(path.join(savesDir, spaceId), { recursive: true, force: true });
      return { ok: true };
    },

    // ── 时间与会话 ─────────────────────────────────────────
    /** 把世界时钟拨到 ms（只能往前）。桌面端在打开应用、每次 tick 时传真实时间 Date.now()。 */
    syncClock(spaceId, ms) {
      needSpace(spaceId);
      const now = lab.clock.now(spaceId);
      if (!Number.isFinite(ms)) throw new MemoryError('BAD_TIME', '要给毫秒时间戳');
      if (ms > now) lab.clock.set(spaceId, ms);
      return { clock: lab.clock.now(spaceId), clockText: formatWorldTime(lab.clock.now(spaceId)) };
    },
    /** 用户打开应用 / 回到这个空间。离开 ≥2 小时的话角色会补上离屏做过的事（会调模型）。now: 可选，先 syncClock。 */
    async openSession(spaceId, { now } = {}) {
      needSpace(spaceId);
      if (now != null) mem.syncClock(spaceId, now);
      return { events: withText(spaceId, await lab.session.start(spaceId)) };
    },
    /** 用户关掉应用 / 离开空间。会在后台整理这次会话的观察日志。 */
    closeSession(spaceId) { needSpace(spaceId); return { events: withText(spaceId, lab.session.end(spaceId)) }; },
    /** 会话开着时每 30–60 秒调一次：角色作息往前走，用户安静一会儿后角色可能自己说一句（idle 里有 say）。 */
    async tick(spaceId, { now } = {}) {
      needSpace(spaceId);
      if (now != null) mem.syncClock(spaceId, now);
      const r = await lab.session.tick(spaceId);
      return { events: withText(spaceId, r.events), skipped: r.skipped || null, idle: r.idle.map(x => ({ character: x.character, turnId: x.turnId, spoke: x.spoke, say: x.say })) };
    },

    // ── 对话 ──────────────────────────────────────────────
    /**
     * 用户对角色说一句话 → 角色回复。返回：
     *   say: 回复文字；action: 已经过仲裁、要在 3D 里播的动作（或 null）；actionResult: 仲裁结果；
     *   used: 这句用到的记忆引用；turnId: 播完/显示完后调 delivered(turnId)；forgetJob: 用户说「忘了那件事」时的待确认任务。
     */
    async chat(spaceId, characterId, text) {
      needSpace(spaceId); needChar(spaceId, characterId);
      const r = await lab.turns.runTurn({ saveId: spaceId, charId: characterId, text });
      return {
        turnId: r.turnId, say: r.reply.say, action: r.reply.action || null, actionResult: r.reply.actionResult || null,
        used: r.reply.used || [], withheld: r.reply.withheld || null, error: r.reply.error || null,
        forgetJob: r.forgetJob || null, cost: r.reply.cost ?? null,
        events: withText(spaceId, [...r.opened, r.userEvent, ...r.events])
      };
    },
    /** 回复真的显示/播出给用户后调用。只有送达的回复才算「提起过」，主动提起的冷却靠它。 */
    delivered(turnId) { return lab.proactive.recordDelivered(turnId); },

    // ── 3D 里发生的事 ─────────────────────────────────────
    /** 用户在 3D 里做的事（送东西、放东西、搭建、挪东西）。{ action: give|place|build|move_object, target, args } */
    userAction(spaceId, act) { needSpace(spaceId); return { events: withText(spaceId, lab.turns.act(spaceId, act || {})) }; },
    /**
     * 宿主直接记一条事件：例如角色动作播完的结果（char_action + outcome）、物件状态变了（object_changed）。
     * 类型限于 HOST_EVENT_TYPES；格式见 contracts/events.mjs。
     */
    recordEvent(spaceId, ev) {
      needSpace(spaceId);
      if (!ev || !HOST_EVENT_TYPES.includes(ev.type)) throw new MemoryError('BAD_EVENT', `只能记这些类型：${HOST_EVENT_TYPES.join(', ')}`);
      const { seq, t, session_id, tombstone, ...input } = ev; // 头由内核分配
      void seq; void t; void session_id; void tombstone;
      try { return { events: withText(spaceId, [lab.ledger.append(spaceId, input)]) }; }
      catch (e) { throw new MemoryError('BAD_EVENT', e.message); }
    },
    events(spaceId, { after = 0, limit = 200, types } = {}) {
      needSpace(spaceId);
      return withText(spaceId, lab.ledger.list(spaceId, { after: Number(after) || 0, limit: Math.min(2000, Number(limit) || 200), ...(types ? { types } : {}) }));
    },
    world(spaceId) { needSpace(spaceId); return lab.ledger.world(spaceId); },

    // ── 记忆面板 ──────────────────────────────────────────
    /** 角色记得的关于用户的事、经历、约定、关系。给「她记得的你」之类的界面用。 */
    memory(spaceId, characterId) {
      needSpace(spaceId); needChar(spaceId, characterId);
      const s = spaceId, c = characterId;
      // 每条带 ref，传给 proposeForget 的 refs 用
      return {
        facts: lab.facts.all(s, c).map(f => ({ ref: `fact:${f.id}`, ...f })),
        commitments: lab.commitments.list(s, c).map(x => ({ ref: `commit:${x.id}`, ...x })),
        // 观察日志、经历、日记、纪念品（模型写的叙述，来源被忘掉时自动作废重建）
        episodes: db.prepare('SELECT id, kind, text, from_seq, to_seq, created_at FROM caches WHERE save_id = ? AND character_id = ? AND invalid = 0 ORDER BY from_seq, created_at').all(s, c).map(x => ({ ref: `cache:${x.id}`, ...x })),
        relationship: { ...lab.relationship.compute(s, c), card: lab.relationship.card(s, c) },
        suppressions: lab.admission.activeSuppressions(s, c),
        forgetJobs: lab.forget.list(s, c)
      };
    },
    /** 用户在记忆面板里点「别再提 / 忘掉 / 删除」。refs 来自 memory() 里每条的 ref。返回待确认任务。 */
    async proposeForget(spaceId, characterId, { verb, refs, topic = '' }) {
      needSpace(spaceId); needChar(spaceId, characterId);
      if (!['suppress', 'forget', 'delete'].includes(verb)) throw new MemoryError('BAD_VERB', 'verb 只能是 suppress / forget / delete');
      if (!Array.isArray(refs) || !refs.length) throw new MemoryError('NO_REFS', '要选中至少一条记忆');
      return lab.forget.propose(spaceId, characterId, { verb, topic, requestSeq: 0, refs });
    },
    async confirmForget(jobId) {
      const job = lab.forget.getJob(jobId);
      if (!job) throw new MemoryError('NOT_FOUND', '没有这个任务', 404);
      lab.forget.confirm(jobId);
      await lab.jobs.idle(job.save_id);
      return lab.forget.getJob(jobId);
    },
    cancelForget(jobId) { return lab.forget.cancel(jobId); },

    // ── 运维 ──────────────────────────────────────────────
    /** 等后台任务（抽事实、写观察、忘记）跑完。测试和退出前用。 */
    async idle(spaceId) { if (spaceId) await lab.jobs.idle(spaceId); else for (const s of lab.saves.listSaves()) await lab.jobs.idle(s.id); },
    jobErrors(spaceId) { needSpace(spaceId); return lab.jobs.errors(spaceId); },
    usage(spaceId = null) {
      const rows = db.prepare(`SELECT purpose, count(*) calls, sum(input_tokens) input, sum(cached_tokens) cached, sum(output_tokens) output, sum(cost_usd) cost, sum(ok = 0) errors
        FROM llm_calls WHERE ${spaceId ? 'save_id = ?' : '1'} GROUP BY purpose ORDER BY calls DESC`).all(...(spaceId ? [spaceId] : []));
      return { rows, total: rows.reduce((t, r) => ({ calls: t.calls + r.calls, cost: t.cost + (r.cost || 0) }), { calls: 0, cost: 0 }) };
    },
    turn(turnId) {
      const t = db.prepare('SELECT * FROM turns WHERE id = ?').get(turnId);
      if (!t) throw new MemoryError('NOT_FOUND', '没有这一轮', 404);
      return { ...t, sections: pj(t.sections_json, []), output: pj(t.output_json, null) };
    },
    testConnection() { return lab.llm.testConnection(); },
    async close() { await mem.idle(); db.close(); }
  };
  return mem;
}

export { FEATURES, EVENT_TYPES };
export const exists = dir => existsSync(path.join(dir, 'memory.sqlite'));
