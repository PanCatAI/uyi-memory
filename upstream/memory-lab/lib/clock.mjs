// World time. Everything in lib/ reads time from here (AGENTS.md hard rule 6): a save's clock only moves forward,
// one turn costs TURN_MS, and the user can skip ahead with +1h / +1d / +1w.
export const TURN_MS = 20_000;
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const WORLD_START = Date.parse('2026-10-20T09:00:00+09:00');
export const ZONE = 'Asia/Tokyo';

/** Real wall-clock time, only for sorting saves and logging model calls. Never use it for world time. */
// eslint-disable-next-line no-restricted-properties
export const realNow = () => Date.now();

export function createClock(db) {
  const get = db.prepare('SELECT clock_ms FROM saves WHERE id = ?');
  const put = db.prepare('UPDATE saves SET clock_ms = ? WHERE id = ?');
  const clock = {
    now(saveId) {
      const row = get.get(saveId);
      if (!row) throw new Error(`没有这个存档：${saveId}`);
      return row.clock_ms;
    },
    set(saveId, ms) {
      const cur = clock.now(saveId);
      if (ms < cur) throw new Error('世界时间不能往回拨');
      put.run(ms, saveId);
      return ms;
    },
    advance(saveId, ms) { return clock.set(saveId, clock.now(saveId) + Math.max(0, ms)); }
  };
  return clock;
}

const UNIT = { m: 60_000, h: HOUR, d: DAY, w: 7 * DAY };
/** '2h' '3d' '1w' '30m' '+1d' → ms; 'tomorrow' → ms until 09:00 next day; '18:00' → ms until the next 18:00 (both need nowMs). Unknown → null. */
export function parseDuration(s, nowMs) {
  if (typeof s === 'number') return s >= 0 ? s : null;
  const text = String(s ?? '').trim();
  const m = /^\+?(\d+(?:\.\d+)?)\s*([mhdw])$/.exec(text);
  if (m) return Math.round(Number(m[1]) * UNIT[m[2]]);
  // "18:00": forward to the next time the world clock shows 18:00 (a full day when it is 18:00 now).
  const at = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (at && Number.isFinite(nowMs) && Number(at[1]) < 24 && Number(at[2]) < 60) {
    const p = parts(nowMs);
    const today = Date.parse(`${p.year}-${p.month}-${p.day}T${at[1].padStart(2, '0')}:${at[2]}:00+09:00`);
    return today > nowMs ? today - nowMs : today + DAY - nowMs;
  }
  // "周四" / "周四 18:00" (2.0 C6, S2 的守夜约定): the next such weekday (not today), at 09:00 unless a time is given.
  const wd = /^(?:周|星期)([一二三四五六日天])(?:\s*(\d{1,2}):(\d{2}))?$/.exec(text);
  if (wd && Number.isFinite(nowMs)) {
    const want = '日一二三四五六'.indexOf(wd[1] === '天' ? '日' : wd[1]);
    const p = parts(nowMs);
    const today = Object.keys(WEEK).indexOf(p.weekday);
    const ahead = ((want - today + 7) % 7) || 7;
    const [hh, mm] = wd[2] ? [wd[2].padStart(2, '0'), wd[3]] : ['09', '00'];
    if (Number(hh) > 23 || Number(mm) > 59) return null;
    return Date.parse(`${p.year}-${p.month}-${p.day}T${hh}:${mm}:00+09:00`) + ahead * DAY - nowMs;
  }
  if (text === 'tomorrow' && Number.isFinite(nowMs)) {
    const p = parts(nowMs);
    const todayNine = Date.parse(`${p.year}-${p.month}-${p.day}T09:00:00+09:00`);
    return todayNine + DAY - nowMs;
  }
  return null;
}

const FMT = new Intl.DateTimeFormat('en-US', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
const WEEK = { Sun: '周日', Mon: '周一', Tue: '周二', Wed: '周三', Thu: '周四', Fri: '周五', Sat: '周六' };
function parts(ms) {
  const out = {};
  for (const { type, value } of FMT.formatToParts(new Date(ms))) out[type] = value;
  return out;
}

/** '10月22日 周三 09:00' in Asia/Tokyo. */
export function formatWorldTime(ms) {
  const p = parts(ms);
  return `${Number(p.month)}月${Number(p.day)}日 ${WEEK[p.weekday]} ${p.hour}:${p.minute}`;
}

/** 刚才 / 5 分钟前 / 3 小时前 / 2 天前 / 上周 / 3 周前 */
export function formatAgo(ms) {
  if (ms < 2 * 60_000) return '刚才';
  if (ms < HOUR) return `${Math.floor(ms / 60_000)} 分钟前`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)} 小时前`;
  if (ms < 7 * DAY) return `${Math.floor(ms / DAY)} 天前`;
  if (ms < 14 * DAY) return '上周';
  return `${Math.floor(ms / (7 * DAY))} 周前`;
}

/** '2 天' style length for a gap. */
export function formatSpan(ms) {
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / 60_000))} 分钟`;
  if (ms < DAY) return `${Math.round(ms / HOUR)} 小时`;
  return `${Math.round(ms / DAY)} 天`;
}
