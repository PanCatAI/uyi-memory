// Card versions per save (PLAN-2.0 B5). Version 0 is the file in characters/; every save from the settings tab or a
// restore is a new row, never an update. Parsing is B1's parser, so a bad card is refused with its line number.
import { createHash } from 'node:crypto';
import { parseCardV2, isRichCard, cardSystemText, CARD_SYSTEM_BUDGET } from './card.mjs';
import { conflicts } from './memory/selfcanon.mjs';
import { estimate } from './tokens.mjs';
import { realNow } from './clock.mjs';
import { render } from './prompts.mjs';
import { loadScene } from './scene.mjs';

export const cardHash = text => createHash('sha256').update(String(text)).digest('hex').slice(0, 12);

export class CardError extends Error {}

export function createCards(lab, baseScene) {
  const { db } = lab;
  const latestRow = (saveId, charId) => db.prepare('SELECT * FROM card_versions WHERE save_id = ? AND char_id = ? ORDER BY version DESC LIMIT 1').get(saveId, charId);
  const fileCard = (saveId, charId) => {
    const c = baseScene(saveId).characters.find(x => x.id === charId);
    if (!c) throw new CardError(`没有这个角色：${charId}`);
    return c;
  };

  /** { version, text, note, created_at, hash }; version 0 is the authored file. */
  function current(saveId, charId) {
    const r = latestRow(saveId, charId);
    const text = r ? r.text : fileCard(saveId, charId).cardText;
    return { version: r?.version ?? 0, text, note: r?.note ?? '角色卡文件', created_at: r?.created_at ?? null, hash: cardHash(text) };
  }

  function versions(saveId, charId) {
    fileCard(saveId, charId);
    const rows = db.prepare('SELECT version, note, created_at, text FROM card_versions WHERE save_id = ? AND char_id = ? ORDER BY version').all(saveId, charId);
    return [{ version: 0, note: '角色卡文件', created_at: null, text: fileCard(saveId, charId).cardText }, ...rows].map(r => ({ ...r, hash: cardHash(r.text) }));
  }

  /** Parses (throws CardError `第 N 行：…`) and checks the system-prompt budget. → parsed card. */
  function validate(text, name) {
    let p;
    try { p = parseCardV2(text); } catch (e) { throw new CardError(e.message); }
    if (!p.name) throw new CardError('第 1 行：角色卡要以「# 名字」开头');
    if (!p.canon.length) throw new CardError('「设定」一节至少要有一条');
    if (isRichCard(p.card)) {
      const n = estimate(cardSystemText({ name: name || p.name, meta: p.meta, card: p.card }));
      if (n > CARD_SYSTEM_BUDGET) throw new CardError(`进系统提示约 ${n} token，超过上限 ${CARD_SYSTEM_BUDGET}：请删减外貌、性格或示例对话`);
    }
    return p;
  }

  // Canon changed: claims are checked again against the new canon (only between active and conflicts_canon).
  function recheckSelfCanon(saveId, charId, canon) {
    const changed = [];
    for (const r of lab.selfCanon.list(saveId, charId).filter(x => ['active', 'conflicts_canon'].includes(x.status))) {
      const status = conflicts(r.text, canon) ? 'conflicts_canon' : 'active';
      if (status !== r.status) { db.prepare('UPDATE self_canon SET status = ? WHERE id = ?').run(status, r.id); changed.push({ id: r.id, status }); }
    }
    return changed;
  }

  function save(saveId, charId, text, note = '') {
    const before = current(saveId, charId);
    const p = validate(text, fileCard(saveId, charId).name);
    const version = before.version + 1;
    db.prepare('INSERT INTO card_versions (save_id, char_id, version, text, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(saveId, charId, version, String(text).trim(), String(note || '').slice(0, 200), realNow());
    const oldCanon = parseCardV2(before.text).canon;
    const recheck = JSON.stringify(oldCanon) === JSON.stringify(p.canon) ? [] : recheckSelfCanon(saveId, charId, p.canon);
    return { ...current(saveId, charId), selfCanonChanged: recheck };
  }

  function restore(saveId, charId, version) {
    const v = versions(saveId, charId).find(x => x.version === Number(version));
    if (!v) throw new CardError(`没有第 ${version} 版`);
    return save(saveId, charId, v.text, `恢复为第 ${v.version} 版`);
  }

  /** Character overrides for lab.scene: { charId: { version, text } } for characters with saved versions. */
  function overrides(saveId) {
    const rows = db.prepare('SELECT char_id, max(version) v FROM card_versions WHERE save_id = ? GROUP BY char_id').all(saveId);
    return Object.fromEntries(rows.map(r => [r.char_id, { version: r.v, text: latestRow(saveId, r.char_id).text }]));
  }

  return { current, versions, save, restore, validate, overrides, version: (saveId, charId) => latestRow(saveId, charId)?.version ?? 0 };
}

/**
 * Drafts a whole card from looks + one-line persona (B6). Never saves. The draft must pass B1's parser; one retry
 * with the parser's error, then the raw text comes back with that error so the author can fix it by hand.
 * → { text, ok, error, attempts }
 */
export async function draftCard(lab, { saveId = null, sceneId, looks = '', persona = '' }) {
  const scene = saveId ? lab.scene(saveId) : loadScene(sceneId || 'camp');
  const ids = [...scene.rooms.map(r => `${r.id}（${r.name}）`), ...scene.objects.map(o => `${o.id}（${o.name}）`)].join('、');
  const user = render('card-draft', { looks: String(looks).slice(0, 2000) || '（没有给）', persona: String(persona).slice(0, 300) || '（没有给）', scene_ids: ids, actions: Object.keys(scene.actions).join('、') });
  const system = '你是角色设定编辑。只输出 JSON。';
  let note = '', last = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const out = await lab.llm.callChecked({ purpose: 'card_draft', system, user: user + note, saveId, mockInput: { looks, persona }, maxTokens: 4000 });
    last = out.card;
    try {
      parseCardV2(last);
      return { text: last, ok: true, error: null, attempts: attempt };
    } catch (e) {
      note = `\n\n（上一次的卡解析失败：${e.message}。改正后重新输出整张卡。）`;
      if (attempt === 2) return { text: last, ok: false, error: e.message, attempts: attempt };
    }
  }
  return { text: last, ok: false, error: '没有生成', attempts: 2 };
}
