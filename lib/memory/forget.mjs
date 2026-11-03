// The three forget verbs (PLAN §4.15): 别再提 suppress / 忘掉 forget / 删除记录 delete.
// Job states: proposed → confirmed → applied → rebuilt → reported (or cancelled).
import { newId } from '../ids.mjs';
import { j, pj, tx } from '../db.mjs';
import { render } from '../prompts.mjs';
import { formatWorldTime } from '../clock.mjs';
import { visibility } from '../perception.mjs';
import { factRow, cacheRow, commitRow, nameOf, SPEECH } from './common.mjs';

const SUPPRESS = /(别|不要|不许)再(提|说|问)(.{0,10}?)(的事|这事|了|$)/;
const DELETE = /删(除|掉|了)|抹掉|清除/;
const DELETE_CTX = /记录|聊天|对话|那件事|这件事|刚才/;
const FORGET = [/忘(了|掉|记)(吧|它|那|这)/, /把.{1,12}忘(了|掉)/];
export const VERB_TEXT = { suppress: '别再提', forget: '忘掉', delete: '删除' };

/** { verb, topic } | null */
export function detect(text) {
  const t = String(text || '').trim();
  const s = SUPPRESS.exec(t);
  // "我奶奶" → "奶奶": memories retell the user's words in the third person, so a pronoun would make the topic miss.
  if (s) return { verb: 'suppress', topic: s[3].replace(/那个|这个|关于|那件|这件/g, '').trim().replace(/^(我们的|我的|你的|我|你)/, '') };
  if (/(吗|？|\?)$/.test(t)) return null;
  if (DELETE.test(t) && DELETE_CTX.test(t)) return { verb: 'delete', topic: '' };
  if (FORGET.some(r => r.test(t))) return { verb: 'forget', topic: '' };
  return null;
}

const MAX = 30;
const intersects = (a, set) => a.some(x => set.has(x));

export function createForget(lab) {
  const { db, ledger, clock } = lab;
  const getJob = id => { const r = db.prepare('SELECT * FROM forget_jobs WHERE id = ?').get(id); return r && { ...r, candidates: pj(r.candidates_json, {}), applied: pj(r.applied_json, null), report: pj(r.report_json, null) }; };
  const setState = (id, state, extra = {}) => {
    const cols = Object.keys(extra);
    db.prepare(`UPDATE forget_jobs SET state = ?${cols.map(c => `, ${c} = ?`).join('')} WHERE id = ?`).run(state, ...cols.map(c => extra[c]), id);
  };

  function dialogFor(saveId, charId, ev) {
    return SPEECH.includes(ev.type) && ev.payload && visibility(ev, charId) === 'full' && (ev.actor === charId || ev.payload.to === charId);
  }

  function findCandidates(saveId, charId, topic, requestSeq) {
    const facts = db.prepare("SELECT * FROM user_facts WHERE save_id = ? AND character_id = ? AND status != 'forgotten'").all(saveId, charId).map(factRow);
    const caches = db.prepare('SELECT * FROM caches WHERE save_id = ? AND character_id = ?').all(saveId, charId).map(cacheRow).filter(c => !c.invalid || c.invalid_reason === 'forgotten');
    const commits = db.prepare("SELECT * FROM commitments WHERE save_id = ? AND character_id = ? AND status != 'forgotten'").all(saveId, charId).map(commitRow);
    const dialog = ledger.list(saveId, { before: requestSeq ?? Infinity, all: true }).filter(e => e.seq !== requestSeq && dialogFor(saveId, charId, e));
    if (topic) {
      return {
        seqs: dialog.filter(e => e.payload.text.includes(topic)).slice(-MAX).map(e => e.seq),
        fact_ids: facts.filter(f => f.status === 'active' && `${f.object}${f.evidence}`.includes(topic)).slice(-MAX).map(f => f.id),
        cache_ids: caches.filter(c => !c.invalid && c.text.includes(topic)).slice(-MAX).map(c => c.id),
        commit_ids: commits.filter(c => c.status === 'open' && c.text.includes(topic)).slice(-MAX).map(c => c.id)
      };
    }
    const seqs = dialog.slice(-MAX).map(e => e.seq);
    const set = new Set(seqs);
    return {
      seqs,
      fact_ids: facts.filter(f => intersects(f.source_seqs, set)).slice(-MAX).map(f => f.id),
      cache_ids: caches.filter(c => intersects(c.derived_from, set)).slice(-MAX).map(c => c.id),
      commit_ids: commits.filter(c => intersects(c.source_seqs, set)).slice(-MAX).map(c => c.id)
    };
  }

  /** Steps 1–2 (and for a suppress with a topic, all of them). Returns the job. */
  async function propose(saveId, charId, { verb, topic = '', requestSeq, requestText = '', refs = null }) {
    const id = newId('fj');
    let candidates;
    if (refs) {
      candidates = { seqs: [], fact_ids: [], cache_ids: [], commit_ids: [] };
      // Every ref must exist, be of a known kind and belong to this save and this character — or nothing happens.
      for (const ref of refs) {
        const i = String(ref).indexOf(':');
        const [kind, rid] = [String(ref).slice(0, i), String(ref).slice(i + 1)];
        if (kind === 'ev') {
          const ev = ledger.get(saveId, Number(rid));
          if (!Number.isInteger(Number(rid)) || !ev || visibility(ev, charId) === 'none') throw new Error(`这条记录不属于这个存档或角色：${ref}`);
          candidates.seqs.push(Number(rid));
          continue;
        }
        const table = { fact: 'user_facts', cache: 'caches', commit: 'commitments' }[kind];
        if (!table) throw new Error(`不认识的记忆类型：${ref}`);
        if (!db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND save_id = ? AND character_id = ?`).get(rid, saveId, charId)) throw new Error(`这条记忆不属于这个存档或角色：${ref}`);
        candidates[{ fact: 'fact_ids', cache: 'cache_ids', commit: 'commit_ids' }[kind]].push(rid);
      }
    } else candidates = findCandidates(saveId, charId, topic, requestSeq);
    db.prepare('INSERT INTO forget_jobs (id, save_id, character_id, verb, request_seq, topic, state, candidates_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, saveId, charId, verb, requestSeq ?? 0, topic || '', 'proposed', j(candidates), clock.now(saveId));
    if (verb === 'suppress' && (topic || refs)) {
      setState(id, 'confirmed');
      await apply(id);
      return getJob(id);
    }
    if (!refs) {
      const scene = lab.scene(saveId);
      const recent = ledger.list(saveId, { before: requestSeq, desc: true, limit: 60 }).filter(e => dialogFor(saveId, charId, e)).slice(0, 30).reverse();
      const describe = () => [
        ...candidates.seqs.map(s => { const e = ledger.get(saveId, s); return `ev ${s}：${nameOf(scene, e.actor)}：${e.payload?.text ?? ''}`; }),
        ...candidates.fact_ids.map(fid => { const f = factRow(db.prepare('SELECT * FROM user_facts WHERE id = ?').get(fid)); return `fact ${fid}：${f.predicate} ${f.object}`; }),
        ...candidates.cache_ids.map(cid => `cache ${cid}：${db.prepare('SELECT text FROM caches WHERE id = ?').get(cid).text}`),
        ...candidates.commit_ids.map(kid => `commit ${kid}：${db.prepare('SELECT text FROM commitments WHERE id = ?').get(kid).text}`)
      ].join('\n');
      const out = await lab.llm.callChecked({
        purpose: 'forget_resolve', system: '你只输出 JSON。', saveId,
        user: render('forget-resolve', { character_name: nameOf(scene, charId), verb_text: VERB_TEXT[verb], request: requestText, recent: recent.map(e => `[${e.seq}] ${formatWorldTime(e.t)} ${nameOf(scene, e.actor)}：${e.payload.text}`).join('\n') || '（无）', candidates: describe() || '（无）' }),
        mockInput: { request: requestText, candidates }
      });
      const keep = (list, allowed) => [...new Set((list || []).filter(x => allowed.includes(x)))];
      const chosen = { seqs: keep(out.seqs, candidates.seqs), fact_ids: keep(out.fact_ids, candidates.fact_ids), cache_ids: keep(out.cache_ids, candidates.cache_ids), commit_ids: keep(out.commit_ids, candidates.commit_ids) };
      db.prepare('UPDATE forget_jobs SET topic = ?, candidates_json = ? WHERE id = ?').run(verb === 'delete' ? '（待确认的删除）' : String(out.topic || topic).slice(0, 80), j(chosen), id);
    }
    return getJob(id);
  }

  function confirm(id) {
    const job = getJob(id);
    if (!job || job.state !== 'proposed') throw new Error('这个忘记任务不在待确认状态');
    setState(id, 'confirmed');
    return lab.jobs.enqueue(job.save_id, job.character_id, 'forget_apply', () => apply(id));
  }
  function cancel(id) {
    const job = getJob(id);
    if (!job || job.state !== 'proposed') throw new Error('这个忘记任务不在待确认状态');
    setState(id, 'cancelled', { finished_at: clock.now(job.save_id) });
    return getJob(id);
  }

  /** Steps 4–6. */
  async function apply(id) {
    const job = getJob(id);
    const { save_id: saveId, character_id: charId, verb } = job;
    const c = job.candidates;
    // Only ids of this save and character are ever touched, whatever the job row says.
    const mine = (table, ids) => (ids || []).filter(x => db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND save_id = ? AND character_id = ?`).get(x, saveId, charId));
    c.fact_ids = mine('user_facts', c.fact_ids); c.cache_ids = mine('caches', c.cache_ids); c.commit_ids = mine('commitments', c.commit_ids);
    c.seqs = (c.seqs || []).filter(s => ledger.get(saveId, s));
    const seqSet = new Set(c.seqs);
    const now = clock.now(saveId);
    const refs = [...c.seqs.map(s => `ev:${s}`), ...c.fact_ids.map(x => `fact:${x}`), ...c.cache_ids.map(x => `cache:${x}`), ...c.commit_ids.map(x => `commit:${x}`)];
    const report = { events: c.seqs.length, facts: 0, commitments: 0, caches_rebuilt: 0, traces_redacted: 0 };
    let rebuildRanges = [], diaryDays = [], weekDays = [];

    tx(db, () => {
      if (verb === 'suppress') {
        db.prepare('INSERT INTO suppressions (id, save_id, character_id, topic, refs_json, source_seq, active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)')
          .run(newId('sp'), saveId, charId, job.topic, j(refs), job.request_seq, now);
        for (const s of c.seqs) ledger.addFlag(saveId, s, 'suppressed', id, now);
        report.facts = c.fact_ids.length;
        return;
      }
      // A chosen experience (cache) is forgotten for this character by its sources, so rebuilding the range cannot
      // write the same content back under a new id. Facts from the same sentence are not touched.
      const cacheSeqs = new Set();
      for (const cid of c.cache_ids) {
        const row = cacheRow(db.prepare('SELECT * FROM caches WHERE id = ? AND save_id = ? AND character_id = ?').get(cid, saveId, charId));
        for (const s of row?.derived_from || []) cacheSeqs.add(s);
      }
      // An exchange is one piece of content: the reply to a forgotten line (and the line a forgotten reply answered)
      // would otherwise carry it back through the rebuild and the recent dialogue.
      for (const s of [...cacheSeqs]) {
        for (const t of db.prepare('SELECT user_seq, reply_seq FROM turns WHERE save_id = ? AND character_id = ? AND committed = 1 AND (user_seq = ? OR reply_seq = ?)').all(saveId, charId, s, s)) {
          if (t.user_seq != null) cacheSeqs.add(t.user_seq);
          if (t.reply_seq != null) cacheSeqs.add(t.reply_seq);
        }
      }
      // Deleting an experience deletes its original exchange too (and so everything derived from it).
      if (verb === 'delete') for (const s of cacheSeqs) if (!seqSet.has(s) && ledger.get(saveId, s)?.payload) { seqSet.add(s); c.seqs.push(s); }
      report.events = c.seqs.length;
      for (const s of cacheSeqs) {
        db.prepare('INSERT OR IGNORE INTO forgotten_seqs (save_id, character_id, seq, job_id, at) VALUES (?, ?, ?, ?, ?)').run(saveId, charId, s, id, now);
      }
      for (const s of c.seqs) ledger.addFlag(saveId, s, 'forgotten', id, now);
      const forgottenSeqs = lab.admission.forgottenSet(saveId, charId);
      // Learned self-claims whose every source is now forgotten go too (the authored card is not in this table).
      const selfHit = db.prepare('SELECT * FROM self_canon WHERE save_id = ? AND character_id = ?').all(saveId, charId)
        .map(r => ({ ...r, seqs: pj(r.source_seqs, []) })).filter(r => r.seqs.length && r.seqs.every(s => seqSet.has(s) || forgottenSeqs.has(s)));
      for (const r of selfHit) db.prepare("UPDATE self_canon SET status = 'forgotten' WHERE id = ?").run(r.id);
      report.self_claims = selfHit.length;
      const factIds = new Set(c.fact_ids);
      for (const f of db.prepare('SELECT * FROM user_facts WHERE save_id = ? AND character_id = ?').all(saveId, charId).map(factRow)) if (intersects(f.source_seqs, seqSet)) factIds.add(f.id);
      const commitIds = new Set(c.commit_ids);
      for (const k of db.prepare('SELECT * FROM commitments WHERE save_id = ? AND character_id = ?').all(saveId, charId).map(commitRow)) if (intersects(k.source_seqs, seqSet)) commitIds.add(k.id);
      const all = db.prepare('SELECT * FROM caches WHERE save_id = ? AND character_id = ?').all(saveId, charId).map(cacheRow);
      const hit = all.filter(x => c.cache_ids.includes(x.id) || intersects(x.derived_from, seqSet) || intersects(x.derived_from, cacheSeqs));
      // A batch of observations shares one range; rebuild the whole batch once so nothing gets written twice.
      const ranges = new Map();
      for (const h of hit) if (!['diary', 'week'].includes(h.kind) && (!h.invalid || h.invalid_reason === 'forgotten')) ranges.set(`${h.from_seq}-${h.to_seq}`, [h.from_seq, h.to_seq]);
      diaryDays = [...new Set(hit.filter(h => h.kind === 'diary').map(h => h.day).filter(Boolean))];
      weekDays = [...new Set(hit.filter(h => h.kind === 'week').map(h => h.day).filter(Boolean))];
      const batch = all.filter(x => !x.invalid && ranges.has(`${x.from_seq}-${x.to_seq}`) && x.kind === 'observation');
      const victims = [...new Map([...hit, ...batch].map(x => [x.id, x])).values()];
      for (const v of victims) db.prepare("UPDATE caches SET invalid = 1, invalid_reason = 'forgotten' WHERE id = ?").run(v.id);
      rebuildRanges = [...ranges.values()];
      for (const fid of factIds) db.prepare("UPDATE user_facts SET status = 'forgotten' WHERE id = ? AND save_id = ? AND character_id = ?").run(fid, saveId, charId);
      for (const kid of commitIds) db.prepare("UPDATE commitments SET status = 'forgotten' WHERE id = ? AND save_id = ? AND character_id = ?").run(kid, saveId, charId);
      report.facts = factIds.size; report.commitments = commitIds.size;
      lab.saves.bumpGeneration(saveId);

      if (verb === 'delete') {
        const strings = new Set();
        for (const s of c.seqs) { const e = ledger.get(saveId, s); if (e?.payload?.text) strings.add(e.payload.text); }
        for (const fid of factIds) { const f = db.prepare('SELECT object, evidence FROM user_facts WHERE id = ?').get(fid); if (f) { strings.add(f.object); strings.add(f.evidence); } }
        for (const v of victims) strings.add(v.text);
        for (const kid of commitIds) { const k = db.prepare('SELECT text FROM commitments WHERE id = ?').get(kid); if (k) strings.add(k.text); }
        for (const r of selfHit) strings.add(r.text);
        const list = [...strings].filter(x => x && x.length >= 2).sort((a, b) => b.length - a.length);
        for (const s of c.seqs) ledger.tombstone(saveId, s, { job: id, verb, at: now });
        const gone = [...selfHit.map(r => `sc:${r.id}`), ...[...factIds].map(x => `fact:${x}`), ...[...commitIds].map(x => `commit:${x}`), ...victims.map(x => `cache:${x.id}`), ...c.seqs.map(s => `ev:${s}`)];
        for (const fid of factIds) db.prepare('DELETE FROM user_facts WHERE id = ? AND save_id = ? AND character_id = ?').run(fid, saveId, charId);
        for (const kid of commitIds) db.prepare('DELETE FROM commitments WHERE id = ? AND save_id = ? AND character_id = ?').run(kid, saveId, charId);
        for (const v of victims) db.prepare('DELETE FROM caches WHERE id = ?').run(v.id);
        for (const r of selfHit) db.prepare('DELETE FROM self_canon WHERE id = ?').run(r.id);
        for (const r of db.prepare('SELECT id, candidate_json FROM rejected_facts WHERE save_id = ?').all(saveId)) if (seqSet.has(pj(r.candidate_json, {}).source_seq)) db.prepare('DELETE FROM rejected_facts WHERE id = ?').run(r.id);
        for (const ref of gone) {
          db.prepare('DELETE FROM mentions WHERE save_id = ? AND memory_ref = ?').run(saveId, ref);
          db.prepare('DELETE FROM retrievals WHERE save_id = ? AND memory_ref = ?').run(saveId, ref);
        }
        const redact = v => (typeof v === 'string' ? list.reduce((s, x) => s.split(x).join('［已删除］'), v) : Array.isArray(v) ? v.map(redact) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x)])) : v);
        for (const t of db.prepare('SELECT * FROM turns WHERE save_id = ?').all(saveId)) {
          if (seqSet.has(t.user_seq) || seqSet.has(t.reply_seq)) { db.prepare('DELETE FROM turns WHERE id = ?').run(t.id); report.traces_redacted++; continue; }
          const cols = ['sections_json', 'prompt_json', 'output_json', 'rejected_json'];
          const next = cols.map(k => (t[k] == null ? null : JSON.stringify(redact(pj(t[k], null)))));
          if (cols.some((k, i) => next[i] !== t[k])) { db.prepare('UPDATE turns SET sections_json = ?, prompt_json = ?, output_json = ?, rejected_json = ? WHERE id = ?').run(...next, t.id); report.traces_redacted++; }
        }
        for (const other of db.prepare("SELECT id, applied_json FROM forget_jobs WHERE save_id = ? AND id != ?").all(saveId, id)) {
          if (intersects(pj(other.applied_json, {})?.seqs || [], seqSet)) db.prepare("UPDATE forget_jobs SET topic = '（已删除）' WHERE id = ?").run(other.id);
        }
      }
    });
    const appliedJson = verb === 'delete' ? j({ seqs: c.seqs, counts: { facts: c.fact_ids.length, caches: c.cache_ids.length, commits: c.commit_ids.length } }) : j(c);
    setState(id, 'applied', { applied_json: appliedJson, ...(verb === 'delete' ? { topic: '（已删除）', candidates_json: j({ seqs: c.seqs.length, fact_ids: c.fact_ids.length, cache_ids: c.cache_ids.length, commit_ids: c.commit_ids.length }) } : {}) });
    ledger.append(saveId, { type: 'memory_op', actor: 'host', payload: { op: verb, job: id } });

    for (const [from, to] of rebuildRanges) report.caches_rebuilt += (await lab.observe.observeRange(saveId, charId, from, to)).length;
    // 2.0 D3: a diary that cited a forgotten/deleted event is written again from what is left of that day.
    for (const day of diaryDays) if (await lab.diary.write(saveId, charId, day)) report.caches_rebuilt++;
    // 2.0 D4: then the weekly digests above them, from the rewritten diaries (event → diary → week).
    for (const sunday of weekDays) if (await lab.diary.writeWeek(saveId, charId, sunday)) report.caches_rebuilt++;
    setState(id, 'rebuilt');
    setState(id, 'reported', { report_json: j(report), finished_at: clock.now(saveId) });
    return getJob(id);
  }

  const list = (saveId, charId) => db.prepare(`SELECT * FROM forget_jobs WHERE save_id = ?${charId ? ' AND character_id = ?' : ''} ORDER BY created_at, rowid`).all(...(charId ? [saveId, charId] : [saveId])).map(r => ({ ...r, candidates: pj(r.candidates_json, {}), applied: pj(r.applied_json, null), report: pj(r.report_json, null) }));
  return { detect, propose, confirm, cancel, apply, getJob, list };
}
