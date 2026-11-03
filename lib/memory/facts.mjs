// User facts (PLAN §4.11, contracts/llm-output.md §2): the model proposes, these rules decide.
import { newId } from '../ids.mjs';
import { j } from '../db.mjs';
import { parseDuration } from '../clock.mjs';
import { render } from '../prompts.mjs';
import { FACT_SOURCE_TYPES } from '../../contracts/events.mjs';
import { PREDICATES } from '../llm-checks.mjs';
import { isSensitive } from './sensitive.mjs';
import { factRow, getWatermark, setWatermark, norm, nameOf } from './common.mjs';
import { visibility } from '../perception.mjs';
import { MAX_ATTEMPTS } from './jobs.mjs';

export const REJECT = { negated: 'negated', newer_value: 'newer_value', source_not_user: 'source_not_user', bad_predicate: 'bad_predicate', no_evidence: 'no_evidence', low_confidence: 'low_confidence', duplicate: 'duplicate', suppressed: 'suppressed' };

// Negation (P1-04): "我不喜欢香菜" contains the substring "喜欢香菜", but it does not support likes:香菜. A candidate is
// rejected when every occurrence of its evidence is directly preceded by a negation, or when a positive predicate's
// evidence itself negates its verb. Deliberately conservative: an unprovable reading is not stored as a fact.
const NEG_BEFORE = /(不|没|没有|别|从不|并不|才不|不太|未|不是)$/;
const POSITIVE = { likes: /(不|没|别|未)(太|怎么|再)?(喜欢|爱)/, owns: /(不|没)(有)/, plan: /(不|没|别)(打算|想|要|会)/, job: /(不是|没有?在|不在)/, family: /(没有|不是)/, relation_to_object: /(不是)/ };
const NEGATIVE = { dislikes: /(不|没|别)(太|怎么)?(讨厌|烦)/ };
export function negated(predicate, source, evidence, object = '') {
  const s = norm(source), e = norm(evidence);
  // "plan: 不去灯塔" from "我不打算去灯塔了" states the negation in the object itself: consistent, keep it.
  if (!['likes', 'dislikes'].includes(predicate) && /(不|没|别|未)/.test(norm(object))) return false;
  if ((POSITIVE[predicate] || NEGATIVE[predicate])?.test(e)) return true;
  if (!POSITIVE[predicate] && !NEGATIVE[predicate] && predicate !== 'state') return false;
  for (let i = s.indexOf(e); i >= 0; i = s.indexOf(e, i + 1)) if (!NEG_BEFORE.test(s.slice(Math.max(0, i - 3), i))) return false;
  return true;
}

export function createFacts(lab) {
  const { db, ledger, clock } = lab;

  const active = (saveId, charId) => db.prepare("SELECT * FROM user_facts WHERE save_id = ? AND character_id = ? AND status = 'active' ORDER BY recorded_at, rowid").all(saveId, charId).map(factRow);

  function reject(saveId, charId, cand, sourceSeq, reason) {
    db.prepare('INSERT INTO rejected_facts (id, save_id, character_id, candidate_json, reason, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(newId('rf'), saveId, charId, j({ ...cand, source_seq: sourceSeq }), reason, clock.now(saveId));
    return { ok: false, reason };
  }

  const NAME_SLOTS = ['name', 'call_me'];
  const CORRECTION = /不对|写错|说错|打错|记错|搞错|不是.{1,6}是/;
  function supersede(saveId, oldId, newFactId, now) {
    db.prepare("UPDATE user_facts SET status = 'superseded', valid_to = ?, superseded_by = ? WHERE id = ? AND save_id = ? AND status = 'active'").run(now, newFactId, oldId, saveId);
  }

  /** Applies the deterministic rules to one candidate from source event ev. Returns { ok, id } or { ok:false, reason }. */
  function accept(saveId, charId, ev, cand) {
    const now = clock.now(saveId);
    if (!FACT_SOURCE_TYPES.includes(ev.type)) return reject(saveId, charId, cand, ev.seq, REJECT.source_not_user);
    if (!PREDICATES[cand.predicate]) return reject(saveId, charId, cand, ev.seq, REJECT.bad_predicate);
    const source = ev.payload?.text ?? JSON.stringify(ev.payload ?? {});
    if (!norm(cand.evidence) || !norm(source).includes(norm(cand.evidence))) return reject(saveId, charId, cand, ev.seq, REJECT.no_evidence);
    if (negated(cand.predicate, source, cand.evidence, cand.object)) return reject(saveId, charId, cand, ev.seq, REJECT.negated);
    if (!(cand.confidence >= 0.6)) return reject(saveId, charId, cand, ev.seq, REJECT.low_confidence);
    const current = active(saveId, charId);
    if (current.some(f => f.predicate === cand.predicate && norm(f.object) === norm(cand.object))) return reject(saveId, charId, cand, ev.seq, REJECT.duplicate);
    // A late or retried extraction must not override a single value the user stated after this line.
    if (PREDICATES[cand.predicate].single && current.some(f => f.predicate === cand.predicate && Math.max(...f.source_seqs) > ev.seq)) return reject(saveId, charId, cand, ev.seq, REJECT.newer_value);
    const sups = lab.admission.activeSuppressions(saveId, charId);
    if (sups.some(s => s.topic && (cand.object.includes(s.topic) || cand.evidence.includes(s.topic)))) return reject(saveId, charId, cand, ev.seq, REJECT.suppressed);

    const id = newId('f');
    const spec = PREDICATES[cand.predicate];
    const validFor = cand.valid_for ? parseDuration(cand.valid_for, ev.t) : spec.expire ? parseDuration(spec.expire) : null;
    // 2.0 D6: how she knows it — the user told her (user_said), she saw it (a world event she perceived), or a guess.
    const knownHow = ev.type === 'user_said' ? 'told' : visibility(ev, charId) === 'full' ? 'seen' : 'inferred';
    db.prepare(`INSERT INTO user_facts (id, save_id, character_id, predicate, object, evidence, source_seqs, valid_from, valid_to, recorded_at, status, sensitivity, confidence, known_how)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`)
      .run(id, saveId, charId, cand.predicate, cand.object, cand.evidence, j([ev.seq]), ev.t, validFor != null ? ev.t + validFor : null, now, isSensitive(`${cand.object}${cand.evidence}`) ? 'private' : 'normal', cand.confidence, knownHow);
    const replaced = [];
    if (cand.corrects) {
      const old = current.find(f => f.id === cand.corrects);
      if (old) { supersede(saveId, old.id, id, now); replaced.push(old); }
    }
    if (spec.single) for (const f of current.filter(f => f.predicate === cand.predicate && f.id !== cand.corrects)) { supersede(saveId, f.id, id, now); replaced.push(f); }
    // name and call_me are two slots for one name: the model may file 「我叫阿远，以后这么叫我」 under either or both
    // and the correction under only one. A replaced name value goes out of both slots, so the old name never lingers.
    for (const old of replaced.filter(f => NAME_SLOTS.includes(f.predicate))) {
      for (const f of current.filter(f => NAME_SLOTS.includes(f.predicate) && !replaced.includes(f) && norm(f.object) === norm(old.object))) { supersede(saveId, f.id, id, now); replaced.push(f); }
    }
    // A name said as a correction (「不对，是小远」) with no corrects id still replaces the name in the other slot.
    if (NAME_SLOTS.includes(cand.predicate) && CORRECTION.test(source)) {
      for (const f of current.filter(f => NAME_SLOTS.includes(f.predicate) && f.predicate !== cand.predicate && !replaced.includes(f) && norm(f.object) !== norm(cand.object))) { supersede(saveId, f.id, id, now); replaced.push(f); }
    }
    const corrected = replaced.length > 0;
    if (corrected) {
      lab.saves.bumpGeneration(saveId);
      ledger.append(saveId, { type: 'memory_op', actor: 'host', payload: { op: 'correct', job: id } });
    }
    return { ok: true, id };
  }

  function addCommitment(saveId, charId, ev, c) {
    const source = ev.payload?.text ?? '';
    if (!norm(c.evidence) || !norm(source).includes(norm(c.evidence))) return null;
    const d = c.due ? parseDuration(c.due, ev.t) : null;
    return lab.commitments.add(saveId, charId, { owner: c.owner, text: c.text, dueAt: d != null ? ev.t + d : null, sourceSeqs: [ev.seq], at: clock.now(saveId) });
  }

  /** One extraction for one user_said. Throws on a model failure; writes nothing then. */
  async function extract(saveId, charId, ev) {
    const known = active(saveId, charId);
    const before = ledger.list(saveId, { before: ev.seq, types: ['user_said', 'char_said'], desc: true, limit: 4 })
      .filter(e => e.payload && (e.payload.to === charId || e.actor === charId)).reverse();
    const prompt = render('facts', {
      known_facts: known.map(f => `${f.id} ${f.predicate}: ${f.object}`).join('\n') || '（无）',
      context: before.map(e => `${e.actor === 'user' ? '用户' : '角色'}：${e.payload.text}`).join('\n') || '（无）',
      utterance: ev.payload.text
    });
    const out = await lab.llm.callChecked({ purpose: 'facts', system: '你只输出 JSON。', user: prompt, saveId, mockInput: { utterance: ev.payload.text, knownFacts: known } });
    // The call took a while: the line may have been forgotten or deleted meanwhile.
    if (!usable(saveId, charId, ev.seq)) return { cancelled: true, accepted: 0 };
    let accepted = 0;
    for (const cand of out.facts) if (accept(saveId, charId, ev, cand).ok) accepted++;
    for (const c of out.commitments) if (addCommitment(saveId, charId, ev, c)) accepted++;
    return { accepted };
  }
  /**
   * 2.0 D6: what she saw the user do becomes a fact she knows by sight (known_how 'seen'): a gift, something built or
   * placed, something moved, or what the creator added in 造物台 — only for characters who perceived the event in
   * full. No model; the evidence is the event itself.
   */
  const SEEN = {
    give: (n, e) => `用户把${n(e.target)}给了${n(e.payload.args?.to)}`,
    build: (n, e) => `用户在${n(e.payload.args?.room)}搭了${n(e.target)}`,
    place: (n, e) => `用户在${n(e.payload.args?.room)}放了${n(e.target)}`,
    move_object: (n, e) => `用户把${n(e.target)}挪到了${n(e.payload.args?.room)}`
  };
  function seenFacts(saveId, ev) {
    const kind = ev.type === 'user_action' ? ev.action : ev.type === 'world_edit' && ev.payload?.op === 'add' ? 'world_add' : null;
    if (!kind || (kind !== 'world_add' && !SEEN[kind])) return;
    const scene = lab.scene(saveId);
    const st = ledger.world(saveId);
    const n = id => st.objects[id]?.name || nameOf(scene, id);
    const object = kind === 'world_add' ? `用户（造物者）在${n(ev.room)}搭了${ev.payload.object?.name || n(ev.target)}` : SEEN[kind](n, ev);
    for (const c of scene.characters) {
      if (visibility(ev, c.id) !== 'full') continue;
      if (active(saveId, c.id).some(f => f.predicate === 'relation_to_object' && f.object === object)) continue;
      db.prepare(`INSERT INTO user_facts (id, save_id, character_id, predicate, object, evidence, source_seqs, valid_from, valid_to, recorded_at, status, sensitivity, confidence, known_how)
        VALUES (?, ?, ?, 'relation_to_object', ?, ?, ?, ?, NULL, ?, 'active', 'normal', 1, 'seen')`)
        .run(newId('f'), saveId, c.id, object, `${ev.type}#${ev.seq}`, j([ev.seq]), ev.t, clock.now(saveId));
    }
  }
  ledger.onAppend(seenFacts);

  const usable = (saveId, charId, seq) => Boolean(ledger.get(saveId, seq)?.payload) && !lab.admission.forgottenSet(saveId, charId).has(seq);

  /**
   * Processes every user_said to charId after the 'facts' watermark. A failure is recorded in job_runs; after
   * MAX_ATTEMPTS failures of the same line the watermark moves past it (status 'skipped') so later lines are not
   * blocked, and the line stays recoverable through jobs.retry.
   */
  async function run(saveId, charId) {
    const wm = getWatermark(lab, saveId, charId, 'facts');
    const todo = ledger.list(saveId, { after: wm, types: ['user_said'], all: true }).filter(e => e.payload?.to === charId || (!e.payload && e.tombstone));
    for (const ev of todo) {
      if (!ev.payload || ev.payload.to !== charId || !usable(saveId, charId, ev.seq)) { setWatermark(lab, saveId, charId, 'facts', ev.seq); continue; }
      try { await extract(saveId, charId, ev); }
      catch (e) {
        const r = lab.jobs.fail(saveId, charId, 'facts', ev.seq, ev.seq, `抽事实失败：${e.message}`);
        if (r.attempts >= MAX_ATTEMPTS) { lab.jobs.mark(saveId, charId, 'facts', ev.seq, ev.seq, 'skipped'); setWatermark(lab, saveId, charId, 'facts', ev.seq); continue; }
        return;
      }
      lab.jobs.recoverUpTo(saveId, charId, 'facts', ev.seq);
      setWatermark(lab, saveId, charId, 'facts', ev.seq);
    }
  }

  /** Explicit retry of one line (jobs.retry). Idempotent: a line that already produced facts is not extracted again. */
  async function retrySeq(saveId, charId, seq) {
    const ev = ledger.get(saveId, seq);
    if (!ev || ev.type !== 'user_said' || ev.payload?.to !== charId || !usable(saveId, charId, seq)) return lab.jobs.mark(saveId, charId, 'facts', seq, seq, 'cancelled');
    const done = db.prepare('SELECT 1 FROM user_facts WHERE save_id = ? AND character_id = ? AND EXISTS (SELECT 1 FROM json_each(source_seqs) WHERE value = ?)').get(saveId, charId, seq);
    if (done) return lab.jobs.mark(saveId, charId, 'facts', seq, seq, 'recovered');
    const r = await extract(saveId, charId, ev);
    lab.jobs.mark(saveId, charId, 'facts', seq, seq, r.cancelled ? 'cancelled' : r.accepted ? 'recovered' : 'recovered_empty');
  }

  /** Marks facts whose valid_to has passed as expired. */
  function expire(saveId) {
    db.prepare("UPDATE user_facts SET status = 'expired' WHERE save_id = ? AND status = 'active' AND valid_to IS NOT NULL AND valid_to <= ?").run(saveId, clock.now(saveId));
  }

  return { run, retrySeq, accept, active, expire, all: (saveId, charId) => db.prepare('SELECT * FROM user_facts WHERE save_id = ? AND character_id = ? ORDER BY recorded_at DESC, rowid DESC').all(saveId, charId).map(factRow) };
}
