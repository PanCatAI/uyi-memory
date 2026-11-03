// Thin fetch wrapper: JSON in, JSON out, Chinese error messages from the server.
async function call(method, path, body) {
  const r = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error?.message || `请求失败（${r.status}）`);
  return data;
}
export const api = {
  get: p => call('GET', p),
  post: (p, body = {}) => call('POST', p, body),
  put: (p, body = {}) => call('PUT', p, body),
  del: p => call('DELETE', p)
};
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
