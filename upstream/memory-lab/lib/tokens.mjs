// Rough token estimate (shown as “估算” in the UI). CJK characters ≈ 0.7 token, other characters ≈ 1/3.5.
const CJK = /[぀-ヿ㐀-鿿豈-﫿＀-￯]/g;
export function estimate(text) {
  const s = String(text ?? '');
  if (!s) return 0;
  const cjk = (s.match(CJK) || []).length;
  return Math.ceil(cjk * 0.7 + (s.length - cjk) / 3.5);
}
