// Middle column: messages, action and memory chips, host cards, comparison columns.
import { esc } from './api.js';

export function createChat(el, { onRef, onForgetConfirm, onForgetCancel }) {
  const scroll = () => { el.scrollTop = el.scrollHeight; };
  function add(html, cls) {
    const div = document.createElement('div');
    div.className = cls; div.innerHTML = html;
    el.appendChild(div); scroll();
    return div;
  }
  el.addEventListener('click', ev => {
    const ref = ev.target.closest('[data-ref]')?.dataset.ref;
    if (ref) onRef(ref);
    const fj = ev.target.closest('[data-forget]');
    if (fj) (fj.dataset.op === 'confirm' ? onForgetConfirm : onForgetCancel)(fj.dataset.forget, fj.closest('.card'));
  });
  // Actual input tokens when the provider reported them, otherwise our estimate (said so).
  const tokenText = x => (x.inputTokens != null ? `输入 ${x.inputTokens} token` : `约 ${x.tokens ?? '—'} token（估算）`);
  const actionText = x => {
    if (!x.action) return '';
    const res = x.actionResult;
    const names = (Array.isArray(x.action) ? x.action : [x.action]).map(a => `${esc(a.name)} ${esc(a.target || '')}`).join(' → ');
    const note = x.executed === false || res?.executed === false ? (res ? (res.ok ? '（对照，可以做，但不执行）' : `（对照，不执行；本来也做不成：${esc(res.reason)}）`) : '（对照，不执行）')
      : res?.ok === false ? `（没做成：${esc(res.reason)}）` : '';
    return `<span class="${res?.ok === false ? 'bad' : ''}">🎬 ${names}${note}</span>`;
  };
  const chips = (refs, hintRefs = []) => refs.map(r => `<span class="chip${hintRefs.includes(r) ? ' hint' : ''}" data-ref="${esc(r)}" title="${hintRefs.includes(r) ? '主动提起' : '用到的记忆'}">🧠 ${esc(r)}</span>`).join('');
  return {
    clear() { el.innerHTML = ''; },
    user(text) { add(esc(text), 'msg user'); },
    host(text) { add(esc(text), 'msg host'); },
    error(text) { add(esc(text), 'msg error'); },
    char(name, r) {
      const a = actionText(r);
      const hintRefs = (r.hints || []).map(h => h.ref);
      const cost = `<span>${tokenText(r)}${r.cost != null ? ` · $${r.cost.toFixed(5)}` : ''}</span>`;
      const withheld = r.withheld ? `<div class="muted small">模型原本想说（动作没做成，没有送达）：${esc(r.withheld)}</div>` : '';
      add(`<div class="who">${esc(name)}</div>${esc(r.delivered ?? r.say)}${withheld}<div class="meta">${a}${chips(r.used || [], hintRefs)}${r.error ? `<span class="bad">模型出错：${esc(r.error)}</span>` : ''}${cost}</div>`, 'msg char');
    },
    /** One input, three ways of remembering, the same world. Only the first column was delivered and acted on. */
    compare(name, r, c) {
      const col = (title, x) => !x ? `<div><h4>${title}</h4><p class="muted small">这一轮没有这一路</p></div>`
        : `<div><h4>${title}</h4><div class="muted small">${tokenText(x)}${x.truncated ? ` · 截掉最早 ${x.truncated} 条` : ''}${x.cost != null ? ` · $${x.cost.toFixed(5)}` : ''}</div>${esc(x.delivered ?? x.say)}${x.withheld ? `<div class="muted small">模型原本想说（动作没做成，没送达）：${esc(x.withheld)}</div>` : ''}${actionText(x) ? `<div class="muted small">${actionText(x)}</div>` : ''}${x.error ? `<div class="bad small">模型出错：${esc(x.error)}</div>` : ''}</div>`;
      add(col('当前记忆方案（已送达）', r) + col('聊天原文（最多约 60k）', c.full) + col('短上下文（最近六条）', c.none), 'compare');
    },
    forgetCard(job) {
      const c = job.candidates || {};
      const n = k => (Array.isArray(c[k]) ? c[k].length : c[k] || 0);
      const verb = { suppress: '别再提', forget: '忘掉', delete: '删除记录' }[job.verb];
      if (job.state === 'reported') return this.forgetReport(job);
      add(`<b>${verb}</b>：${esc(job.topic || '（未命名）')}<div class="muted small">对话 ${n('seqs')} 条 · 事实 ${n('fact_ids')} 条 · 经历 ${n('cache_ids')} 条 · 约定 ${n('commit_ids')} 条</div>
        <div class="actions"><button class="primary" data-forget="${job.id}" data-op="confirm">确认${verb}</button><button data-forget="${job.id}" data-op="cancel">取消</button></div>`, 'card');
    },
    forgetReport(job) {
      const r = job.report || {};
      const text = job.verb === 'delete' ? `已删除 ${r.events + r.facts + r.commitments} 条记录（抹掉调试记录 ${r.traces_redacted} 处）`
        : job.verb === 'suppress' ? `好，不会再主动提「${job.topic}」` : `已忘掉：${job.topic}（对话 ${r.events} 条，事实 ${r.facts} 条，重建经历 ${r.caches_rebuilt} 条）`;
      add(esc(text), 'msg host');
    }
  };
}
