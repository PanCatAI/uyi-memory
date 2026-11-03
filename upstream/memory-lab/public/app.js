// Wires the three columns, the top bar and the dialogs to the local server.
import { api, esc } from './api.js';
import { createScene3d } from './scene3d.js';
import { createChat } from './chat.js';
import { createInspector } from './inspector.js';

const $ = id => document.getElementById(id);
// ?save=<id> (links from the three-arm page) opens that save.
const st = { saveId: new URLSearchParams(location.search).get('save') || localStorage.getItem('lab.save') || null, charId: null, state: null, sending: false, poll: null };

function toast(text, bad = false) {
  const t = $('toast');
  t.textContent = text; t.className = `toast${bad ? ' bad' : ''}`; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 4000);
}
const guard = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

const scene3d = createScene3d($('scene'));
window.lab3d = scene3d; // console / browser tests: lab3d.debug()
const chat = createChat($('messages'), {
  onRef: ref => inspector.focusRef(ref),
  onForgetConfirm: guard(async (id, card) => {
    card?.querySelectorAll('button').forEach(b => { b.disabled = true; });
    const job = await api.post(`/api/forget/${id}/confirm`);
    chat.forgetReport(job);
    await refresh();
  }),
  onForgetCancel: guard(async (id, card) => {
    await api.post(`/api/forget/${id}/cancel`);
    card?.remove();
    inspector.render();
  })
});
const inspector = createInspector($('inspector-tabs'), $('inspector'), {
  getCtx: () => ({ saveId: st.saveId, charId: st.charId }),
  onWorld: () => refresh(),
  onForget: guard(async (verb, ref) => {
    const job = await api.post('/api/forget', { save: st.saveId, character: st.charId, verb, refs: [ref], topic: ref });
    chat.forgetCard(job);
  })
});
scene3d.onPick((id, kind) => {
  if (kind === 'character' && st.state?.scene.characters.some(c => c.id === id)) selectChar(id);
  inspector.filterTarget(id);
});

const charName = id => st.state?.scene.characters.find(c => c.id === id)?.name || id;
const thingName = id => {
  const s = st.state?.scene;
  return s?.objects.find(o => o.id === id)?.name || s?.palette.find(p => p.id === id)?.name || st.state?.world.objects[id]?.name || s?.rooms.find(r => r.id === id)?.name || charName(id);
};

// ---- saves ----
async function loadSaves() {
  const saves = await api.get('/api/saves');
  if (!saves.some(s => s.id === st.saveId)) st.saveId = saves[0]?.id || null;
  $('save-select').innerHTML = saves.map(s => `<option value="${s.id}" ${s.id === st.saveId ? 'selected' : ''}>${esc(s.name)}${s.mock ? '（剧本）' : ''}</option>`).join('') || '<option value="">（没有存档）</option>';
  return saves;
}
async function openSave(id) {
  st.saveId = id || null;
  try { localStorage.setItem('lab.save', st.saveId || ''); } catch { /* private window */ }
  chat.clear();
  if (!st.saveId) { st.state = null; renderTop(); inspector.render(); return; }
  st.state = await api.get(`/api/state?save=${st.saveId}`);
  if (!st.state.scene.characters.some(c => c.id === st.charId)) st.charId = st.state.scene.characters[0].id;
  scene3d.load(st.state.scene, st.state.world, { assetBase: `/api/assets/${encodeURIComponent(st.saveId)}/`, env: st.state.env });
  await loadGlbs();
  renderTabs(); renderGod(); renderTop();
  await replayChat();
  inspector.render();
}
// Rebuild the visible chat from the ledger so switching saves or reloading keeps the conversation.
// Each reply comes back with its turn group: action and check, errors, tokens and the comparison columns.
async function replayChat() {
  chat.clear();
  const [evs, groups] = await Promise.all([api.get(`/api/events?save=${st.saveId}&limit=2000`), api.get(`/api/turn-groups?save=${st.saveId}&character=${st.charId}`)]);
  const byReply = new Map(groups.filter(g => g.replySeq != null).map(g => [g.replySeq, g]));
  for (const e of evs) {
    if (e.type === 'user_said' && e.payload?.to === st.charId) chat.user(e.tombstone ? '（已删除）' : e.payload.text);
    else if (e.type === 'char_said' && e.actor === st.charId) {
      const g = byReply.get(e.seq);
      const mem = { ...(g?.modes.memory || { tokens: '—' }), delivered: e.tombstone ? '（已删除）' : e.payload.text, used: e.payload?.used || [] };
      if (g?.modes.full || g?.modes.none) chat.compare(charName(e.actor), mem, g.modes);
      else chat.char(charName(e.actor), mem);
    }
    else if (['session_start', 'session_end', 'time_skip', 'user_action', 'memory_op', 'scene_imported', 'world_edit', 'weather', 'fire_out', 'incident', 'weather_change'].includes(e.type) || (e.offscreen && !['var_changed', 'sky_sign', 'object_changed'].includes(e.type))) chat.host(`${e.text}`);
  }
}
async function refresh() {
  if (!st.saveId) return;
  st.state = await api.get(`/api/state?save=${st.saveId}`);
  scene3d.update(st.state.world, false, st.state.env);
  renderTop();
  inspector.render();
}
// Logical calls first, actual attempts in brackets when retries happened; unpriced attempts are said, never shown as $0.
function costText(u) {
  const calls = `调用 ${u.logical ?? u.calls} 次${u.calls !== (u.logical ?? u.calls) ? `（实际尝试 ${u.calls}）` : ''}`;
  if (!u.calls) return calls;
  const priced = u.calls - u.unpriced;
  const money = !priced ? '未计价' : `$${u.cost.toFixed(4)}${u.unpriced ? ` + ${u.unpriced} 次未计价` : ''}`;
  return `${calls} · ${money}`;
}
function renderTop() {
  const s = st.state;
  // 2.0 D1: say when someone is asleep (in the tent at night), so the user knows why she only half hears.
  const asleep = s ? Object.entries(s.life || {}).filter(([, l]) => l?.asleep).map(([id]) => `${charName(id)}在帐篷里睡了`) : [];
  $('clock').textContent = s ? [s.clockText, ...asleep].join(' · ') : '—';
  $('session-toggle').textContent = s?.save.session_open ? '结束会话' : '开始会话';
  $('jobs').textContent = s?.jobsPending ? `后台整理中 ${s.jobsPending}…` : (s?.jobErrors?.length ? `后台出错 ${s.jobErrors.length}` : '');
  $('cost').textContent = s ? costText(s.usage) : '';
  for (const b of document.querySelectorAll('[data-advance], #session-toggle, #send, #god-run')) b.disabled = !s;
  clearTimeout(st.poll);
  if (s?.jobsPending) st.poll = setTimeout(guard(refresh), 1500);
  lifeTicker(Boolean(s?.save.session_open));
}
// 2.0 D1: while a session is open, every 45 real seconds the world moves 5 minutes and she gets on with her 作息.
const TICK_REAL_MS = 45_000;
function lifeTicker(on) {
  if (!on) { clearInterval(st.ticker); st.ticker = null; return; }
  if (st.ticker) return;
  st.ticker = setInterval(guard(async () => {
    if (st.sending || !st.saveId || !st.state?.save.session_open) return;
    const r = await api.post(`/api/saves/${st.saveId}/tick`, {});
    if (!r.events.length && r.skipped) return;
    for (const e of r.events) if (['weather', 'fire_out'].includes(e.type) || e.payload?.routine) chat.host(e.text);
    scene3d.play(r.events, st.state.world);
    // 2.0 D2: she spoke up on her own; mentions count once the bubble is shown.
    for (const x of r.idle || []) {
      if (!x.spoke) continue;
      chat.char(charName(x.character), { delivered: x.say, used: [], tokens: '—' });
      scene3d.say(x.character, x.say);
      await api.post('/api/delivered', { turnId: x.turnId });
    }
    await refresh();
  }), TICK_REAL_MS);
}
function renderTabs() {
  $('char-tabs').innerHTML = st.state.scene.characters.map(c => `<button data-char="${c.id}" aria-selected="${c.id === st.charId}">${esc(c.name)}</button>`).join('');
}
async function selectChar(id) {
  if (id === st.charId) return;
  st.charId = id;
  renderTabs();
  await replayChat();
  inspector.render();
}
$('char-tabs').addEventListener('click', ev => { const b = ev.target.closest('[data-char]'); if (b) guard(selectChar)(b.dataset.char); });

// ---- top bar ----
$('save-select').addEventListener('change', e => guard(openSave)(e.target.value));
$('save-new').addEventListener('click', guard(async () => {
  const name = prompt('存档名字', `测试 ${new Date().toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`);
  if (name === null) return;
  const s = await api.post('/api/saves', { name: name || '新存档', sceneId: 'island' });
  st.saveId = s.id;
  await loadSaves(); await openSave(s.id);
}));
$('save-delete').addEventListener('click', guard(async () => {
  if (!st.saveId || !confirm('删除这个存档和它的全部记忆？不能撤销。')) return;
  await api.del(`/api/saves/${st.saveId}`);
  st.saveId = null;
  await loadSaves(); await openSave(st.saveId);
}));
for (const b of document.querySelectorAll('[data-advance]')) b.addEventListener('click', guard(async () => {
  const wasOpen = st.state.save.session_open;
  const r = await api.post('/api/time', { save: st.saveId, advance: b.dataset.advance });
  for (const e of r.events) chat.host(e.text);
  // Skipping time mid-conversation: pick the session back up right away, so what happened while away shows now,
  // not only when the user next speaks.
  if (wasOpen) hostLines((await api.post('/api/session', { save: st.saveId, op: 'start' })).events);
  await refresh();
}));
$('session-toggle').addEventListener('click', guard(async () => {
  const op = st.state.save.session_open ? 'end' : 'start';
  const r = await api.post('/api/session', { save: st.saveId, op });
  hostLines(r.events);
  // 2.0 D9: one line on how today felt (skippable); listed at the bottom of the 关系 page.
  if (op === 'end') {
    const note = prompt('今天感觉怎样？（一句话，可以不写）');
    if (note && note.trim()) await api.post(`/api/saves/${st.saveId}/playtest-notes`, { text: note });
  }
  await refresh();
}));

// 3.0 F5: with the world on, a night away writes dozens of small changes (柴 −1, the weather, the sky). The chat
// shows what happened to the camp (营地) and what she did; the rest is in the 世界 tab and the ledger.
const QUIET_TYPES = ['var_changed', 'weather', 'weather_change', 'sky_sign', 'object_changed', 'char_moved'];
function hostLines(evs) {
  const camp = evs.filter(e => e.type === 'incident');
  const world = evs.some(e => e.type === 'var_changed' || e.type === 'incident'); // only 3.0 saves write these
  for (const e of evs) {
    // 3.0 G2: the scout's finds are the user's alone: shown here, never in her context.
    if (e.type === 'user_action' && e.action === 'scout') {
      const defs = st.state?.scene?.scout?.finds || [];
      const finds = (e.payload?.args?.finds || []).map(id => defs.find(d => d.id === id)).filter(Boolean);
      chat.host(`你今天去${e.payload?.args?.dir}探了路，看见了（只有你知道，想让她知道就告诉她）：\n${finds.map(f => `· ${f.text}，离营地大约 ${f.li} 里`).join('\n') || '· 什么也没找到'}`);
      continue;
    }
    if (e.type === 'incident' || (world && e.offscreen && QUIET_TYPES.includes(e.type))) continue;
    chat.host(e.offscreen ? `你不在的时候：${e.text}` : e.text);
  }
  if (camp.length) chat.host(`营地发生的事：\n${camp.map(e => `· ${e.text}`).join('\n')}`);
}

// ---- chat ----
async function send() {
  const text = $('input').value.trim();
  if (!text || st.sending || !st.saveId) return;
  st.sending = true; $('send').disabled = true; $('input').value = '';
  chat.user(text);
  try {
    const r = await api.post('/api/chat', { save: st.saveId, character: st.charId, text, compare: $('compare').checked });
    hostLines(r.opened);
    if (r.compare) chat.compare(charName(st.charId), r.reply, r.compare);
    else chat.char(charName(st.charId), r.reply);
    if (r.forgetJob) chat.forgetCard(r.forgetJob);
    scene3d.play(r.events, st.state.world);
    scene3d.say(st.charId, r.reply.delivered ?? r.reply.say);
    // Only now has the user seen the reply: mentions count from here.
    await api.post('/api/delivered', { turnId: r.turnId });
    inspector.showTurn(r.turnId);
    await refresh();
  } catch (e) { chat.error(e.message); }
  finally { st.sending = false; $('send').disabled = false; $('input').focus(); }
}
$('composer').addEventListener('submit', ev => { ev.preventDefault(); send(); });
$('input').addEventListener('keydown', ev => { if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); send(); } });

// ---- god panel ----
function renderGod() {
  const s = st.state.scene, w = st.state.world;
  const action = $('god-action').value;
  const opt = (id, name) => `<option value="${id}">${esc(name)}</option>`;
  const portable = x => x.tags?.includes('portable');
  const placed = Object.values(w.objects).map(o => opt(o.id, o.name));
  const fresh = s.palette.filter(p => !w.objects[p.id]);
  const palette = fresh.map(p => opt(p.id, `${p.name}（新）`));
  const rooms = s.rooms.map(r => opt(r.id, r.name));
  const chars = s.characters.map(c => opt(c.id, c.name));
  const [targets, args] = {
    give: [[...fresh.filter(portable).map(p => opt(p.id, `${p.name}（新）`)), ...Object.values(w.objects).filter(portable).map(o => opt(o.id, o.name))], chars.map(c => c.replace('value="', 'value="to:'))],
    build: [palette, rooms], place: [palette, rooms],
    move_object: [placed, rooms], move_character: [chars, rooms],
    // 3.0 F3/F4 (with the world on)
    cover_wood: [[opt('wood-crate-1', '木箱边的柴')], []],
    help: [Object.values(w.incidents || {}).map(i => opt(i.id, st.state.scene.incidents?.find(x => x.id === i.id)?.name || i.id)), []]
  }[action] || [[], []];
  $('god-target').innerHTML = targets.join('') || '<option value="">（没有可选的）</option>';
  $('god-arg').innerHTML = action === 'give' ? args.join('') : args.map(o => o.replace('value="', 'value="room:')).join('');
  $('glb-target').innerHTML = [...s.characters.map(c => opt(c.id, `角色：${c.name}`)), ...Object.values(w.objects).map(o => opt(o.id, o.name))].join('');
}
$('god-action').addEventListener('change', () => st.state && renderGod());
$('god-run').addEventListener('click', guard(async () => {
  const [k, v] = $('god-arg').value.split(':');
  const action = $('god-action').value;
  const args = action === 'help' ? { incident: $('god-target').value } : action === 'cover_wood' ? {} : { [k === 'to' ? 'to' : 'room']: v };
  const r = await api.post('/api/act', { save: st.saveId, action, target: $('god-target').value, args });
  for (const e of r.events) if (e.type === 'user_action') chat.host(e.text);
  await refresh(); renderGod();
}));

// ---- GLB from 造物台 (display only, nothing goes into the ledger) ----
scene3d.onNotice(text => { toast(text, true); inspector.notice?.(text); });
scene3d.onGlbError((id, message) => toast(`${thingName(id)} 的模型没加载出来，先用原来的样子：${message}`, true));
async function loadGlbs() {
  const list = await api.get(`/api/assets?save=${st.saveId}`);
  for (const a of list) scene3d.setGlb(a.id, a.url);
}
$('glb-file').addEventListener('change', guard(async ev => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file || !st.saveId) return;
  const id = $('glb-target').value;
  const r = await fetch(`/api/assets/${st.saveId}/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'Content-Type': 'model/gltf-binary' }, body: file });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || '上传失败');
  scene3d.setGlb(id, data.url);
  toast(`${thingName(id)} 换成了 ${file.name}`);
}));

// ---- settings ----
const PRESETS = { deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' } };
async function openSettings() {
  const s = await api.get('/api/settings');
  const d = $('settings');
  d.innerHTML = `<form method="dialog" class="dialog-body">
    <h2>模型设置</h2>
    <label class="field">服务商<select name="provider"><option value="deepseek">DeepSeek</option><option value="custom">其它 OpenAI 兼容接口</option><option value="mock">假模型（不花钱）</option></select></label>
    <label class="field">接口地址<input name="baseUrl" value="${esc(s.baseUrl)}"></label>
    <label class="field">对话模型<input name="model" value="${esc(s.model)}"></label>
    <label class="field">后台模型<input name="modelBackground" value="${esc(s.modelBackground)}" placeholder="留空 = 和对话模型一样"></label>
    <label class="field">裁判模型<input name="modelJudge" value="${esc(s.modelJudge || '')}" placeholder="人设漂移打分用，要和对话模型不同；留空 = 不打分"></label>
    <label class="field">造物台端口<input name="studioPort" value="${esc(s.studioPort || '')}" placeholder="留空 = 4320"></label>
    <label class="field">API Key<input name="apiKey" type="password" autocomplete="off" placeholder="${s.keySet ? `已保存 ${esc(s.keyMasked)}，留空不改` : '粘贴 Key，只存在本机 .env'}"></label>
    <label class="field">额外参数（JSON）<input name="extraBody" value="${esc(s.extraBody)}" placeholder='例如 {"thinking":{"type":"disabled"}}'></label>
    <div class="row3"><label class="field">输入 $/百万<input name="pin" value="${esc(s.prices.input)}"></label><label class="field">缓存命中 $/百万<input name="pcached" value="${esc(s.prices.cached)}"></label><label class="field">输出 $/百万<input name="pout" value="${esc(s.prices.output)}"></label></div>
    <p id="test-result" class="muted small"></p>
    <div class="actions"><button type="button" id="settings-test">测试连接</button><span class="grow"></span><button value="cancel">关闭</button><button class="primary" type="button" id="settings-save">保存</button></div>
  </form>`;
  const f = d.querySelector('form');
  f.provider.value = s.provider === 'mock' ? 'mock' : s.baseUrl.includes('deepseek.com') ? 'deepseek' : 'custom';
  f.provider.addEventListener('change', () => { const p = PRESETS[f.provider.value]; if (p) { f.baseUrl.value = p.baseUrl; f.model.value = p.model; } });
  const save = async () => api.post('/api/settings', { provider: f.provider.value === 'mock' ? 'mock' : 'openai_compat', baseUrl: f.baseUrl.value, model: f.model.value, modelBackground: f.modelBackground.value, modelJudge: f.modelJudge.value, studioPort: f.studioPort.value, extraBody: f.extraBody.value, apiKey: f.apiKey.value || undefined, prices: { input: f.pin.value, cached: f.pcached.value, output: f.pout.value } });
  d.querySelector('#settings-save').addEventListener('click', guard(async () => { await save(); d.close(); toast('设置已保存'); }));
  d.querySelector('#settings-test').addEventListener('click', guard(async () => {
    const out = d.querySelector('#test-result');
    out.textContent = '保存并测试中…';
    await save(); f.apiKey.value = '';
    const r = await api.post('/api/settings/test');
    out.innerHTML = r.ok ? `<span class="good">连上了</span> · 实际模型 <b>${esc(r.model)}</b> · ${r.latency_ms} ms` : `<span class="bad">没连上：${esc(r.error)}</span>`;
  }));
  d.showModal();
}
$('open-settings').addEventListener('click', guard(openSettings));

// ---- 造物台 import (2.0 C1) ----
async function openStudio() {
  const d = $('studio');
  d.innerHTML = '<div class="dialog-body"><h2>从造物台导入</h2><p class="muted">正在读造物台…</p></div>';
  d.showModal();
  let cat;
  try { cat = await api.get('/api/studio/catalog'); }
  catch (e) { d.querySelector('p').outerHTML = `<p class="bad">${esc(e.message)}</p><div class="actions"><span class="grow"></span><button id="studio-close">关闭</button></div>`; d.querySelector('#studio-close').onclick = () => d.close(); return; }
  const cur = st.state?.save;
  const curNames = (st.state?.scene?.characters || []).map(c => c.name);
  if (!curNames.length) curNames.push('岚');
  const opt = (xs, pick) => xs.map(x => `<option value="${esc(x.id)}"${pick(x) ? ' selected' : ''}>${esc(x.name)}</option>`).join('');
  d.innerHTML = `<form method="dialog" class="dialog-body">
    <h2>从造物台导入</h2>
    <p class="muted small">只读：从 ${esc(cat.url)} 下载模型到本存档，造物台里什么都不改。</p>
    <label class="field">场景<select name="scene">${opt(cat.scenes, x => x.name === '篝火营地 v2')}</select></label>
    <div class="field">人物<div>${cat.characters.map(x => `<label class="check"><input type="checkbox" name="who" value="${esc(x.id)}"${curNames.some(n => x.name.startsWith(n)) ? ' checked' : ''}> ${esc(x.name)}</label>`).join(' ')}</div></div>
    <p class="muted small">勾几个，营地里就有几个人，对话框上方可以切换。名字和性格用 characters/ 里同名的角色卡，没有专属卡的用一张通用的友善卡。换了人物会默认新建存档，免得带上之前的记忆。</p>
    <label class="field">存档<select name="target"><option value="new">新建营地存档</option>${cur?.scene_id === 'camp' ? `<option value="current" selected>导入到当前存档「${esc(cur.name)}」</option>` : ''}</select></label>
    <p class="muted small">动作库：${cat.animations.filter(a => a.ual).map(a => `${esc(a.name)}（${a.clips} 段）`).join('、') || '没有 UAL 动作库'}</p>
    <p id="studio-result" class="muted small"></p>
    <div class="actions"><span class="grow"></span><button value="cancel">关闭</button><button class="primary" type="button" id="studio-go">导入</button></div>
  </form>`;
  const f = d.querySelector('form');
  // A different person than the save's current one: default to a fresh save so memories don't carry over.
  const picked = () => cat.characters.filter(x => f.querySelector(`[name=who][value="${CSS.escape(x.id)}"]`)?.checked);
  const samePeople = () => { const p = picked(); return p.length === curNames.length && p.every(x => curNames.some(n => x.name.startsWith(n))); };
  f.addEventListener('change', ev => { if (ev.target.name === 'who' && !samePeople()) f.target.value = 'new'; });
  d.querySelector('#studio-go').addEventListener('click', guard(async () => {
    const out = d.querySelector('#studio-result');
    d.querySelector('#studio-go').disabled = true;
    out.textContent = '下载中（模型较大，可能要一会儿）…';
    try {
      const people = picked();
      if (!people.length) throw new Error('至少勾一个人物。');
      // The first person takes the scene's character slot (lan); the others get an id from their studio asset.
      const characters = Object.fromEntries(people.map((x, i) => [i ? x.id.toLowerCase().replace(/[^a-z0-9_-]/g, '-') : 'lan', x.id]));
      let saveId = st.saveId;
      if (f.target.value === 'new') saveId = (await api.post('/api/saves', { name: `${f.scene.selectedOptions[0]?.textContent || '营地'} · ${people.map(x => x.name.split(' · ')[0]).join('、')}`, sceneId: 'camp' })).id;
      const r = await api.post(`/api/saves/${saveId}/import-studio`, { scene: f.scene.value, characters });
      out.innerHTML = `<span class="good">${r.changed ? '导入好了' : '和上次一样，没有变化'}</span>${r.edits ? ` · 你搭的改动 ${r.edits} 处` : ''} · ${r.objects} 个物件 · ${r.rooms} 个区域 · ${r.files} 个文件（${(r.bytes / 1048576).toFixed(1)} MB）`;
      st.saveId = saveId;
      await loadSaves(); await openSave(saveId);
    } finally { d.querySelector('#studio-go').disabled = false; }
  }));
}
$('open-studio').addEventListener('click', guard(openStudio));

// ---- scenarios ----
// The dialog's click listener is registered once (below); opening the dialog only redraws it. While anything runs,
// every run button is disabled, and each click carries its own requestId so a resent request never runs twice.
const sc = { list: [], busy: false };
const scDialog = $('scenarios');
const requestId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
const scProvider = () => scDialog.querySelector('[name=prov]:checked')?.value || 'live';
// The model choice is remembered between openings; real model by default.
const scSavedProv = () => { try { return localStorage.getItem('sc-prov') === 'mock' ? 'mock' : 'live'; } catch { return 'live'; } };
function scShowRun(run) {
  const cell = scDialog.querySelector(`[data-sc="${run.scenarioId}"] .sc-result`);
  const label = { passed: ['通过', 'good'], failed: ['失败', 'bad'], error: ['出错', 'bad'], running: [`${run.step}/${run.total}`, ''] }[run.state] || [run.state, ''];
  if (cell) cell.innerHTML = `<span class="tag ${label[1]}">${label[0]}</span> <a href="#" data-open-save="${run.saveId}">打开存档</a>`;
  const s = run.summary || {};
  const mark = r => (r.review ? ['待判读', 'warn'] : r.skip ? ['跳过', ''] : r.ok === false ? ['✗', 'bad'] : ['✓', 'good']);
  scDialog.querySelector('#sc-detail').innerHTML = `<h3>${esc(run.title)} · ${run.provider === 'live' ? '真模型' : '假模型'} <a href="/api/scenario-runs/${run.id}/export" download="剧本运行-${run.scenarioId}-${run.id}.json">导出</a></h3>
    <div class="row"><span class="tag good">自动断言通过 ${s.auto_pass ?? 0}</span><span class="tag bad">失败 ${s.auto_fail ?? 0}</span><span class="tag">跳过 ${s.skipped ?? 0}</span><span class="tag warn">待人工判读 ${s.review_pending ?? 0}</span><span class="muted small">跳过和待判读都不算通过</span></div>
    ${run.state === 'running' ? `<button data-next="${run.id}">下一步（${run.step + 1}/${run.total}）</button>` : ''}
    ${run.results.map(r => { const [t, c] = mark(r); return `<div class="row ${r.ok === false || r.review ? '' : 'dim'}"><span class="tag ${c}">${t}</span>${r.step + 1}. ${esc(r.kind)} · ${esc(r.detail)}${r.input ? `<div class="small">你：${esc(r.input)}</div>` : ''}${r.reply ? `<div class="small">角色：${esc(r.reply)}${r.action ? ` <span class="muted">🎬 ${esc((Array.isArray(r.action) ? r.action : [r.action]).map(a => `${a.name} ${a.target || ''}`).join(' → '))}${r.action.result?.ok === false ? `（没做成：${esc(r.action.result.reason)}）` : ''}</span>` : ''}</div>` : ''}${r.compare ? Object.entries(r.compare).map(([m, v]) => `<div class="muted small">${m === 'full' ? '聊天原文' : '短上下文'}：${esc(v)}</div>`).join('') : ''}</div>`; }).join('')}`;
  scSetBusy(sc.busy);
}
function scSetBusy(busy) {
  sc.busy = busy;
  for (const b of scDialog.querySelectorAll('[data-run], [data-step], [data-next], [data-arms], #sc-all')) b.disabled = busy;
}
async function scRun(fn) {
  if (sc.busy) return;
  scSetBusy(true);
  try { await fn(); } finally { scSetBusy(false); }
}
const scLabel = { passed: ['通过', 'good'], failed: ['失败', 'bad'], error: ['出错', 'bad'], running: ['进行中', ''] };
async function scHistory() {
  const runs = await api.get('/api/scenario-runs?limit=30');
  const fmtT = ms => new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(ms);
  scDialog.querySelector('#sc-history').innerHTML = runs.length ? `<table class="ledger"><tr><th>时间</th><th>剧本</th><th>模型</th><th>结果</th><th>通过/失败/跳过/待判读</th><th></th></tr>${runs.map(r => { const [t, c] = scLabel[r.state] || [r.state, '']; const s = r.summary; return `<tr><td>${fmtT(r.real_at)}</td><td>${esc(r.title.split('：')[0])}</td><td>${r.provider === 'live' ? '真模型' : '假模型'}</td><td><span class="tag ${c}">${t}</span></td><td>${s.auto_pass}/${s.auto_fail}/${s.skipped}/${s.review_pending}</td><td><a href="#" data-show-run="${r.id}">查看</a> <a href="#" data-open-save="${r.saveId}">打开存档</a></td></tr>`; }).join('')}</table>` : '<p class="muted">还没有运行记录。</p>';
}
async function openScenarios() {
  sc.list = await api.get('/api/scenarios');
  scDialog.innerHTML = `<div class="dialog-body wide">
    <h2>测试剧本</h2>
    <div class="row"><label class="check"><input type="radio" name="prov" value="live"${scSavedProv() === 'live' ? ' checked' : ''}> 真模型</label><label class="check" title="不调用大模型，用写好的固定回复，只检查程序逻辑"><input type="radio" name="prov" value="mock"${scSavedProv() === 'mock' ? ' checked' : ''}> 假模型（只测程序，不调模型）</label><span class="grow"></span><a href="/arms.html" target="_blank">三路对照结果</a><button id="sc-all">全部跑一遍</button><button id="sc-close">关闭</button></div>
    <table class="ledger"><tr><th>剧本</th><th>步数</th><th></th><th>结果</th></tr>${sc.list.map(s => `<tr data-sc="${s.id}"><td>${esc(s.title)}<div class="muted small">${s.id}</div></td><td>${s.steps}</td><td><button data-run="${s.id}">运行</button> <button data-step="${s.id}">单步</button> <button data-arms="${s.id}" title="同一个剧本复制成三个存档，分别用记忆 / 全量对话 / 短上下文当真正的回复方式从头跑到尾">三路平行跑</button></td><td class="sc-result muted">—</td></tr>`).join('')}</table>
    <h3>运行记录</h3><div id="sc-history" class="small"></div>
    <div id="sc-detail"></div></div>`;
  await scHistory();
  scSetBusy(sc.busy);
  scDialog.showModal();
}
scDialog.addEventListener('click', guard(async ev => {
  const t = ev.target.closest('button, a');
  if (!t) return;
  if (t.id === 'sc-close') return scDialog.close();
  if (t.dataset.showRun) { ev.preventDefault(); return scShowRun(await api.get(`/api/scenario-runs/${t.dataset.showRun}`)); }
  if (t.dataset.openSave) { ev.preventDefault(); scDialog.close(); await loadSaves(); $('save-select').value = t.dataset.openSave; return openSave(t.dataset.openSave); }
  if (!(t.dataset.run || t.dataset.step || t.dataset.next || t.dataset.arms || t.id === 'sc-all') || t.disabled || sc.busy) return;
  const provider = scProvider();
  if (provider === 'live' && !t.dataset.next && !confirm(t.dataset.arms ? '三路平行跑会用真模型跑三遍（约 3 倍花费），继续？' : '用真模型跑剧本会调用付费接口，继续？')) return;
  await scRun(async () => {
    if (t.dataset.run) scShowRun(await api.post(`/api/scenarios/${t.dataset.run}/run`, { provider, requestId: requestId() }));
    if (t.dataset.step) scShowRun(await api.post(`/api/scenarios/${t.dataset.step}/run`, { provider, step: true, requestId: requestId() }));
    if (t.dataset.next) scShowRun(await api.post(`/api/scenario-runs/${t.dataset.next}/step`));
    if (t.dataset.arms) {
      const cell = scDialog.querySelector(`[data-sc="${t.dataset.arms}"] .sc-result`);
      if (cell) cell.textContent = '三路跑中…';
      const g = await api.post(`/api/scenarios/${t.dataset.arms}/arms`, { provider, requestId: requestId() });
      if (cell) cell.innerHTML = `${g.arms.map(a => `${esc(a.title)} ${a.summary?.auto_pass ?? 0}/${a.summary?.auto_fail ?? 0}`).join(' · ')} <a href="/arms.html?group=${g.group}" target="_blank">看并排结果</a>`;
    }
    if (t.id === 'sc-all') for (const s of sc.list) scShowRun(await api.post(`/api/scenarios/${s.id}/run`, { provider, requestId: requestId() }));
  });
  await scHistory();
}));
$('open-scenarios').addEventListener('click', guard(openScenarios));
scDialog.addEventListener('change', ev => { if (ev.target.name === 'prov') try { localStorage.setItem('sc-prov', ev.target.value); } catch { /* not remembered */ } });

guard(async () => { await loadSaves(); await openSave(st.saveId); })();
