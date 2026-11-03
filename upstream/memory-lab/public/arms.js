// 2.0 D7: one scenario run three times, each save replying with a different context (memory / full transcript /
// short). One row per say step with the three replies side by side; review steps get a note box that is saved.
import { api, esc } from './api.js';

const $ = id => document.getElementById(id);
const group = new URLSearchParams(location.search).get('group');
const stateTag = { passed: ['通过', 'good'], failed: ['有失败', 'bad'], error: ['出错', 'bad'], running: ['进行中', ''] };
const fmtT = ms => new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(ms);
const money = c => (c == null ? '—' : `$${c.toFixed(4)}`);
const actionText = a => {
  if (!a) return '';
  const steps = Array.isArray(a) ? a : [a];
  const failed = a.result?.ok === false ? `（没做成：${esc(a.result.reason)}）` : '';
  return `<div class="muted small">🎬 ${esc(steps.map(x => `${x.name} ${x.target || ''}`).join(' → '))}${failed}</div>`;
};

async function groups() {
  const all = await api.get('/api/arms');
  $('arms-groups').innerHTML = all.length ? all.map(g => `<option value="${g.group}" ${g.group === group ? 'selected' : ''}>${fmtT(g.real_at)} · ${esc(g.scenarioId)} · ${g.provider === 'live' ? '真模型' : '假模型'}</option>`).join('') : '<option>还没有三路运行</option>';
  return all;
}
$('arms-groups').addEventListener('change', e => { location.search = `?group=${encodeURIComponent(e.target.value)}`; });

async function show(id) {
  const g = await api.get(`/api/arms/${encodeURIComponent(id)}`);
  $('arms-title').textContent = `${g.title} · ${g.provider === 'live' ? '真模型' : '假模型'}`;
  const cols = g.arms.map(a => a.arm);
  const head = g.arms.map(a => {
    if (a.missing) return `<th>${esc(a.title)}<div class="muted small">没有这一路</div></th>`;
    const [t, c] = stateTag[a.state] || [a.state, ''];
    const s = a.summary;
    return `<th>${esc(a.title)} <span class="tag ${c}">${t}</span><div class="muted small">断言 ${s.auto_pass} 过 / ${s.auto_fail} 失败 · 花费 ${money(a.cost)} · <a href="/?save=${a.saveId}">存档</a></div></th>`;
  }).join('');
  const body = g.steps.map(r => {
    if (r.kind === 'review') {
      return `<tr class="arms-review"><td>${r.step + 1}</td><td colspan="${cols.length}"><div class="small">待人工判读：${esc(r.question)}</div>
        <textarea data-note="${r.step}" rows="2" placeholder="三路各怎样？哪一路更好？">${esc(r.note)}</textarea><span class="muted small" data-saved="${r.step}"></span></td></tr>`;
    }
    return `<tr><td>${r.step + 1}</td>${cols.map((arm, i) => {
      const x = r.arms[arm];
      const input = i === 0 ? `<div class="arms-input small">你：${esc(r.input)}</div>` : '<div class="arms-input small">&nbsp;</div>';
      if (!x) return `<td>${input}<span class="muted">（没跑到）</span></td>`;
      return `<td>${input}<div>${esc(x.reply ?? '')}</div>${actionText(x.action)}${x.error ? `<div class="bad small">${esc(x.error)}</div>` : ''}</td>`;
    }).join('')}</tr>`;
  }).join('');
  $('arms').innerHTML = `<table class="ledger arms-table"><tr><th>步</th>${head}</tr>${body}</table>
    <p class="muted small">每一路是自己的存档：动作真的执行、事实真的记，三路互不影响。判读写完离开输入框就保存。</p>`;
  for (const ta of document.querySelectorAll('[data-note]')) {
    ta.addEventListener('change', async () => {
      const mark = document.querySelector(`[data-saved="${ta.dataset.note}"]`);
      try { await api.put(`/api/arms/${encodeURIComponent(id)}/notes/${ta.dataset.note}`, { text: ta.value }); mark.textContent = '已保存'; }
      catch (e) { mark.textContent = e.message; }
    });
  }
}

(async () => {
  try {
    const all = await groups();
    const id = group || all[0]?.group;
    if (!id) { $('arms').innerHTML = '<p class="muted">还没有三路运行。在「测试剧本」里点「三路平行跑」。</p>'; return; }
    await show(id);
  } catch (e) { $('arms').innerHTML = `<p class="bad">${esc(e.message)}</p>`; }
})();
