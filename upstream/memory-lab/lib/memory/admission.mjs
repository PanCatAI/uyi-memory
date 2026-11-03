// What may enter a character's context or be offered as a hint (PLAN §4.10). Every memory passes through here.
import { pj } from '../db.mjs';
import { DAY } from '../clock.mjs';
import { visibility, discovered } from '../perception.mjs';
import { parseRef, factRow, cacheRow, commitRow, sessionInfo, eventText } from './common.mjs';

export function createAdmission(lab) {
  const { db, ledger } = lab;

  /** Resolves a ref to { kind, row, text, seqs } or null. */
  function lookup(saveId, ref) {
    const { kind, id } = parseRef(ref);
    if (kind === 'ev') {
      const ev = ledger.get(saveId, Number(id));
      return ev && { kind, row: ev, text: ev.payload ? eventText(lab.scene(saveId), ev) : '', seqs: [ev.seq] };
    }
    if (kind === 'fact') { const r = factRow(db.prepare('SELECT * FROM user_facts WHERE id = ? AND save_id = ?').get(id, saveId)); return r && { kind, row: r, text: `${r.object} ${r.evidence}`, seqs: r.source_seqs }; }
    if (kind === 'cache') { const r = cacheRow(db.prepare('SELECT * FROM caches WHERE id = ? AND save_id = ?').get(id, saveId)); return r && { kind, row: r, text: r.text, seqs: r.derived_from }; }
    if (kind === 'commit') { const r = commitRow(db.prepare('SELECT * FROM commitments WHERE id = ? AND save_id = ?').get(id, saveId)); return r && { kind, row: r, text: r.text, seqs: r.source_seqs }; }
    if (kind === 'sc') { const r = db.prepare('SELECT * FROM self_canon WHERE id = ? AND save_id = ?').get(id, saveId); return r && { kind, row: { ...r, source_seqs: pj(r.source_seqs, []) }, text: r.text, seqs: pj(r.source_seqs, []) }; }
    return null;
  }

  /** Seqs this character may no longer derive anything from: globally forgotten events plus its own forgotten_seqs. */
  function forgottenSet(saveId, charId) {
    const out = new Set(db.prepare('SELECT seq FROM forgotten_seqs WHERE save_id = ? AND character_id = ?').all(saveId, charId).map(r => r.seq));
    for (const [seq, f] of ledger.flagMap(saveId)) if (f.has('forgotten')) out.add(seq);
    return out;
  }

  function activeSuppressions(saveId, charId) {
    return db.prepare('SELECT * FROM suppressions WHERE save_id = ? AND character_id = ? AND active = 1').all(saveId, charId).map(s => ({ ...s, refs: pj(s.refs_json, []) }));
  }

  /** Did the user, in the current session and after the suppression, say something containing its topic? */
  function userReopened(saveId, sup) {
    if (!sup.topic) return false;
    const { save } = sessionInfo(lab, saveId);
    if (!save.session_id) return false;
    return ledger.list(saveId, { after: sup.source_seq, types: ['user_said'], all: true })
      .some(e => e.session_id === save.session_id && (e.payload?.text || '').includes(sup.topic));
  }

  function suppressedBy(saveId, charId, ref, text) {
    return activeSuppressions(saveId, charId).filter(s => s.refs.includes(ref) || (s.topic && text.includes(s.topic)));
  }

  /** purpose: 'context' | 'hint'. Returns { ok, reason }. */
  function check(saveId, charId, ref, purpose = 'context') {
    const info = lookup(saveId, ref);
    if (!info) return { ok: false, reason: 'missing' };
    const r = info.row;
    if (info.kind === 'ev') {
      if (!r.payload) return { ok: false, reason: 'deleted' };
      if (forgottenSet(saveId, charId).has(r.seq)) return { ok: false, reason: 'forgotten' };
      if (visibility(r, charId) !== 'full' && !discovered(r, charId, ledger.world(saveId), lab.scene(saveId))) return { ok: false, reason: 'not_perceived' };
    } else {
      if (r.character_id !== charId) return { ok: false, reason: 'other_character' };
      if (info.kind === 'fact' && r.status !== 'active') return { ok: false, reason: r.status };
      if (info.kind === 'cache' && r.invalid) return { ok: false, reason: 'invalid' };
      if (info.kind === 'commit' && r.status !== 'open') return { ok: false, reason: r.status };
      if (info.kind === 'sc' && r.status !== 'active') return { ok: false, reason: r.status };
      // A memory built on a forgotten or deleted event is not usable either.
      const gone = forgottenSet(saveId, charId);
      if (info.seqs.some(s => gone.has(s))) return { ok: false, reason: 'forgotten' };
      // A learned self-claim whose every source was deleted has nothing left to stand on.
      if (info.kind === 'sc' && info.seqs.length && info.seqs.every(s => !ledger.get(saveId, s)?.payload)) return { ok: false, reason: 'deleted' };
    }
    const sups = suppressedBy(saveId, charId, ref, info.text);
    if (sups.length && !(purpose === 'context' && sups.every(s => userReopened(saveId, s)))) return { ok: false, reason: 'suppressed' };
    if (purpose === 'hint') {
      if (info.kind === 'fact' && r.sensitivity === 'private') return { ok: false, reason: 'private' };
      const now = lab.clock.now(saveId);
      const { save } = sessionInfo(lab, saveId);
      const recent = db.prepare('SELECT 1 FROM mentions WHERE save_id = ? AND character_id = ? AND memory_ref = ? AND (t > ? OR (session_id IS NOT NULL AND session_id = ?)) LIMIT 1')
        .get(saveId, charId, ref, now - 3 * DAY, save.session_id ?? '');
      if (recent) return { ok: false, reason: 'mentioned_recently' };
      // Same content under another ref (the fact and the observation of one sentence, a rebuilt cache…) counts as
      // mentioned too: compare by the source events, not by the id.
      const mine = new Set(info.seqs);
      if (mine.size) {
        const said = db.prepare('SELECT DISTINCT memory_ref FROM mentions WHERE save_id = ? AND character_id = ? AND memory_ref != ? AND (t > ? OR (session_id IS NOT NULL AND session_id = ?))')
          .all(saveId, charId, ref, now - 3 * DAY, save.session_id ?? '');
        if (said.some(m => (lookup(saveId, m.memory_ref)?.seqs || []).some(s => mine.has(s)))) return { ok: false, reason: 'mentioned_recently_same_content' };
      }
    }
    return { ok: true };
  }

  return { lookup, check, forgottenSet, allowed: (saveId, charId, ref, purpose) => check(saveId, charId, ref, purpose).ok, activeSuppressions };
}
