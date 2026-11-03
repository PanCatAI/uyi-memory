// Phrases a living character never says (PLAN §4.14).
export const BANNED = ['作为AI', '作为一个AI', '我是AI', '我是人工智能', '我是程序', '语言模型', '根据我的记忆', '我的记忆显示', '我的数据', '我记得你说过', '您之前提到'];
const norm = s => String(s).replace(/\s+/g, '');

export function bannedIn(text) { const t = norm(text); return BANNED.filter(b => t.includes(norm(b))); }

/** Removes every sentence that contains a banned phrase. */
export function stripBanned(text) {
  const parts = String(text).match(/[^。！？!?…\n]+[。！？!?…\n]*/g) || [];
  return parts.filter(p => !bannedIn(p).length).join('').trim();
}
