// 3.0 F2: the camp's weather as numbers, from the scene's rules (scenes/camp.rules.json `weather`). Pure: no
// database, no clock. A save's mornings form one Markov chain from its first day (fixed 晴), each step drawn with
// rand01(save, 'weather', date); the afternoon may turn at 14:00; temperatures run lo at 05:00 → hi at 14:00 → next
// day's lo; at 17:00 the sky shows a sign of tomorrow morning.
import { HOUR, DAY } from './clock.mjs';
import { rand01, pickWeighted } from './rand.mjs';

const TZ = 9 * HOUR; // Asia/Tokyo, as in environment.mjs
/** '2026-10-20' for the weather day of t (days turn over at 05:00). */
export const dayOf = t => new Date(t + TZ - 5 * HOUR).toISOString().slice(0, 10);
/** 05:00 Tokyo of a weather day. */
export const dayStartT = day => Date.parse(`${day}T05:00:00+09:00`);
export const addDays = (day, n) => dayOf(dayStartT(day) + n * DAY + HOUR);
export const daysBetween = (a, b) => Math.round((dayStartT(b) - dayStartT(a)) / DAY);
/** Minutes since 00:00 Tokyo. */
export const minuteOf = t => Math.floor((((t + TZ) % DAY) + DAY) % DAY / 60_000);
export const hm = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
/** t of HH:MM on a weather day (before 05:00 means the calendar day after). */
export const atTime = (day, s) => { const m = hm(s); return dayStartT(day) + ((m - 300 + 1440) % 1440) * 60_000; };
const pairs = obj => Object.entries(obj || {});

/**
 * Morning weather for day index i (1 = the save's first day). cache: an array the caller keeps per save.
 * Rows of the transition table give 雪 no weight; from day `snow_from_day` a drawn 大雨 turns to 雪 half the time.
 */
export function morning(saveId, w, firstDay, i, cache = []) {
  if (!cache.length) cache.push(w.first_day || '晴');
  for (let k = cache.length + 1; k <= i; k++) {
    const day = addDays(firstDay, k - 1);
    const prev = cache[k - 2];
    let kind = pickWeighted(pairs(w.transitions[prev] || w.transitions[w.first_day]), rand01(saveId, 'weather', day));
    if (kind === '大雨' && k >= (w.snow_from_day ?? Infinity) && rand01(saveId, 'snow', day) < (w.snow_chance ?? 0.5)) kind = '雪';
    cache.push(kind);
  }
  return cache[Math.max(1, i) - 1];
}

/** The afternoon after a morning: the 14:00 turn (a draw per day), or the morning unchanged. */
export function afternoon(saveId, w, day, am) {
  const row = w.afternoon?.[am];
  return row ? pickWeighted(pairs(row), rand01(saveId, 'pm', day)) : am;
}

/** { hi, lo, wind } for a kind on day index i (1-based): the table minus cooling_per_day for each day after the first. */
export function temps(w, kind, i) {
  const r = w.temps?.[kind] || { hi: 10, lo: 2, wind: '2 级' };
  const d = (w.cooling_per_day || 0) * Math.max(0, i - 1);
  const round = x => Math.round(x * 10) / 10;
  return { hi: round(r.hi - d), lo: round(r.lo - d), wind: r.wind };
}

/** Temperature at minute-of-weather-day m (0 = 05:00): lo → hi by 14:00, then down to the next day's lo. */
export function tempAt(today, tomorrow, minuteSince5) {
  const peak = 9 * 60;
  if (minuteSince5 <= peak) return today.lo + (today.hi - today.lo) * (minuteSince5 / peak);
  return today.hi + (tomorrow.lo - today.hi) * ((minuteSince5 - peak) / (1440 - peak));
}

/** The evening sign for tomorrow's morning weather (a draw per day). */
export const signFor = (saveId, w, day, tomorrowAm) => pickWeighted(pairs(w.signs?.[tomorrowAm] || { 天边发灰: 1 }), rand01(saveId, 'sign', day));

/** Stationary distribution of the morning chain without snow (power iteration), for the tests. */
export function stationary(w, steps = 500) {
  const kinds = Object.keys(w.transitions).filter(k => k !== '雪');
  let v = Object.fromEntries(kinds.map(k => [k, 1 / kinds.length]));
  for (let s = 0; s < steps; s++) {
    const next = Object.fromEntries(kinds.map(k => [k, 0]));
    for (const a of kinds) {
      const row = w.transitions[a], tot = Object.values(row).reduce((x, y) => x + y, 0);
      for (const b of kinds) next[b] += v[a] * (row[b] || 0) / tot;
    }
    v = next;
  }
  return v;
}
