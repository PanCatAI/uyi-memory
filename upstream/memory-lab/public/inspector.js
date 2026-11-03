// Right column: what the memory system holds and what went into the last prompt.
import { api, esc } from './api.js';

// Self-claim states (contracts/schema.sql self_canon.status).
const SELF_STATUS = { active: '有效', conflicts_canon: '和设定冲突', conflicts_self: '和自己说过的说反了', superseded: '她改口了', no_event: '没发生过', forgotten: '已忘掉' };
const TABS = [['context', '本轮上下文'], ['facts', '事实'], ['memories', '经历'], ['commitments', '约定'], ['relationship', '关系'], ['ledger', '账本'], ['forget', '忘记'], ['cost', '费用'], ['card', '设定'], ['world', '世界']];
const PRED = { name: '名字', call_me: '希望被叫作', call_character: '怎么称呼你', job: '工作/学校', likes: '喜欢', dislikes: '讨厌', family: '家人/宠物', owns: '拥有', relation_to_object: '和物件的关系', plan: '打算', state: '近况', boundary: '不想要' };
const STATUS = { active: ['有效', 'good'], superseded: ['被取代', ''], expired: ['过期', ''], forgotten: ['已忘掉', 'bad'], open: ['进行中', 'good'], done: ['做到了', 'good'], dropped: ['没做到', 'bad'] };
const MODE_NAME = { memory: '当前记忆方案', full: '聊天原文（对照）', none: '短上下文（对照）' };
const STAGE = { ok: '成功', network: '网络失败', http: 'HTTP 失败', json: 'JSON 失败', shape: '格式不合规' };
const callsTable = calls => (calls.length ? `<table class="ledger"><tr><th>尝试</th><th>结果</th><th>模型</th><th>输入</th><th>输出</th><th>结束</th><th>延迟</th></tr>${calls.map(c => `<tr><td>${c.attempt}</td><td>${STAGE[c.stage] || c.stage}${c.error ? `<div class="muted small">${esc(c.error)}</div>` : ''}</td><td>${esc(c.model)}</td><td>${c.usage_known ? c.input_tokens : `<span class="muted">${c.input_tokens}（估算）</span>`}</td><td>${c.output_tokens}</td><td>${esc(c.finish_reason || '')}</td><td>${c.latency_ms} ms</td></tr>`).join('')}</table>` : '<p class="muted small">没有记录到调用（旧版本的轮次没有关联）。</p>');
const tag = s => { const [t, c] = STATUS[s] || [s, '']; return `<span class="tag ${c}">${esc(t)}</span>`; };
const fmt = ms => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(ms);

export function createInspector(tabsEl, el, { getCtx, onForget, onWorld }) {
  let tab = 'context', turnId = null, filter = null, flashRef = null;
  const notices = []; // 3D notices (2.0 C3: missing clips), shown at the top of the ledger tab
  let cardShown = null, cardNotice = null, cardDraft = null; // version picked in the settings tab (null = latest); message after save
  tabsEl.innerHTML = TABS.map(([id, name]) => `<button data-tab="${id}" aria-selected="${id === tab}">${name}</button>`).join('');
  tabsEl.addEventListener('click', ev => { const b = ev.target.closest('[data-tab]'); if (b) show(b.dataset.tab); });
  el.addEventListener('click', ev => {
    const f = ev.target.closest('[data-forget-ref]');
    if (f) onForget(f.dataset.verb, f.dataset.forgetRef);
    const t = ev.target.closest('[data-turn]');
    if (t) { turnId = t.dataset.turn; render(); }
    const s = ev.target.closest('[data-seq]');
    if (s) { flashRef = `ev:${s.dataset.seq}`; filter = null; show('ledger'); }
    if (ev.target.closest('[data-clear-filter]')) { filter = null; render(); }
    if (ev.target.closest('[data-card-save]')) saveCard();
    if (ev.target.closest('[data-card-draft]')) draft(ev.target.closest('[data-card-draft]'));
    if (ev.target.closest('[data-card-discard]')) { cardDraft = null; cardNotice = null; render(); }
    const rc = ev.target.closest('[data-card-restore]');
    if (rc) restoreCard(Number(rc.dataset.cardRestore));
    const rj = ev.target.closest('[data-retry-job]');
    if (rj) {
      rj.disabled = true;
      api.post('/api/jobs/retry', { save: getCtx().saveId, ...(rj.dataset.retryJob === 'all' ? {} : { id: rj.dataset.retryJob }) }).catch(() => {}).finally(() => render());
    }
  });

  const scoutRow = sc => {
    if (!sc) return '';
    if (sc.plan) return `<span class="muted small">已约好 ${esc(sc.plan.day.slice(5))} 去${esc(sc.plan.dir)}探路</span>`;
    if (sc.sessionOpen) return '<button disabled title="结束会话后才能去">去探路（先结束会话）</button>';
    return `<select id="world-scout">${sc.dirs.map(d => `<option value="${esc(d.dir)}" ${d.blocked ? 'disabled' : ''}>${esc(d.dir)}${d.blocked ? `（${esc(d.blocked)}）` : ''}</option>`).join('')}</select><button data-world="scout">去探路</button>`;
  };
  // 3.0 F6: the 世界 tab's buttons and switches.
  let peek = false;
  el.addEventListener('click', ev => {
    const b = ev.target.closest('[data-world]');
    if (!b) return;
    const { saveId } = getCtx();
    const k = b.dataset.world;
    if (k === 'peek') { peek = !peek; render(); return; }
    const call = k === 'weather' ? api.post(`/api/saves/${saveId}/debug/weather`, { kind: el.querySelector('#world-weather').value })
      : k === 'incident' ? api.post(`/api/saves/${saveId}/debug/incident`, { id: el.querySelector('#world-incident').value })
        : k === 'cover' ? api.post('/api/act', { save: saveId, action: 'cover_wood' })
          : k === 'help' ? api.post('/api/act', { save: saveId, action: 'help', args: { incident: b.dataset.incident } })
            : k === 'scout' ? api.post(`/api/saves/${saveId}/scout`, { dir: el.querySelector('#world-scout').value }) : null;
    if (call) { b.disabled = true; call.then(() => onWorld?.()).catch(e => alert(e.message)).finally(() => render()); }
  });
  el.addEventListener('change', ev => {
    const { saveId } = getCtx();
    if (ev.target.id === 'world-pace') api.put(`/api/saves/${saveId}/features`, { pace: ev.target.value }).then(() => render());
    if (ev.target.id === 'world-debug') api.put(`/api/saves/${saveId}/features`, { debug: ev.target.checked }).then(() => render());
  });

  el.addEventListener('change', ev => {
    if (ev.target.id === 'card-version') { cardShown = ev.target.value === '' ? null : Number(ev.target.value); cardNotice = null; render(); }
  });

  // Settings tab (2.0 B5): one text box per card section; saving joins them back and the server parses the whole card.
  const cardBase = () => { const { saveId, charId } = getCtx(); return `/api/saves/${saveId}/characters/${charId}/card`; };
  function splitCard(text) {
    const parts = [];
    let cur = { title: '名字与基本信息', lines: [] };
    for (const l of String(text).split('\n')) {
      const h = /^##\s+(.+)$/.exec(l);
      if (h) { parts.push(cur); cur = { title: h[1].trim(), lines: [] }; } else cur.lines.push(l);
    }
    parts.push(cur);
    return parts.map(p => ({ title: p.title, body: p.lines.join('\n').replace(/^\n+|\s+$/g, '') }));
  }
  function joinCard() {
    const boxes = [...el.querySelectorAll('[data-card-section]')];
    const ranges = [];
    const lines = [];
    for (const [i, b] of boxes.entries()) {
      if (i) lines.push('', `## ${b.dataset.cardSection}`);
      const from = lines.length + 1;
      lines.push(...b.value.replace(/\s+$/, '').split('\n'));
      ranges.push([from, lines.length, b]);
    }
    return { text: lines.join('\n'), ranges };
  }
  async function saveCard() {
    for (const n of el.querySelectorAll('.card-error')) n.remove();
    const { text, ranges } = joinCard();
    try {
      const r = await api.put(cardBase(), { text, note: el.querySelector('#card-note')?.value || '' });
      cardShown = null; cardDraft = null;
      cardNotice = `已保存为第 ${r.version} 版${r.selfCanonChanged?.length ? `；${r.selfCanonChanged.length} 条自述按新设定重新判定，见「关系」` : ''}。`;
      render();
    } catch (e) {
      const line = Number((/^第 (\d+) 行/.exec(e.message) || [])[1]);
      const hit = ranges.find(([a, b]) => line >= a - 1 && line <= b) || ranges[0];
      hit[2].insertAdjacentHTML('afterend', `<div class="card-error tag bad">${esc(e.message)}（没有保存）</div>`);
      hit[2].scrollIntoView({ block: 'center' });
    }
  }
  // B6: the draft only fills the boxes; nothing is saved until the author presses save.
  async function draft(btn) {
    btn.disabled = true; btn.textContent = '起草中…';
    try {
      const d = await api.post('/api/cards/draft', { save: getCtx().saveId, looks: el.querySelector('#draft-looks').value, persona: el.querySelector('#draft-persona').value });
      cardDraft = d; cardShown = null;
      cardNotice = d.ok ? '草稿已填进下面的框，还没保存：改好后点「保存为新版本」。' : null;
    } catch (e) { cardNotice = null; cardDraft = { text: null, error: e.message }; }
    render();
  }
  async function restoreCard(version) {
    const r = await api.post(`${cardBase()}/restore`, { version });
    cardShown = null; cardNotice = `已把第 ${version} 版恢复为新的第 ${r.version} 版。`;
    render();
  }

  function show(id) {
    tab = id;
    for (const b of tabsEl.querySelectorAll('button')) b.setAttribute('aria-selected', String(b.dataset.tab === id));
    return render();
  }
  const tools = ref => `<span class="tools"><button data-verb="suppress" data-forget-ref="${ref}" title="别再主动提">别再提</button><button data-verb="forget" data-forget-ref="${ref}">忘掉</button><button data-verb="delete" data-forget-ref="${ref}">删除</button></span>`;
  const seqLinks = seqs => (seqs || []).map(s => `<a href="#" data-seq="${s}">#${s}</a>`).join(' ');

  async function render() {
    const { saveId, charId } = getCtx();
    if (!saveId) { el.innerHTML = '<p class="muted">先新建一个存档。</p>'; return; }
    try { el.innerHTML = await VIEWS[tab](saveId, charId); } catch (e) { el.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
    if (flashRef) {
      const node = el.querySelector(`[data-ref-id="${CSS.escape(flashRef)}"]`);
      if (node) { node.classList.add('flash'); node.scrollIntoView({ block: 'center' }); }
      flashRef = null;
    }
  }

  const VIEWS = {
    async context(saveId, charId) {
      const turns = await api.get(`/api/turns?save=${saveId}&character=${charId}&limit=60`);
      if (!turns.length) return '<p class="muted">还没有对话。说一句话后，这里会显示发给模型的每一节。</p>';
      const id = turnId && turns.some(t => t.id === turnId) ? turnId : turns.find(t => t.mode === 'memory')?.id || turns[0].id;
      const t = await api.get(`/api/turns/${id}`);
      const sys = t.prompt?.[0]?.content || '';
      const total = t.sections.reduce((n, s) => n + s.tokens, 0);
      const picker = `<select id="turn-pick">${turns.map(x => `<option value="${x.id}" ${x.id === id ? 'selected' : ''}>${fmt(x.t)} ${x.mode === 'catchup' ? '离屏补完' : `第 ${x.user_seq} 条 · ${MODE_NAME[x.mode] || x.mode}`}</option>`).join('')}</select>`;
      queueMicrotask(() => el.querySelector('#turn-pick')?.addEventListener('change', e => { turnId = e.target.value; render(); }));
      if (t.mode === 'catchup') return `${picker}<h3>离屏补完的打算</h3><pre>${esc(JSON.stringify(t.output, null, 2))}</pre>`;
      const rej = t.rejected || {};
      const rejText = [rej.used?.length ? `丢掉了上下文里没有的 ref：${rej.used.join('、')}` : '', rej.banned?.length ? `禁用说法重写：${rej.banned.length} 次` : '', rej.action ? `动作被拦：${rej.action.name} ${rej.action.target || ''}（${rej.action.reason}）` : '', rej.error ? `模型出错：${rej.error}` : ''].filter(Boolean);
      return `${picker} <span class="muted small">变化部分约 ${total} token · 可缓存的前缀（系统提示）约 ${Math.ceil(sys.length * 0.7)} token · 第 ${t.generation} 代</span>
        ${rejText.length ? `<div class="row"><span class="tag warn">宿主拦下</span>${esc(rejText.join('；'))}</div>` : ''}
        <details><summary><b>系统提示</b><span class="muted">角色卡 + 规则，每轮相同</span></summary><pre>${esc(sys)}</pre></details>
        ${t.sections.map(s => `<details ${['hints', 'facts', 'input'].includes(s.name) ? 'open' : ''}><summary><b>${esc(s.title)}</b><span class="muted">${s.tokens} token · ${esc(s.why || '')}${s.refs.length ? ` · ${s.refs.length} 条记忆` : ''}</span></summary><pre>${esc(s.text)}</pre></details>`).join('')}
        ${t.thought ? `<div class="row thought"><span class="muted">内心：${esc(t.thought)}</span></div>` : ''}
        ${t.intent ? `<div class="row thought"><span class="muted">意图：${esc(t.intent)}</span></div>` : ''}
        <h3>模型输出</h3><pre>${esc(JSON.stringify(t.output, null, 2))}</pre>
        <h3>这一轮的实际调用</h3>${callsTable(t.view?.calls || [])}`;
    },
    async facts(saveId, charId) {
      const m = await api.get(`/api/memory?save=${saveId}&character=${charId}`);
      const rows = m.facts.map(f => `<div class="row ${f.status === 'active' ? '' : 'dim'}" data-ref-id="fact:${f.id}">${f.status === 'active' ? tools(`fact:${f.id}`) : ''}${tag(f.status)}${f.sensitivity === 'private' ? '<span class="tag warn">私密</span>' : ''}<b>${esc(PRED[f.predicate] || f.predicate)}</b>：${esc(f.object)}
        <div class="muted small">原话：「${esc(f.evidence)}」 · 来源 ${seqLinks(f.source_seqs)} · 记于 ${fmt(f.recorded_at)}${f.valid_to ? ` · 到 ${fmt(f.valid_to)} 为止` : ''}${f.superseded_by ? ' · 已被新事实取代' : ''} · fact:${f.id}</div></div>`).join('');
      const rej = m.rejected.map(r => `<div class="row dim"><span class="tag bad">${esc(r.reason)}</span>${esc(r.candidate.predicate)}：${esc(r.candidate.object)} <span class="muted small">原话「${esc(r.candidate.evidence)}」 #${r.candidate.source_seq}</span></div>`).join('');
      return `${rows || '<p class="muted">还没有记下用户的事实。</p>'}<h3>没记下的（规则拒绝）</h3>${rej || '<p class="muted small">无</p>'}`;
    },
    async memories(saveId, charId) {
      const m = await api.get(`/api/memory?save=${saveId}&character=${charId}`);
      const list = [...m.caches].reverse().filter(c => !['diary', 'week'].includes(c.kind));
      // 2.0 D4: weekly digests above the diaries.
      const weeks = [...m.caches].filter(c => c.kind === 'week').sort((a, b) => (b.day || '').localeCompare(a.day || '') || b.created_at - a.created_at);
      const weekHtml = weeks.length ? `<h3>周小结</h3>${weeks.map(c => `<div class="row ${c.invalid ? 'dim' : ''}" data-ref-id="cache:${c.id}"><span class="tag">到 ${esc(c.day)}</span><span class="${c.invalid ? 'strike' : ''}">${esc(c.text)}</span><div class="muted small">事件 ${seqLinks(c.derived_from)}${c.invalid ? ` · 作废：${esc(c.invalid_reason)}` : ''} · cache:${c.id}</div></div>`).join('')}` : '';
      // 2.0 D3: one diary per world day, newest first; rewritten ones stay visible, struck through.
      const diaries = [...m.caches].filter(c => c.kind === 'diary').sort((a, b) => (b.day || '').localeCompare(a.day || '') || b.created_at - a.created_at);
      const diaryHtml = `<h3>日记</h3>${diaries.map(c => `<div class="row ${c.invalid ? 'dim' : ''}" data-ref-id="cache:${c.id}"><span class="tag">${esc(c.day)}</span><span class="${c.invalid ? 'strike' : ''}">${esc(c.text)}</span>${c.intention ? `<div class="small">明天想：${esc(c.intention)}</div>` : ''}
        <div class="muted small">写到 ${seqLinks(c.derived_from)}${c.invalid ? ` · 作废：${esc(c.invalid_reason)}` : ''} · cache:${c.id}</div></div>`).join('') || '<p class="muted small">还没有。世界时间过了 23:00 会写当天的。</p>'}`;
      if (!list.length) return `<p class="muted">还没有观察日志。攒够 8 条事件或结束会话时会写。</p>${weekHtml}${diaryHtml}`;
      return weekHtml + diaryHtml + '<h3>观察和经历</h3>' + list.map(c => `<div class="row ${c.invalid ? 'dim' : ''}" data-ref-id="cache:${c.id}">${c.invalid ? '' : tools(`cache:${c.id}`)}<span class="tag">${c.kind === 'episode' ? '经历' : '观察'}</span><span class="tag ${c.priority === 1 ? 'warn' : ''}">p${c.priority}</span><span class="${c.invalid ? 'strike' : ''}">${esc(c.text)}</span>
        <div class="muted small">来自 ${seqLinks(c.derived_from)} · 第 ${c.generation} 代${c.invalid ? ` · 作废：${esc(c.invalid_reason)}` : ''} · cache:${c.id}</div></div>`).join('');
    },
    async commitments(saveId, charId) {
      const m = await api.get(`/api/memory?save=${saveId}&character=${charId}`);
      if (!m.commitments.length) return '<p class="muted">还没有约定。</p>';
      return m.commitments.map(k => `<div class="row ${k.status === 'open' ? '' : 'dim'}" data-ref-id="commit:${k.id}">${k.status === 'open' ? tools(`commit:${k.id}`) : ''}${tag(k.status)}<b>${k.owner === 'character' ? '角色答应' : '用户答应'}</b>：${esc(k.text)}<div class="muted small">${k.due_at ? `到期 ${fmt(k.due_at)} · ` : ''}来源 ${seqLinks(k.source_seqs)}</div></div>`).join('');
    },
    async card() {
      const list = await api.get(`${cardBase()}/versions`);
      const latest = list.at(-1);
      const shown = list.find(v => v.version === cardShown) || latest;
      const old = !cardDraft?.text && shown.version !== latest.version;
      const text = cardDraft?.text || shown.text;
      const picker = `<select id="card-version">${list.slice().reverse().map(v => `<option value="${v.version === latest.version ? '' : v.version}" ${v === shown ? 'selected' : ''}>第 ${v.version} 版 · ${esc(v.note || '')}${v.version === latest.version ? '（当前）' : ''}</option>`).join('')}</select>`;
      const boxes = splitCard(text).map(p => `<label class="card-box"><b>${esc(p.title)}</b><textarea data-card-section="${esc(p.title)}" rows="${Math.min(12, Math.max(2, p.body.split('\n').length + 1))}" ${old ? 'readonly' : ''}>${esc(p.body)}</textarea></label>`).join('');
      return `<div class="row">版本 ${picker} <span class="muted small">卡片哈希 ${esc(shown.hash)}</span></div>
        ${cardNotice ? `<div class="row"><span class="tag good">${esc(cardNotice)}</span></div>` : ''}
        <details ${cardDraft ? 'open' : ''}><summary><b>一键起草</b><span class="muted">外貌描述 + 一句话人设，生成整张卡填进框里，不会自动保存</span></summary>
          <label class="card-box">外貌描述（可从造物台资产的 brief 粘贴）<textarea id="draft-looks" rows="3"></textarea></label>
          <label class="card-box">一句话人设<input id="draft-persona" maxlength="300"></label>
          <div class="row"><button data-card-draft>起草</button>${cardDraft ? ' <button data-card-discard>丢掉草稿</button>' : ''}</div>
          ${cardDraft?.error ? `<div class="row"><span class="tag bad">${esc(cardDraft.error)}</span>${cardDraft.text ? ' 原文已放进下面的框，请手动改正' : ''}</div>` : ''}
        </details>
        ${old ? `<div class="row"><span class="tag warn">这是旧版本，只能看</span> <button data-card-restore="${shown.version}">恢复为这个版本</button></div>` : ''}
        <div class="card-form">${boxes}</div>
        ${old ? '' : `<div class="row"><input id="card-note" placeholder="备注：改了什么" maxlength="200"> <button data-card-save>保存为新版本</button></div><p class="muted small">节名和格式见 contracts/card.md。保存前会整张解析，出错就标在对应的框下面，不保存。</p>`}`;
    },
    async relationship(saveId, charId) {
      const m = await api.get(`/api/memory?save=${saveId}&character=${charId}`);
      const r = m.relationship;
      const nums = [['认识天数', r.days_known], ['会话次数', r.sessions], ['对话条数', r.talks], ['收到礼物', r.gifts_received], ['做到的约定', r.promises_kept], ['没做到', r.promises_broken], ['阶段', r.stage]];
      // 2.0 D5: what the next stage still needs, and when the stage changed.
      const next = r.next ? `<div class="row">下一阶段「${esc(r.next.stage)}」还差：${esc(r.next.missing.join('、') || '（都够了，下一轮就到）')}</div>` : '<div class="row">已经是最高阶段</div>';
      const hist = (r.history || []).map(h => `<div class="row"><span class="muted small">${fmt(h.t)}</span> ${esc(h.from)} → <b>${esc(h.to)}</b></div>`).join('') || '<p class="muted small">还没变过（一直是初识）</p>';
      return `<div class="row">${nums.map(([k, v]) => `<span class="tag">${k} ${esc(v)}</span>`).join('')}</div>${next}<h3>阶段变化</h3>${hist}<h3>关系卡原文（不调模型）</h3><div class="row">${esc(r.card)}</div>
        <h3>角色说过的关于自己的话</h3>${m.selfCanon.map(s => `<div class="row ${s.status === 'active' ? '' : 'dim'}"><span class="tag ${s.status === 'active' ? 'good' : 'bad'}">${SELF_STATUS[s.status] || s.status}</span>${esc(s.text)}</div>`).join('') || '<p class="muted small">无</p>'}
        <h3>最近提起过的记忆</h3>${m.mentions.map(x => `<div class="row"><span class="tag ${x.proactive ? 'warn' : ''}">${x.proactive ? '主动' : '被问到'}</span>${esc(x.memory_ref)} <span class="muted small">${fmt(x.t)}</span></div>`).join('') || '<p class="muted small">无</p>'}
        <h3>空闲时的想法（只存不用）</h3>${(m.idle || []).map(x => `<div class="row"><span class="tag ${x.said ? 'good' : ''}">${x.said ? '说了' : '没说'}</span>${esc(x.at)} 她想：${esc(x.thought || '（空）')}${x.said ? `<div class="small">说：${esc(x.said)}</div>` : `<div class="muted small">想过但没说${x.why ? `：${esc(x.why)}` : ''}（想说的劲 ${esc(x.urge)}）</div>`}</div>`).join('') || '<p class="muted small">无</p>'}
        <h3>试玩记录</h3>${(m.playtestNotes || []).map(n => `<div class="row"><span class="tag">${esc(n.day)}</span>${esc(n.text)}</div>`).join('') || '<p class="muted small">还没有。结束会话时会问一句「今天感觉怎样？」</p>'}`;
    },
    async ledger(saveId) {
      const evs = await api.get(`/api/events?save=${saveId}&limit=2000${filter ? `&target=${encodeURIComponent(filter)}` : ''}`);
      const rows = evs.slice().reverse().map(e => `<tr data-ref-id="ev:${e.seq}"><td>#${e.seq}</td><td>${fmt(e.t)}</td><td>${esc(e.type)}${e.offscreen ? ' <span class="tag warn">离屏</span>' : ''}</td><td>${esc(e.actor)}</td><td>${e.tombstone ? '<span class="tag bad">已删除</span>' : esc(e.text)}${e.outcome === 'failed' ? ' <span class="tag bad">失败</span>' : ''}${e.flags.map(f => ` <span class="tag ${f === 'forgotten' ? 'bad' : 'warn'}">${f === 'forgotten' ? '已忘掉' : '别再提'}</span>`).join('')}</td><td class="muted">${esc(e.room || '')}<br>${esc(e.perceivers.join(','))} · ${esc(e.user_presence)}</td></tr>`).join('');
      const top = notices.map(n => `<div class="row"><span class="tag warn">3D</span>${esc(n)}</div>`).join('');
      return `${top}${filter ? `<div class="row">只看和 <b>${esc(filter)}</b> 有关的事件 <button data-clear-filter>看全部</button></div>` : ''}<table class="ledger"><tr><th>seq</th><th>时间</th><th>类型</th><th>谁</th><th>内容</th><th>房间 / 感知者 · 在场</th></tr>${rows}</table>`;
    },
    async forget(saveId, charId) {
      const m = await api.get(`/api/memory?save=${saveId}&character=${charId}`);
      const jobs = [...m.forgetJobs].reverse().map(j => `<div class="row"><span class="tag">${{ suppress: '别再提', forget: '忘掉', delete: '删除' }[j.verb]}</span><span class="tag ${j.state === 'reported' ? 'good' : j.state === 'cancelled' ? '' : 'warn'}">${esc(j.state)}</span>${esc(j.topic)}${j.report ? `<div class="muted small">${esc(JSON.stringify(j.report))}</div>` : ''}</div>`).join('');
      const sup = m.suppressions.map(s => `<div class="row"><span class="tag warn">别再提</span>${esc(s.topic || '（按条目）')} <span class="muted small">${s.refs.length} 条记忆</span></div>`).join('');
      return `<h3>生效中的“别再提”</h3>${sup || '<p class="muted small">无</p>'}<h3>任务</h3>${jobs || '<p class="muted small">无。可以在聊天里说“请忘了那件事”，或在事实/经历页点按钮。</p>'}`;
    },
    // 3.0 G2: 去探路 — only while the session is closed; a blocked direction says why.
    async world(saveId) {
      const w = await api.get(`/api/saves/${saveId}/world${peek ? '?peek=1' : ''}`);
      if (!w.on) return '<p class="muted">这个存档没开「天气和营地的量」（旧存档和剧本保持 2.0）。新建存档会全部打开。</p>';
      const d = w.today, v = w.vars;
      const hours = ms => `${Math.floor(ms / 3600_000)} 小时 ${Math.round((ms % 3600_000) / 60_000)} 分`;
      const varRows = Object.entries(v).filter(([, x]) => !Array.isArray(x)).map(([k, x]) => `<tr><td>${esc(k)}</td><td>${esc(typeof x === 'number' && x > 1e12 ? fmt(x) : String(x))}</td></tr>`).join('');
      const active = w.active.map(a => `<div class="row"><span class="tag ${a.sev >= 2 ? 'bad' : 'warn'}">sev ${a.sev}</span>${esc(a.name)}${a.left != null ? ` <span class="muted small">还剩 ${hours(a.left)}</span>` : ''}${a.help ? ` <button data-world="help" data-incident="${esc(a.id)}">搭把手</button>` : ''}</div>`).join('');
      const DEC = { start: ['开始', 'good'], budget: ['预算不够', 'warn'], gap: ['间隔太近', ''], rest: ['大事后休息', ''], roll: ['掷骰没过', ''], auto_fix: ['她去处理', 'good'], debug: ['调试', 'warn'] };
      const log = w.log.map(r => { const [n, c] = DEC[r.decision] || [r.decision, '']; return `<tr><td>${fmt(r.t)}</td><td>${esc(w.incidents.find(i => i.id === r.incident)?.name || r.incident)}</td><td><span class="tag ${c}">${n}</span></td><td class="small">${esc(r.reason)}</td></tr>`; }).join('');
      const debug = w.features.debug ? `<h3>调试</h3><div class="row"><select id="world-weather">${w.weatherKinds.map(k => `<option>${k}</option>`).join('')}</select><button data-world="weather">现在就变成这个天气</button></div>
        <div class="row"><select id="world-incident">${w.incidents.map(i => `<option value="${i.id}">${esc(i.name)}（sev ${i.sev}）</option>`).join('')}</select><button data-world="incident">立刻开始这个意外</button></div>` : '';
      return `<h3>天气 · 第 ${d.day} 天</h3>
        <table class="ledger"><tr><th></th><th>上午</th><th>下午</th><th>气温</th><th>风</th><th>天象</th></tr>
        <tr><td>今天 ${esc(d.date)}</td><td>${esc(d.am)}</td><td>${esc(d.pm)}${d.kind !== d.am && d.kind !== d.pm ? `（现在 ${esc(d.kind)}）` : ''}</td><td>现在约 ${d.temp}℃，${d.lo}～${d.hi}℃</td><td>${esc(d.wind)}</td><td>${esc(d.sign || '—')}</td></tr>
        <tr><td>明天</td><td colspan="5">${w.tomorrow ? `${esc(w.tomorrow.am)} → ${esc(w.tomorrow.pm)}` : '<span class="muted">盖着</span>'} <button data-world="peek">${w.tomorrow ? '盖上' : '偷看'}</button> <span class="muted small">偷看不影响任何东西</span></td></tr></table>
        <h3>进行中的意外</h3>${active || '<p class="muted small">没有。</p>'}
        <div class="row"><button data-world="cover" ${v.wood_covered ? 'disabled' : ''}>盖柴</button>${scoutRow(w.scout)}</div>
        ${w.practice ? `<div class="row small"><span class="tag good">一起做</span>${esc(w.practice.name)}：第 ${w.practice.step + 1} 步</div>` : ''}
        ${w.bet ? `<div class="row small"><span class="tag warn">打赌</span>${esc(w.bet.about)}：她押「${esc(w.bet.her_pick)}」，你押「${esc(w.bet.user_pick)}」，赌注 ${esc(w.bet.stake)}</div>` : ''}
        ${w.map.length ? `<h3>她的地图</h3>${w.map.map(m => `<div class="row small">${esc(m.dir)}：${esc(m.note)} <span class="tag ${m.sure ? 'good' : 'warn'}">${m.sure ? '确定' : '？'}</span></div>`).join('')}` : ''}
        ${w.scout?.latest ? `<h3>你上次探路看见的（她不知道）</h3>${w.scout.latest.finds.map(f => `<div class="row small">${esc(f.dir)}：${esc(f.text)}，离营地大约 ${f.li} 里</div>`).join('')}` : ''}
        <h3>营地的量</h3><table class="ledger">${varRows}</table>
        <h3>最近的变化</h3>${w.varChanges.map(e => `<div class="row small"><span class="muted">${fmt(e.t)}</span> ${esc(e.text)}</div>`).join('') || '<p class="muted small">无</p>'}
        <h3>最近 3 天的意外</h3>${w.history.map(e => `<div class="row small"><a href="#" data-seq="${e.seq}">#${e.seq}</a> <span class="muted">${fmt(e.t)}</span> ${esc(e.text)}</div>`).join('') || '<p class="muted small">无</p>'}
        <h3>导演 <select id="world-pace">${w.paces.map(p => `<option ${p === w.features.pace ? 'selected' : ''}>${p}</option>`).join('')}</select>
          <label class="small"><input type="checkbox" id="world-debug" ${w.features.debug ? 'checked' : ''}> 调试</label></h3>
        <table class="ledger"><tr><th>时间</th><th>意外</th><th>结果</th><th>原因</th></tr>${log}</table>${debug}`;
    },
    async cost(saveId) {
      const u = await api.get(`/api/usage?save=${saveId}`);
      const names = { reply: '回复', facts: '抽事实', observe: '观察日志', reflect: '压缩经历', catchup: '离屏补完', forget_resolve: '忘记定位', judge: '评分', test: '测试连接' };
      const money = r => (r.unpriced === r.calls ? '未计价' : `$${(r.cost || 0).toFixed(4)}${r.unpriced ? `<div class="muted small">另 ${r.unpriced} 次未计价</div>` : ''}`);
      const fails = r => [['err_network', '网络'], ['err_http', 'HTTP'], ['err_json', 'JSON'], ['err_shape', '结构']].filter(([k]) => r[k]).map(([k, n]) => `${n} ${r[k]}`).join('，') || (r.errors ? String(r.errors) : '0');
      // 2.0 C7: hits only count calls where the provider reported them; none reported → say so instead of a fake 0%.
      const cacheHit = r => (r.cache_reported ? `${r.cached}${r.cache_reported < r.calls ? `<div class="muted small">${r.calls - r.cache_reported} 次没报</div>` : ''}` : '<span class="muted">服务商没报</span>');
      const cacheRate = r => (r.cache_reported && r.cache_input ? `${Math.round((r.cached / r.cache_input) * 100)}%` : '<span class="muted">—</span>');
      const tok = (r, v) => (r.usage_unknown === r.calls ? `<span class="muted">${v}（估算/未知）</span>` : r.usage_unknown ? `${v}<div class="muted small">${r.usage_unknown} 次未知</div>` : v);
      return `<table class="ledger"><tr><th>用途</th><th>逻辑调用</th><th>实际尝试</th><th>输入 token</th><th>其中命中缓存</th><th>命中率</th><th>输出</th><th>花费</th><th>平均延迟</th><th>失败</th></tr>${u.rows.map(r => `<tr><td>${names[r.purpose] || r.purpose}</td><td>${r.logical}</td><td>${r.calls}${r.truncated ? `<div class="muted small">截断 ${r.truncated}</div>` : ''}</td><td>${tok(r, r.input)}</td><td>${cacheHit(r)}</td><td>${cacheRate(r)}</td><td>${tok(r, r.output)}</td><td>${money(r)}</td><td>${Math.round(r.latency || 0)} ms</td><td>${fails(r)}</td></tr>`).join('')}</table>
        ${await jobsTable(saveId)}
        <p class="muted small">每次重试都单独算一次实际尝试。token 来自服务商返回；假模型或服务商没给 usage 时是估算/未知，不计价。价格在 ⚙ 设置里填。</p>`;
    }
  };

  const JOB_STATUS = { failed: ['失败，会自动再试', 'bad'], skipped: ['已跳过，等补跑', 'warn'], retrying: ['补跑中', 'warn'], recovered: ['已恢复', 'good'], recovered_empty: ['补跑成功，没抽到东西', 'good'], cancelled: ['来源已忘掉/删除，不补', ''] };
  const JOB_KIND = { facts: '抽事实', observe: '观察日志', reflect: '压缩经历' };
  async function jobsTable(saveId) {
    const runs = await api.get(`/api/jobs?save=${saveId}`);
    if (!runs.length) return '<h3>后台任务</h3><p class="muted small">没有失败过的后台任务。</p>';
    const open = runs.some(r => ['failed', 'skipped'].includes(r.status));
    return `<h3>后台任务（失败与恢复，重启后仍在）${open ? ' <button data-retry-job="all">全部补跑</button>' : ''}</h3><table class="ledger"><tr><th>任务</th><th>事件</th><th>状态</th><th>尝试</th><th>最后错误</th><th></th></tr>${runs.map(r => {
      const [label, cls] = JOB_STATUS[r.status] || [r.status, ''];
      return `<tr><td>${JOB_KIND[r.kind] || r.kind}</td><td>${seqLinks(r.from_seq === r.to_seq ? [r.from_seq] : [r.from_seq, r.to_seq])}</td><td><span class="tag ${cls}">${label}</span></td><td>${r.attempts}</td><td class="small">${esc(r.last_error || '')}</td><td>${['failed', 'skipped'].includes(r.status) ? `<button data-retry-job="${r.id}">补跑</button>` : ''}</td></tr>`;
    }).join('')}</table>`;
  }

  return {
    render, show,
    focusRef(ref) {
      flashRef = ref;
      const kind = ref.split(':')[0];
      return show({ fact: 'facts', cache: 'memories', commit: 'commitments', ev: 'ledger', sc: 'relationship' }[kind] || 'context');
    },
    filterTarget(id) { filter = id; return show('ledger'); },
    showTurn(id) { turnId = id; if (tab === 'context') render(); },
    notice(text) { if (!notices.includes(text)) notices.push(text); if (tab === 'ledger') render(); }
  };
}
