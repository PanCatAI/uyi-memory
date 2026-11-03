// Scenario runner (PLAN §8.2): replays scenarios/*.json against a fresh save and checks assertions in the database.
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { LAB_DIR } from './scene.mjs';
import { newId } from './ids.mjs';
import { j, pj } from './db.mjs';
import { realNow, parseDuration, formatWorldTime, WORLD_START, DAY } from './clock.mjs';
import { bannedIn } from './memory/style.mjs';
import { parseRef } from './memory/common.mjs';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { importStudio } from './studio-import.mjs';
import { fixtureStudio, FIXTURE_SCENE } from './studio-fixture.mjs';
import { createNav } from './nav.mjs';
import { roomOf } from './world.mjs';
import { cutOf } from './memory/diary.mjs';
import { compare as compareVar } from './rules.mjs';

const DIR = path.join(LAB_DIR, 'scenarios');
export const listScenarios = () => readdirSync(DIR).filter(f => f.endsWith('.json')).sort().map(f => loadScenario(f.slice(0, -5)));
export function loadScenario(id) {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`剧本 id 不合法：${id}`);
  return JSON.parse(readFileSync(path.join(DIR, `${id}.json`), 'utf8'));
}

/** sha256 of every file under the given lab folders (sorted), so a run export says exactly which code ran. */
function versionHash(parts) {
  const h = createHash('sha256');
  const walk = d => readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const p of parts) for (const f of (p.endsWith('/') ? walk(path.join(LAB_DIR, p)) : [path.join(LAB_DIR, p)])) h.update(path.relative(LAB_DIR, f)).update(readFileSync(f));
  return h.digest('hex').slice(0, 16);
}

/** Counted separately on purpose: a skipped or not-yet-judged step is not a pass. */
export function summarize(results) {
  const expects = results.filter(r => r.kind === 'expect');
  return {
    auto_pass: expects.filter(r => r.ok === true).length,
    auto_fail: results.filter(r => r.ok === false).length,
    skipped: results.filter(r => r.skip).length,
    review_pending: results.filter(r => r.review).length
  };
}

/**
 * G1–G6 for one committed turn (PLAN §8.2), as a list of problems ([] = fine). Shared by the scenario runner and
 * the simulated user (D8). deletedTexts: texts the user had deleted, which must never come back into a prompt.
 */
export function turnProblems(lab, saveId, turnId, deletedTexts = new Set()) {
  const { db, ledger } = lab;
  const s = saveId;
  const row = db.prepare('SELECT * FROM turns WHERE id = ?').get(turnId);
  if (!row) return ['找不到这一轮'];
  const sections = pj(row.sections_json, []);
  const full = pj(row.prompt_json, []).map(m => m.content).join('\n');
  const output = pj(row.output_json, {});
  const problems = [];
  if (bannedIn(output.delivered ?? output.say).length) problems.push('G1 回复里有禁用说法');
  const hints = sections.find(x => x.name === 'hints')?.refs || [];
  const userEv = ledger.get(s, row.user_seq);
  for (const ref of hints) {
    const prior = db.prepare('SELECT 1 FROM mentions WHERE save_id = ? AND character_id = ? AND memory_ref = ? AND seq < ? AND t > ?').get(s, row.character_id, ref, row.user_seq, userEv.t - 3 * 86400000);
    if (prior) problems.push(`G2 ${ref} 3 天内提过还被当成 hint`);
    const info = lab.admission.lookup(s, ref);
    const bad = !info || (info.kind === 'fact' && (info.row.status !== 'active' || info.row.sensitivity === 'private')) || (info.kind === 'cache' && info.row.invalid);
    if (bad) problems.push(`G2 ${ref} 不该当 hint`);
  }
  const refs = new Set(sections.flatMap(x => x.refs));
  for (const u of output.used || []) if (!refs.has(u)) problems.push(`G3 用到了上下文里没有的 ${u}`);
  for (const ref of refs) {
    const { kind, id } = parseRef(ref);
    if (kind === 'ev' && ledger.get(s, Number(id))?.tombstone) problems.push(`G4 上下文引用了已删除的 ${ref}`);
  }
  for (const t of deletedTexts) if (full.includes(t)) problems.push('G4 上下文里出现了已删除的原文');
  if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') problems.push('G5 数据库完整性检查失败');
  // G6 (2.0 D-gate): what she said about herself contradicts something she said before, even after one retry.
  const selfConflict = pj(row.rejected_json, {})?.self_conflict;
  if (selfConflict?.length) problems.push(`G6 和她以前说的说反了：${selfConflict.map(c => `「${c.text}」`).join('')}`);
  return problems;
}

/** "2026-10-20" for world day 1 (the day the world starts), and so on. */
const dayOfWorld = n => new Date(WORLD_START + (n - 1) * DAY + 9 * 3600_000).toISOString().slice(0, 10);

/** 3.0 G5: "现在" → null (now), "第2天 05:00" → that world time. */
function whenOf(text) {
  if (text == null || text === '现在') return null;
  const m = /^第(\d+)天\s*(\d{1,2}:\d{2})$/.exec(String(text).trim());
  if (!m) throw new Error(`看不懂的时间：${text}（写「现在」或「第2天 05:00」）`);
  // A calendar time (第2天 03:00 is the small hours of day 2's date, before its 05:00 morning).
  const day = dayOfWorld(Number(m[1]));
  return { day, t: Date.parse(`${day}T${m[2].padStart(5, '0')}:00+09:00`) };
}
const GIVES = ['分享', '提议', '逗', '安慰'];

const getPath = (o, dotted) => dotted.split('.').reduce((x, k) => (x == null ? x : x[k]), o);

// 2.0 D7: three-arm runs. Each arm is its own save whose delivered replies use that context mode, start to end.
export const ARMS = ['memory', 'full', 'none'];
export const ARM_TITLES = { memory: '记忆', full: '全量对话', none: '短上下文' };

export function createScenarios(lab) {
  const { db, ledger } = lab;
  const runs = new Map(); // in-memory run state: id → { scenario, saveId, provider, step, results, last, deletedTexts }

  const inflight = new Map(); // requestId → promise of the run started for it

  function persist(run) {
    db.prepare(`INSERT INTO scenario_runs (id, scenario_id, save_id, provider, step, state, results_json, real_at, request_id, arm, arm_group) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET step = excluded.step, state = excluded.state, results_json = excluded.results_json`)
      .run(run.id, run.scenario.id, run.saveId, run.provider, run.step, run.state, j(run.results), run.real_at, run.requestId ?? null, run.arm ?? null, run.armGroup ?? null);
  }

  /** A run as stored (after a restart the in-memory state is gone; the row is still the record). */
  function rowView(row) {
    let scenario = null;
    try { scenario = loadScenario(row.scenario_id); } catch { /* scenario file removed */ }
    const results = pj(row.results_json, []);
    return { id: row.id, scenarioId: row.scenario_id, title: scenario?.title || row.scenario_id, saveId: row.save_id, provider: row.provider, step: row.step, total: scenario?.steps.length ?? row.step, state: row.state, results, summary: summarize(results), real_at: row.real_at, arm: row.arm ?? null, armGroup: row.arm_group ?? null };
  }
  const get = id => {
    if (runs.has(id)) return view(runs.get(id));
    const row = db.prepare('SELECT * FROM scenario_runs WHERE id = ?').get(id);
    return row ? rowView(row) : null;
  };

  /**
   * Starts a run (all steps unless stepOnly). The same requestId never starts a second run: a resent or doubled
   * request gets the first one's result (still running → the same promise). No requestId = always a new run.
   */
  async function start(id, { provider = 'mock', requestId = null, stepOnly = false } = {}) {
    if (requestId != null && (typeof requestId !== 'string' || !/^[\w-]{1,64}$/.test(requestId))) throw new Error('requestId 不合法');
    if (requestId) {
      if (inflight.has(requestId)) return inflight.get(requestId);
      const row = db.prepare('SELECT * FROM scenario_runs WHERE request_id = ?').get(requestId);
      if (row) return get(row.id);
    }
    const run = create(id, { provider, requestId });
    const work = stepOnly ? Promise.resolve(run) : runAll(run.id);
    if (requestId) { inflight.set(requestId, work); work.finally(() => inflight.delete(requestId)).catch(() => {}); }
    return work;
  }

  function create(id, { provider = 'mock', requestId = null, arm = null, armGroup = null, features = null } = {}) {
    const loaded = loadScenario(id);
    const scenario = features ? { ...loaded, features } : loaded; // 3.0 G6: eval --features
    if (arm != null && !ARMS.includes(arm)) throw new Error(`不认识的回复方式：${arm}`);
    const save = lab.saves.createSave({ name: `剧本·${scenario.title.split('：')[0]}${arm ? `·${ARM_TITLES[arm]}` : ''}`, sceneId: scenario.scene, userName: scenario.user_name });
    if (arm) db.prepare('UPDATE saves SET reply_mode = ? WHERE id = ?').run(arm, save.id);
    // 3.0 E4: a scenario turns on only the 3.0 features it names (none by default, so old scenarios stay 2.0).
    if (scenario.features) lab.setFeatures(save.id, { ...scenario.features, ...(scenario.director_random === false ? { director_random: false } : {}) });
    if (scenario.features?.world) lab.environment.tick(save.id); // 3.0 G5: the world starts with the save, not at the first session

    if (provider === 'mock') lab.mockSaves.add(save.id);
    const run = { id: newId('r'), scenario, saveId: save.id, provider, requestId, arm, armGroup, step: 0, state: 'running', results: [], last: null, deletedTexts: new Set(), busy: null, real_at: realNow() };
    runs.set(run.id, run);
    persist(run);
    return view(run);
  }

  const view = run => ({ id: run.id, scenarioId: run.scenario.id, title: run.scenario.title, saveId: run.saveId, provider: run.provider, step: run.step, total: run.scenario.steps.length, state: run.state, results: run.results, summary: summarize(run.results), real_at: run.real_at, arm: run.arm ?? null, armGroup: run.armGroup ?? null });

  /** The committed turn of the last `say`, plus its compare turns. */
  function lastTurn(run) {
    if (!run.last) return null;
    const t = db.prepare('SELECT * FROM turns WHERE id = ?').get(run.last.turnId);
    if (!t) return null;
    const sections = pj(t.sections_json, []);
    const prompt = pj(t.prompt_json, []);
    return { row: t, sections, full: prompt.map(m => m.content).join('\n'), output: pj(t.output_json, {}), compare: run.last.compare || {} };
  }

  function section(turn, name) { return turn?.sections.find(s => s.name === name) || null; }

  /** Returns { ok, detail } | { skip: true } */
  function check(run, exp) {
    const s = run.saveId;
    const turn = lastTurn(run);
    const say = turn?.output?.delivered ?? turn?.output?.say ?? ''; // what the user actually got
    if (exp.live_only && run.provider !== 'live') return { skip: true, detail: '仅真模型' };
    if (exp.pending) return { skip: true, detail: `待 ${exp.pending}` };
    if (exp.thought_not_stored) {
      // Every thought this save produced must exist only in turns.thought (PLAN-2.0 B4).
      const thoughts = db.prepare('SELECT thought FROM turns WHERE save_id = ? AND thought IS NOT NULL').all(s).map(r => r.thought);
      const tables = [['events', 'payload_json'], ['user_facts', "object || ' ' || evidence"], ['caches', 'text'], ['self_canon', 'text'], ['commitments', 'text'], ['turns', "sections_json || prompt_json || coalesce(output_json, '')"]];
      const hits = [];
      for (const th of thoughts) for (const [t, col] of tables) if (db.prepare(`SELECT count(*) n FROM ${t} WHERE save_id = ? AND instr(${col}, ?) > 0`).get(s, th).n) hits.push(t);
      return { ok: !hits.length, detail: !thoughts.length ? '这些轮次没有内心' : hits.length ? `内心出现在：${[...new Set(hits)].join('，')}` : `${thoughts.length} 条内心只在 turns.thought` };
    }
    if (exp.fact) {
      const f = exp.fact;
      // predicate may be a list (["name", "call_me"]): the real model files a name under either; left out = any predicate.
      const preds = f.predicate == null ? [] : [].concat(f.predicate);
      const rows = db.prepare(`SELECT * FROM user_facts WHERE save_id = ? AND character_id = ? AND status = ?${preds.length ? ` AND predicate IN (${preds.map(() => '?').join(', ')})` : ''}`).all(s, f.character, f.status, ...preds);
      const ok = rows.some(r => r.object.includes(f.object_contains));
      const p = preds.join('/') || '事实';
      return { ok, detail: ok ? `有 ${p}「${f.object_contains}」(${f.status})` : `没有 ${p} 含「${f.object_contains}」且状态 ${f.status} 的事实` };
    }
    if (exp.event) {
      const e = exp.event;
      const n = ledger.list(s, { all: true }).filter(ev => ev.type === e.type
        && (e.actor == null || ev.actor === e.actor) && (e.action == null || ev.action === e.action) && (e.target == null || ev.target === e.target)
        && (e.outcome == null || ev.outcome === e.outcome) && (e.offscreen == null || ev.offscreen === e.offscreen)
        && (e.op == null || ev.payload?.op === e.op) && (e.tombstoned == null || Boolean(ev.tombstone) === e.tombstoned)
        && (e.routine == null || Boolean(ev.payload?.routine) === e.routine) && (e.idle == null || Boolean(ev.payload?.idle) === e.idle)
        && (e.perceivers_exclude == null || !ev.perceivers.includes(e.perceivers_exclude))).length;
      const min = e.min ?? 1, max = e.max ?? Infinity;
      return { ok: n >= min && n <= max, detail: `符合条件的 ${e.type} 有 ${n} 条（要求 ${min}–${max === Infinity ? '∞' : max}）` };
    }
    if (exp.state) {
      const v = getPath(ledger.world(s).objects[exp.state.object], exp.state.field);
      return { ok: v === exp.state.equals, detail: `${exp.state.object}.${exp.state.field} = ${JSON.stringify(v)}` };
    }
    // 2.0 C6.
    if (exp.room_of) {
      const v = roomOf(ledger.world(s), exp.room_of.who);
      return { ok: v === exp.room_of.equals, detail: `${exp.room_of.who} 在 ${v ?? '（不知道）'}` };
    }
    if (exp.path_ok) {
      // Every walked action of the last turn has a path, and the path keeps clear of everything but its target.
      const evs = run.last ? ledger.list(s, { after: lastTurn(run)?.row.user_seq ?? 0, types: ['char_action'], all: true }).filter(e => e.outcome === 'ok' && e.payload?.path) : [];
      if (!evs.length) return { ok: false, detail: '上一轮没有带路径的动作' };
      const scene = lab.scene(s), state = ledger.world(s);
      const bad = evs.filter(e => e.payload.path.length > 1 && !createNav(scene, state, { ignore: [e.target] }).pathClear(e.payload.path));
      return { ok: !bad.length, detail: bad.length ? `${bad.map(e => e.action).join('、')} 的路穿过了东西` : `${evs.map(e => `${e.action}（${e.payload.path.length} 个点）`).join('、')} 的路都绕开了` };
    }
    if (exp.commitment) {
      const c = exp.commitment;
      const rows = lab.commitments.list(s, c.character, c.status || 'open').filter(k => (!c.text_contains || k.text.includes(c.text_contains)) && (!c.owner || k.owner === c.owner));
      const due = k => (k.due_at == null ? null : formatWorldTime(k.due_at));
      const hit = rows.find(k => !c.due_contains || (due(k) || '').includes(c.due_contains));
      return { ok: Boolean(hit), detail: hit ? `约定「${hit.text}」到期 ${due(hit) ?? '（没写）'}` : `没有符合条件的约定（${rows.map(k => `${k.text}@${due(k)}`).join('；') || '一条都没有'}）` };
    }
    if (exp.relationship) {
      const v = lab.relationship.compute(s, exp.relationship.character)[exp.relationship.field];
      return { ok: v === exp.relationship.equals, detail: `${exp.relationship.field} = ${v}` };
    }
    if (exp.forget_job) {
      const f = exp.forget_job;
      const job = lab.forget.list(s).filter(x => x.verb === f.verb).at(-1);
      if (!job) return { ok: false, detail: `没有 ${f.verb} 任务` };
      const seqs = Array.isArray(job.candidates?.seqs) ? job.candidates.seqs.length : Number(job.candidates?.seqs || 0);
      const ok = job.state === f.state && (f.seqs_min == null || seqs >= f.seqs_min);
      return { ok, detail: `任务状态 ${job.state}，事件 ${seqs} 条` };
    }
    // 2.0 D9: diaries and where a fact came from.
    if (exp.diary_exists) {
      const d = exp.diary_exists;
      const day = typeof d.day === 'number' ? dayOfWorld(d.day) : d.day;
      const hit = lab.diary.live(s, d.character).find(x => x.day === day);
      return { ok: Boolean(hit), detail: hit ? `${day} 的日记：${hit.text.slice(0, 40)}` : `没有 ${day} 的日记（有：${lab.diary.live(s, d.character).map(x => x.day).join('、') || '一篇都没有'}）` };
    }
    if (exp.diary_refs_ok) {
      // Every live diary cites only events of its own day that still exist and are not forgotten.
      const charId = exp.diary_refs_ok.character;
      const gone = lab.admission.forgottenSet(s, charId);
      const diaries = lab.diary.live(s, charId);
      const bad = [];
      for (const d of diaries) {
        const seqs = d.derived_from || [];
        if (!seqs.length) bad.push(`${d.day} 没有引用`);
        for (const seq of seqs) {
          const ev = ledger.get(s, seq);
          if (!ev?.payload || ev.tombstone || gone.has(seq)) bad.push(`${d.day} 引用了没了的 ev:${seq}`);
          else if (!(ev.t > cutOf(d.day) - DAY && ev.t <= cutOf(d.day))) bad.push(`${d.day} 引用了别的日子的 ev:${seq}`);
        }
      }
      return { ok: diaries.length > 0 && !bad.length, detail: !diaries.length ? '一篇日记都没有' : bad.length ? bad.join('；') : `${diaries.length} 篇日记的引用都在当天、都还在` };
    }
    if (exp.diary_not_contains) {
      const { character, texts } = exp.diary_not_contains;
      const hit = lab.diary.live(s, character).filter(d => texts.some(t => d.text.includes(t) || (d.intention || '').includes(t)));
      return { ok: !hit.length, detail: hit.length ? `${hit.map(d => d.day).join('、')} 的日记还有要排除的字` : '现有日记里都没有' };
    }
    if (exp.known_how) {
      const k = exp.known_how;
      const rows = db.prepare("SELECT object, known_how FROM user_facts WHERE save_id = ? AND character_id = ? AND status = 'active'").all(s, k.character).filter(r => r.object.includes(k.object_contains));
      const ok = rows.some(r => (r.known_how || 'told') === k.equals);
      return { ok, detail: rows.length ? rows.map(r => `「${r.object}」${r.known_how || 'told'}`).join('；') : `没有含「${k.object_contains}」的事实` };
    }
    if (exp.idle_said) {
      const n = ledger.list(s, { types: ['char_said'], all: true }).filter(e => e.payload?.idle).length;
      const min = exp.idle_said.min ?? 0, max = exp.idle_said.max ?? Infinity;
      return { ok: n >= min && n <= max, detail: `空闲开口 ${n} 次（要求 ${min}–${max === Infinity ? '∞' : max}）` };
    }
    // 3.0 G5: the world's own records.
    if (exp.incident) {
      const { id, phase, by } = exp.incident;
      const evs = ledger.list(s, { types: ['incident'], all: true }).filter(e => e.payload?.incident === id);
      const hit = evs.find(e => (!phase || e.payload.phase === phase) && (!by || e.payload.by === by));
      return { ok: Boolean(hit), detail: evs.length ? `${id}：${evs.map(e => `${e.payload.phase}${e.payload.by ? `（${e.payload.by}）` : ''}`).join('、')}` : `没有 ${id} 的记录` };
    }
    if (exp.var) {
      const { name, ...want } = exp.var;
      const v = ledger.world(s).vars?.[name];
      const cond = 'equals' in want ? v === want.equals || JSON.stringify(v) === JSON.stringify(want.equals) : compareVar(v, want, {});
      return { ok: Boolean(cond), detail: `${name} = ${JSON.stringify(v)}` };
    }
    if (exp.practice) {
      const { id, phase } = exp.practice;
      const evs = ledger.list(s, { types: ['practice'], all: true }).filter(e => !id || e.payload?.practice === id);
      return { ok: evs.some(e => !phase || e.payload.phase === phase), detail: evs.length ? evs.map(e => `${e.payload.practice} ${e.payload.phase}`).join('、') : '没有共同活动的记录' };
    }
    if (exp.bet) {
      const evs = ledger.list(s, { types: ['bet'], all: true });
      const ok = evs.some(e => (!exp.bet.phase || e.payload.phase === exp.bet.phase) && (!exp.bet.winner || e.payload.winner === exp.bet.winner));
      return { ok, detail: evs.length ? evs.map(e => `${e.payload.phase}${e.payload.winner ? ` ${e.payload.winner}` : ''}`).join('、') : '没有打赌的记录' };
    }
    if (exp.map_has) {
      const m = (ledger.world(s).vars?.map || []).find(x => x.find === exp.map_has.find);
      const ok = Boolean(m) && (exp.map_has.sure == null || m.sure === exp.map_has.sure);
      return { ok, detail: m ? `地图上有 ${m.find}「${m.note}」${m.sure ? '' : '（问号）'}` : `地图上没有 ${exp.map_has.find}` };
    }
    if (exp.session_voice) {
      // The replies of the session that just ended (or is going on): tics, three 打听 in a row, how often she gives something.
      const v = exp.session_voice;
      const from = ledger.list(s, { types: ['session_start'], desc: true, limit: 1 })[0]?.seq ?? 0;
      const rows = db.prepare('SELECT output_json, intent FROM turns WHERE save_id = ? AND committed = 1 AND user_seq > ? ORDER BY rowid').all(s, from);
      const says = rows.map(r => { const o = pj(r.output_json, {}); return o.delivered ?? o.say ?? ''; });
      const bad = [];
      for (const [tic, max] of Object.entries(v.tic_max || {})) { const n = says.filter(x => x.includes(tic)).length; if (n > max) bad.push(`「${tic}」${n} 次`); }
      const intents = rows.map(r => r.intent || '回应');
      if (v.no_nagging && intents.some((x, i) => x === '打听' && intents[i + 1] === '打听' && intents[i + 2] === '打听')) bad.push('连着三句在打听');
      const give = intents.length ? intents.filter(x => GIVES.includes(x)).length / intents.length : 0;
      if (v.give_rate_min != null && give < v.give_rate_min) bad.push(`给东西的句子只占 ${Math.round(give * 100)}%`);
      return { ok: rows.length > 0 && !bad.length, detail: !rows.length ? '这次会话没有回复' : bad.length ? bad.join('；') : `${rows.length} 句，给东西的占 ${Math.round(give * 100)}%` };
    }
    if (!turn && Object.keys(exp).some(k => /^(context|hint|reply|compare|lore|mood|topic)/.test(k))) return { ok: false, detail: '还没有对话轮次' };
    if (exp.topic_in_context) {
      // An id, or { any: [ids] } / { prefix: 't_sign_' }.
      const want = exp.topic_in_context;
      const refs = section(turn, 'topic')?.refs || [];
      const ids = refs.map(r => r.replace(/^topic:/, ''));
      const ok = typeof want === 'string' ? ids.includes(want) : want.prefix ? ids.some(x => x.startsWith(want.prefix)) : ids.some(x => (want.any || []).includes(x));
      return { ok, detail: ids.length ? `话头：${ids.join('、')}` : '这一轮没有话头' };
    }
    if (exp.lore_in_context || exp.lore_not_in_context) {
      const id = exp.lore_in_context || exp.lore_not_in_context;
      const has = Boolean(section(turn, 'lore')?.refs.includes(`lore:${id}`));
      const ok = exp.lore_in_context ? has : !has;
      return { ok, detail: `过往 ${id} ${has ? '在' : '不在'}上下文里` };
    }
    if (exp.mood_is) { const m = turn.output.mood ?? null; return { ok: m === exp.mood_is, detail: `情绪：${m ?? '（没有）'}` }; }
    if (exp.context_section_contains) {
      const { section: name, text, any } = exp.context_section_contains;
      const ok = [].concat(any ?? text).some(x => Boolean(section(turn, name)?.text.includes(x)));
      return { ok, detail: ok ? `「${name}」节包含要求的文字` : `「${name}」节${section(turn, name) ? '不包含' : '不存在，也就不包含'}要求的文字` };
    }
    if (exp.context_section_excludes) {
      const { section: name, text } = exp.context_section_excludes;
      const ok = !section(turn, name)?.text.includes(text);
      return { ok, detail: ok ? `「${name}」节不含要求排除的文字` : `「${name}」节含有要求排除的文字` };
    }
    if (exp.context_contains) { const miss = exp.context_contains.filter(t => !turn.full.includes(t)); return { ok: !miss.length, detail: miss.length ? `上下文缺 ${miss.length} 处` : '上下文都包含' }; }
    if (exp.context_contains_any) { const ok = exp.context_contains_any.some(t => turn.full.includes(t)); return { ok, detail: ok ? `上下文包含：${exp.context_contains_any.filter(t => turn.full.includes(t)).join('、')}` : '上下文一个都不包含' }; }
    if (exp.context_excludes) { const hit = exp.context_excludes.filter(t => turn.full.includes(t)); return { ok: !hit.length, detail: hit.length ? `上下文出现了 ${hit.length} 处不该出现的文字` : '上下文都不包含' }; }
    if (exp.hint_refs_min != null) { const n = section(turn, 'hints')?.refs.length || 0; return { ok: n >= exp.hint_refs_min, detail: `hints ${n} 条` }; }
    if (exp.hint_rule) {
      const n = (section(turn, 'hints')?.why || '').split('、').filter(r => r === exp.hint_rule).length;
      return { ok: n >= (exp.min ?? 1), detail: `来自 ${exp.hint_rule} 的 hint ${n} 条` };
    }
    if (exp.hints_exclude_text) {
      const h = section(turn, 'hints');
      const texts = [h?.text || '', ...(h?.refs || []).map(r => lab.admission.lookup(s, r)?.text || '')].join('\n');
      const hit = exp.hints_exclude_text.filter(t => texts.includes(t));
      return { ok: !hit.length, detail: hit.length ? 'hints 里出现了要排除的话题' : 'hints 不含要排除的话题' };
    }
    if (exp.no_repeat_proactive_within) {
      const win = parseDuration(exp.no_repeat_proactive_within);
      const rows = db.prepare('SELECT memory_ref, t FROM mentions WHERE save_id = ? AND proactive = 1 ORDER BY t').all(s);
      const bad = rows.filter((r, i) => rows.slice(0, i).some(p => p.memory_ref === r.memory_ref && r.t - p.t <= win));
      return { ok: !bad.length, detail: `主动提起 ${rows.length} 次，重复 ${bad.length} 次` };
    }
    if (exp.db_text_absent) {
      const tables = [['events', 'payload_json'], ['user_facts', "object || ' ' || evidence"], ['rejected_facts', 'candidate_json'], ['caches', "text || ' ' || coalesce(intention, '')"], ['commitments', 'text'], ['self_canon', 'text'], ['turns', "sections_json || prompt_json || coalesce(output_json, '') || coalesce(rejected_json, '')"], ['forget_jobs', "topic || candidates_json || coalesce(applied_json, '')"]];
      const hits = [];
      for (const [t, col] of tables) for (const text of exp.db_text_absent) {
        const n = db.prepare(`SELECT count(*) n FROM ${t} WHERE save_id = ? AND instr(${col}, ?) > 0`).get(s, text).n;
        if (n) hits.push(`${t}:${n}`);
      }
      return { ok: !hits.length, detail: hits.length ? `还能搜到：${hits.join('，')}` : '数据库里搜不到' };
    }
    if (exp.reply_contains_any) { const ok = exp.reply_contains_any.some(t => say.includes(t)); return { ok, detail: `回复：${say.slice(0, 40)}` }; }
    if (exp.reply_not_contains) { const ok = !exp.reply_not_contains.some(t => say.includes(t)); return { ok, detail: `回复：${say.slice(0, 40)}` }; }
    if (exp.compare) {
      const c = turn.compare[exp.compare.mode];
      if (!c) return { ok: false, detail: `这一轮没有 ${exp.compare.mode} 对照` };
      const ok = !(exp.compare.reply_not_contains || []).some(t => c.say.includes(t));
      return { ok, detail: `${exp.compare.mode}：${c.say.slice(0, 40)}` };
    }
    return { ok: false, detail: `不认识的断言：${Object.keys(exp).join(',')}` };
  }

  /** G1–G6 after every say (PLAN §8.2). */
  function invariants(run, result) {
    const problems = turnProblems(lab, run.saveId, run.last.turnId, run.deletedTexts);
    if (problems.length) { result.ok = false; result.detail = `${result.detail}；${problems.join('；')}`; }
  }

  /** One step. A step asked for while another is in flight joins it instead of running a second one. */
  function step(runId) {
    const run = runs.get(runId);
    if (!run) return Promise.reject(new Error('找不到这次剧本运行（应用重启过？请重新运行）'));
    if (run.busy) return run.busy;
    run.busy = doStep(run).finally(() => { run.busy = null; });
    return run.busy;
  }

  async function doStep(run) {
    if (run.state !== 'running' && run.state !== 'paused') return view(run);
    const st = run.scenario.steps[run.step];
    if (!st) { finish(run); return view(run); }
    const s = run.saveId;
    const result = { step: run.step, kind: Object.keys(st).find(k => !['mock', 'to', 'compare', 'live_only', 'note'].includes(k)), ok: true, detail: '' };
    if (st.say) result.input = st.say;
    try {
      if (run.provider === 'mock' && st.mock) for (const [purpose, obj] of Object.entries(st.mock)) for (const o of [].concat(obj)) lab.llm.mock.enqueue(purpose, o);
      if (st.session === 'start') { await lab.session.start(s); result.detail = '会话开始'; }
      else if (st.session === 'end') { lab.session.end(s); result.detail = '会话结束'; }
      else if (st.advance) { lab.session.advance(s, st.advance); result.detail = `时间前进 ${st.advance}`; }
      // 2.0 D5: test saves only — the relationship never goes below this stage.
      else if (st.set_relationship_floor) { lab.relationship.setFloor(s, st.set_relationship_floor); lab.relationship.sync(s, st.character || lab.scene(s).characters[0].id); result.detail = `关系至少 ${st.set_relationship_floor}`; }
      // 2.0 D9: n session ticks (5 world minutes each), or a stretch of real quiet on a pretend clock: a tick every
      // 45 real seconds, so idle moments run as they would in the app (the first minute after a line is still "quiet").
      else if (st.tick != null || st.idle_real) {
        const n = st.tick ?? Math.max(1, Math.ceil(parseDuration(st.idle_real) / 45_000));
        let spoke = 0, routine = 0;
        for (let i = 0; i < n; i++) {
          if (st.idle_real) run.realOffset = (run.realOffset || 0) + 45_000;
          const r = await lab.session.tick(s, { now: realNow() + (run.realOffset || 0) });
          for (const x of r.idle || []) if (x.spoke) { spoke++; lab.proactive.recordDelivered(x.turnId); }
          routine += r.events.filter(e => e.payload?.routine).length;
        }
        result.detail = `${st.tick != null ? `推进 ${n} 次` : `安静 ${st.idle_real}（${n} 次）`}：作息动作 ${routine} 条，空闲开口 ${spoke} 次`;
      }
      else if (st.wait_jobs) { await lab.jobs.idle(s); result.detail = '后台任务完成'; }
      // 3.0 G5: the world on cue. A morning ahead is kept in vars.weather_overrides; "现在" turns it right away.
      else if (st.force_weather) {
        const w = whenOf(st.force_weather.when);
        if (!w) lab.worldsim.forceWeather(s, st.force_weather.kind, '剧本');
        else lab.worldsim.setVar(s, 'weather_overrides', { ...(ledger.world(s).vars?.weather_overrides || {}), [w.day]: st.force_weather.kind }, '剧本', lab.clock.now(s));
        result.detail = `天气：${st.force_weather.when || '现在'} ${st.force_weather.kind}`;
      } else if (st.force_incident) {
        const w = whenOf(st.force_incident.at);
        const evs = w ? lab.director.schedule(s, st.force_incident.id, w.t) : lab.director.force(s, st.force_incident.id);
        result.detail = `意外 ${st.force_incident.id}：${w ? `排在 ${st.force_incident.at}` : '现在开始'}（${evs.length} 条事件）`;
      } else if (st.scout) {
        lab.scout.book(s, st.scout.dir);
        const plan = ledger.world(s).vars.scout_plan;
        if (st.scout.finds) lab.worldsim.setVar(s, 'scout_plan', { ...plan, finds: st.scout.finds }, '剧本', lab.clock.now(s));
        result.detail = `预约 ${plan.day} 去${st.scout.dir}${st.scout.finds ? `（看见 ${st.scout.finds.join('、')}）` : ''}`;
      }
      else if (st.import_studio != null || st.studio_edit != null) {
        // 2.0 C6: import from a fixture studio (the first, or a later layout as "the user built something").
        if (!lab.savesDir) { const tmp = mkdtempSync(path.join(os.tmpdir(), 'memory-lab-scenario-')); lab.savesDir = path.join(tmp, 'saves'); lab.assetsDir = path.join(tmp, 'assets'); }
        const { fetchImpl, state } = fixtureStudio(st.import_studio ?? st.studio_edit);
        const out = await importStudio(lab, { saveId: s, sceneAssetId: FIXTURE_SCENE, base: 'http://fixture.studio', assetsDir: lab.assetsDir, fetchImpl, state });
        result.detail = `${st.import_studio != null ? '导入' : '再导入'}造物台 fixture ${st.import_studio ?? st.studio_edit}：${out.scene.objects.length} 个物件，改动 ${out.edits.length} 处`;
      }
      else if (st.act) { const evs = lab.turns.act(s, st.act); result.detail = `${st.act.action} ${st.act.target}（${evs.length} 条事件）`; }
      else if (st.say) {
        const r = await lab.turns.runTurn({ saveId: s, charId: st.to, text: st.say, compare: Boolean(st.compare) });
        run.realOffset = 0; // the user just spoke: the pretend real clock starts again from now
        lab.proactive.recordDelivered(r.turnId);
        run.last = { turnId: r.turnId, compare: r.compare };
        result.detail = `${st.to}：${(r.reply.delivered ?? r.reply.say).slice(0, 40)}`;
        result.turnId = r.turnId;
        // The whole reply is kept with the step, so a run can be read back without re-running it.
        result.reply = r.reply.delivered ?? r.reply.say;
        if (r.reply.action) result.action = Array.isArray(r.reply.action)
          ? { name: r.reply.action.map(a => a.name).join('→'), target: r.reply.action.map(a => a.target || '').join('→'), result: r.reply.actionResult }
          : { ...r.reply.action, result: r.reply.actionResult };
        if (r.reply.error) result.replyError = r.reply.error;
        if (r.compare) result.compare = Object.fromEntries(Object.entries(r.compare).map(([m, c]) => [m, c.say]));
        invariants(run, result);
      } else if (st.confirm_forget) {
        await lab.jobs.idle(s);
        const job = lab.forget.list(s).filter(x => x.state === 'proposed').at(-1);
        if (!job) throw new Error('没有待确认的忘记任务');
        if (job.verb === 'delete') for (const seq of job.candidates.seqs || []) { const t = ledger.get(s, seq)?.payload?.text; if (t) run.deletedTexts.add(t); }
        await lab.forget.confirm(job.id);
        await lab.jobs.idle(s);
        result.detail = `确认${job.verb}，状态 ${lab.forget.getJob(job.id).state}`;
      } else if (st.pending) {
        // A step that needs a later task (e.g. set_relationship_floor before D5): recorded as skipped, not a pass.
        result.skip = true; result.ok = null; result.detail = `待 ${st.pending}：${st.note || ''}`;
      } else if (st.review) {
        // A question only a person can answer (is it natural? is the source right?). Recorded, never counted as a pass.
        const turn = lastTurn(run);
        result.ok = null; result.review = true;
        result.detail = `待人工判读：${st.review}`;
        result.reply = turn ? (turn.output.delivered ?? turn.output.say) : null;
      } else if (st.expect) {
        const r = check(run, { ...st.expect, live_only: st.expect.live_only || st.live_only });
        if (r.skip) { result.skip = true; result.ok = null; }
        else result.ok = r.ok;
        result.detail = r.detail;
        result.expect = st.expect;
      } else throw new Error(`不认识的步骤：${JSON.stringify(st)}`);
    } catch (e) {
      result.ok = false; result.error = true; result.detail = e.message;
    }
    run.results.push(result);
    run.step++;
    if (result.error) run.state = 'error';
    else if (run.step >= run.scenario.steps.length) finish(run);
    persist(run);
    return view(run);
  }

  function finish(run) {
    if (run.state === 'error') return;
    run.state = run.results.some(r => r.ok === false) ? 'failed' : 'passed';
    persist(run);
  }

  async function runAll(runId) {
    let v = view(runs.get(runId));
    while (v.state === 'running') v = await step(runId);
    return v;
  }

  /** Past runs, newest first (they survive restarts: scenario_runs is the record). */
  const history = (limit = 30) => db.prepare('SELECT * FROM scenario_runs ORDER BY real_at DESC, rowid DESC LIMIT ?').all(limit).map(r => (runs.has(r.id) ? view(runs.get(r.id)) : rowView(r)));

  /** Everything needed to read a run later or elsewhere: versions, settings without the key, model ids, failures. */
  function exportRun(id, settings = {}) {
    const run = get(id);
    if (!run) return null;
    const calls = db.prepare('SELECT purpose, provider, model, stage, attempt, logical_id, input_tokens, cached_tokens, output_tokens, usage_known, cost_usd, latency_ms, finish_reason, error, real_at FROM llm_calls WHERE save_id = ? ORDER BY real_at, attempt').all(run.saveId);
    const { keySet, ...safeSettings } = settings; // never the key itself; keySet only says whether one was set
    return {
      exported_at: realNow(), run,
      versions: { code: versionHash(['index.mjs', 'server/', 'lib/']), prompts: versionHash(['prompts/']), contracts: versionHash(['contracts/']), scenario: versionHash([`scenarios/${run.scenarioId}.json`]), scene: versionHash(['scenes/', 'characters/']) },
      settings: { ...safeSettings, key_set: Boolean(keySet) },
      cards: lab.scene(run.saveId).characters.map(c => { const v = lab.cards.current(run.saveId, c.id); return { id: c.id, version: v.version, hash: v.hash }; }),
      served_models: [...new Set(calls.map(c => c.model))],
      event_cutoff: ledger.lastSeq(run.saveId),
      failures: run.results.filter(r => r.ok === false),
      review_pending: run.results.filter(r => r.review),
      calls
    };
  }

  /**
   * 2.0 D7: the same scenario three times, one save per arm. The arms run one after another (mock answers are queued
   * per purpose, not per save, so running them side by side would hand one arm's answers to another).
   */
  async function startArms(id, { provider = 'mock', requestId = null } = {}) {
    if (requestId != null && (typeof requestId !== 'string' || !/^[\w-]{1,64}$/.test(requestId))) throw new Error('requestId 不合法');
    if (requestId) {
      if (inflight.has(requestId)) return inflight.get(requestId);
      const row = db.prepare('SELECT arm_group FROM scenario_runs WHERE request_id = ?').get(`${requestId}-memory`);
      if (row) return arms(row.arm_group);
    }
    const group = newId('g');
    const made = ARMS.map(arm => create(id, { provider, arm, armGroup: group, requestId: requestId ? `${requestId}-${arm}` : null }));
    const work = (async () => { for (const r of made) await runAll(r.id); return arms(group); })();
    if (requestId) { inflight.set(requestId, work); work.finally(() => inflight.delete(requestId)).catch(() => {}); }
    return work;
  }

  /** The side-by-side page: one row per say (and per review), the three replies next to each other, plus notes. */
  function arms(group) {
    const rows = db.prepare('SELECT * FROM scenario_runs WHERE arm_group = ? ORDER BY real_at, rowid').all(group);
    if (!rows.length) return null;
    const runsBy = Object.fromEntries(rows.map(r => [r.arm, get(r.id)]));
    let scenario = null;
    try { scenario = loadScenario(rows[0].scenario_id); } catch { /* scenario file removed */ }
    const notes = Object.fromEntries(db.prepare('SELECT step, text FROM arm_reviews WHERE arm_group = ?').all(group).map(n => [n.step, n.text]));
    const steps = (scenario?.steps || []).map((st, i) => ({ st, i })).filter(({ st }) => st.say || st.review).map(({ st, i }) => ({
      step: i, kind: st.say ? 'say' : 'review', input: st.say ?? null, question: st.review ?? null, note: notes[i] ?? '',
      arms: Object.fromEntries(ARMS.map(arm => {
        const res = runsBy[arm]?.results.find(r => r.step === i);
        return [arm, res ? { reply: res.reply ?? null, action: res.action ?? null, error: res.replyError || (res.error ? res.detail : null) } : null];
      }))
    }));
    const cost = saveId => db.prepare('SELECT sum(cost_usd) c FROM llm_calls WHERE save_id = ?').get(saveId).c ?? null;
    return {
      group, scenarioId: rows[0].scenario_id, title: scenario?.title || rows[0].scenario_id, provider: rows[0].provider,
      arms: ARMS.map(arm => { const r = runsBy[arm]; return r ? { arm, title: ARM_TITLES[arm], runId: r.id, saveId: r.saveId, state: r.state, step: r.step, total: r.total, summary: r.summary, cost: cost(r.saveId) } : { arm, title: ARM_TITLES[arm], missing: true }; }),
      steps
    };
  }

  function setArmNote(group, stepIndex, text) {
    if (!db.prepare('SELECT 1 FROM scenario_runs WHERE arm_group = ?').get(group)) return null;
    db.prepare(`INSERT INTO arm_reviews (arm_group, step, text, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (arm_group, step) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`).run(group, Number(stepIndex), String(text ?? '').slice(0, 2000), realNow());
    return arms(group);
  }

  /** Three-arm groups, newest first. */
  const armGroups = (limit = 20) => db.prepare('SELECT arm_group, scenario_id, provider, max(real_at) real_at FROM scenario_runs WHERE arm_group IS NOT NULL GROUP BY arm_group ORDER BY real_at DESC LIMIT ?').all(limit)
    .map(r => ({ group: r.arm_group, scenarioId: r.scenario_id, provider: r.provider, real_at: r.real_at }));

  return { list: listScenarios, create, start, step, runAll, get, history, exportRun, startArms, arms, setArmNote, armGroups };
}
