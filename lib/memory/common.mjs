// Small read helpers shared by the memory modules.
import { pj } from '../db.mjs';
import { formatSpan } from '../clock.mjs';

export const SPEECH = ['user_said', 'char_said'];
export const parseRef = ref => { const i = String(ref).indexOf(':'); return i < 0 ? { kind: null, id: ref } : { kind: ref.slice(0, i), id: ref.slice(i + 1) }; };

export function factRow(r) { return r && { ...r, source_seqs: pj(r.source_seqs, []) }; }
export function cacheRow(r) { return r && { ...r, derived_from: pj(r.derived_from, []), fact_ids: pj(r.fact_ids, []) }; }
export function commitRow(r) { return r && { ...r, source_seqs: pj(r.source_seqs, []) }; }

export function sessionInfo(lab, saveId) {
  const save = lab.saves.getSave(saveId);
  const starts = lab.ledger.list(saveId, { types: ['session_start'], all: true });
  const ends = lab.ledger.list(saveId, { types: ['session_end'], all: true });
  const cur = save.session_id ? starts.filter(e => e.session_id === save.session_id).at(-1) || null : null;
  const prevEnd = cur ? ends.filter(e => e.seq < cur.seq).at(-1) || null : ends.at(-1) || null;
  const prevStart = prevEnd ? starts.filter(e => e.seq < prevEnd.seq).at(-1) || null : null;
  return { save, current: cur, previousEnd: prevEnd, previousStart: prevStart, previousSessionId: prevStart?.session_id ?? null };
}

/** Number of user_said since the current session_start (all characters). */
export function turnIndexInSession(lab, saveId) {
  const { current } = sessionInfo(lab, saveId);
  if (!current) return 0;
  return lab.ledger.list(saveId, { after: current.seq, types: ['user_said'], all: true }).length;
}

export const nameOf = (scene, id) => (id === 'user' ? '用户' : scene.characters.find(c => c.id === id)?.name || scene.objects.find(o => o.id === id)?.name || scene.palette.find(o => o.id === id)?.name || scene.rooms.find(r => r.id === id)?.name || id);

export function getWatermark(lab, saveId, charId, job) {
  return lab.db.prepare('SELECT seq FROM watermarks WHERE save_id = ? AND character_id = ? AND job = ?').get(saveId, charId, job)?.seq ?? 0;
}
export function setWatermark(lab, saveId, charId, job, seq) {
  lab.db.prepare('INSERT INTO watermarks (save_id, character_id, job, seq) VALUES (?, ?, ?, ?) ON CONFLICT (save_id, character_id, job) DO UPDATE SET seq = excluded.seq').run(saveId, charId, job, seq);
}

/** Strip whitespace and punctuation for substring checks. */
export const norm = s => String(s ?? '').replace(/[\s，。！？、,.!?；;：:“”"'‘’（）()…~～—-]/g, '');

const VERB = { pick_up: '拿起了', put_down: '放下了', give: '递给了', wear: '戴上了', clean: '擦了', sit: '坐到了', climb: '爬上了', switch: '开关了', look_at: '看了看', walk_to: '走到了', wave: '挥了挥手', idle: '发了会儿呆', build: '搭了', place: '放了', move_object: '挪了', move_character: '叫来了',
  enter: '进了', leave: '走了出来', draw_map: '画了会儿图',
  gather_wood: '拾了柴', cover_wood: '盖好了', fix_tent: '重新打牢了', secure_crate: '捆紧了', forage: '在小路边找了找吃的', help: '搭了把手', scout: '去探了路' }; // 3.0 F/G // 2.0: the camp's actions too, so no id reaches a prompt or a diary
// 3.0 F: the camp's 量 in words.
const VAR_TEXT = { wood: '柴（捆）', wood_wet: '柴是湿的', wood_covered: '柴盖着', food: '口粮（天）', snowline: '雪线（米）', snowline_seen: '她看到的雪线', pass_open: '山口开了', tent_secure: '帐篷绳牢靠', tent_down: '帐篷塌了', ali_eta_days: '阿砾回来（第几天）', lan_tired: '累', crate_secure_until: '木箱捆到', forage_day: '找吃的那天', clues: '线索', map: '地图' };
const varValue = v => (v === true ? '是' : v === false ? '否' : v == null ? '—' : Array.isArray(v) ? `${v.length} 处` : String(v));
/** One readable line for any event (used for hints and the UI). */
export function eventText(scene, ev) {
  const n = id => nameOf(scene, id);
  const p = ev.payload || {};
  if (!ev.payload) return '（已删除）';
  if (ev.type === 'user_said' || ev.type === 'char_said') return p.text;
  if (ev.type === 'char_action' && ev.action === 'put_down' && ev.outcome === 'ok') return `${ev.offscreen ? '用户不在时，' : ''}${n(ev.actor)}把${p.held ? n(p.held) : '手里的东西'}放到了${n(ev.target)}上`;
  if (ev.type === 'char_action' && ev.action === 'give' && ev.outcome === 'ok') return `${ev.offscreen ? '用户不在时，' : ''}${n(ev.actor)}把${p.held ? n(p.held) : '手里的东西'}递给了用户`;
  if (ev.type === 'char_action' && ev.action === 'tend_fire') return `${ev.offscreen ? '用户不在时，' : ''}${n(ev.actor)}给${n(ev.target)}添了柴${ev.outcome === 'failed' ? `（没成功：${p.reason || ''}）` : ''}`;
  if (ev.type === 'char_action') return `${ev.offscreen ? '用户不在时，' : ''}${n(ev.actor)}${VERB[ev.action] || ev.action}${ev.target ? n(ev.target) : ''}${ev.outcome === 'failed' ? `（没成功：${p.reason || ''}）` : ''}`;
  if (ev.type === 'user_action' && ev.action === 'give') return `用户把${n(ev.target)}递给了${n(p.args?.to)}`;
  if (ev.type === 'user_action' && ev.action === 'move_character') return `用户把${n(ev.target)}叫到了${n(p.args?.room)}`;
  if (ev.type === 'user_action') return `用户${VERB[ev.action] || ev.action}${n(ev.target)}${p.args?.room ? `（${n(p.args.room)}）` : ''}`;
  if (ev.type === 'char_moved') return `${n(ev.actor)}从${n(p.from)}走到${n(p.to)}`;
  if (ev.type === 'object_created') return `${n(ev.room)}出现了${p.object?.name || n(ev.target)}`;
  if (ev.type === 'object_changed') return `${n(ev.target)}的${p.field}变了`;
  if (ev.type === 'session_start') return p.gap_ms ? `会话开始（隔了${formatSpan(p.gap_ms)}）` : '会话开始';
  if (ev.type === 'session_end') return '会话结束';
  if (ev.type === 'time_skip') return `时间过去了${formatSpan(p.to - p.from)}`;
  if (ev.type === 'object_removed') return `${n(ev.target)}不见了`;
  if (ev.type === 'world_edit') {
    const name = (p.op === 'add' ? p.object?.name : p.from?.name) || n(ev.target);
    if (p.op === 'add') return `用户（造物者）在${n(ev.room)}搭了${name}`;
    if (p.op === 'remove') return `用户（造物者）把${name}从${n(p.from?.room)}撤走了`;
    return `用户（造物者）把${name}挪到了${n(p.to?.room)}`;
  }
  if (ev.type === 'weather') return `今天的天气：${p.kind}${p.temp_hi != null ? `（${p.temp_lo}～${p.temp_hi}℃，风${p.wind}）` : ''}`;
  // 3.0 F: the world's own events. An incident says what happened in the words of the scene's table.
  if (ev.type === 'weather_change') return `天气转${p.kind}了（原来${p.from}）`;
  if (ev.type === 'sky_sign') return `傍晚的天象：${p.sign}`;
  if (ev.type === 'var_changed') return `${VAR_TEXT[p.var] || p.var}：${varValue(p.from)} → ${varValue(p.to)}（${p.cause}）`;
  if (ev.type === 'incident') {
    const inc = (scene.incidents || scene.worldFiles?.incidents?.incidents || []).find(i => i.id === p.incident);
    const what = inc?.text || p.incident;
    if (p.phase === 'start') return `${ev.offscreen ? '用户不在时，' : ''}${what}${p.news ? `：「${p.news}」` : ''}`;
    if (p.phase === 'expired') return `${inc?.name || p.incident}没人管，${inc?.on_expire?.set?.tent_down ? '帐篷塌了' : '过了时候'}`;
    return `${inc?.name || p.incident}解决了（${{ char: `${n(scene.characters[0].id)}弄好的`, user: '用户弄好的', together: '一起弄好的', host: '自己过去了' }[p.by] || p.by}）`;
  }
  // 3.0 G3/G4.
  if (ev.type === 'practice') {
    const pr = (scene.practices || scene.worldFiles?.practices?.practices || []).find(x => x.id === p.practice);
    const name = pr?.name || p.practice;
    return { start: `一起${name}开始了`, step: `一起${name}：到了第 ${(p.step ?? 0) + 1} 步${p.outcome ? `（${p.outcome}）` : ''}`, end: `一起${name}，做完了${p.outcome ? `（${p.outcome}）` : ''}`, abandon: `一起${name}没做完（${p.outcome || '放下了'}）` }[p.phase] || name;
  }
  if (ev.type === 'bet') {
    if (p.phase === 'made') return `打了个赌：${p.about}，${n(scene.characters[0].id)}押「${p.her_pick}」，用户押「${p.user_pick}」，赌注：${p.stake}`;
    return `赌分了输赢：${p.about}，${{ user: '用户赢了', draw: '谁也没押中' }[p.winner] || `${n(p.winner)}赢了`}`;
  }
  if (ev.type === 'relationship_stage') return `和用户的关系从「${p.from}」到了「${p.to}」`;
  if (ev.type === 'fire_out') return `${n(ev.target)}灭了`;
  if (ev.type === 'scene_imported') return `从造物台导入了场景（${p.files?.length || 0} 个文件）`;
  if (ev.type === 'memory_op') return { suppress: '用户请角色别再提一件事', forget: '用户请角色忘掉一件事', delete: '用户删除了一段记录', correct: '用户纠正了一条记忆' }[p.op] || ev.type;
  return ev.type;
}
