// 3.0 G4: a bet the world settles. Her reply may carry bet: { about: 明天天气 | 雪线, her_pick, user_pick, stake }
// when both said what they bet on. The host checks it (weather picks are the 7 kinds, 下雨 counts as 小雨 or 大雨;
// the snowline is 上 or 下; one bet a day) and writes bet made; the next 05:00 the real weather or the snowline's move
// decides. She lost → an open commitment of hers (the stake, due 18:00 that day). No model calls.
import { HOUR } from './clock.mjs';
import { dayOf, atTime } from './climate.mjs';

export const ABOUT = ['明天天气', '雪线'];
const RAIN = ['小雨', '大雨'];

/** The kinds a weather pick wins with ('下雨' → 小雨 or 大雨), or null when it is not a pick. */
export function weatherPick(pick, kinds) {
  const p = String(pick || '').replace(/^(明天)?(会|是|要)?/, '').replace(/[天。！!]$/g, '').trim();
  if (['下雨', '雨'].includes(p)) return RAIN;
  if (['大晴天', '晴天'].includes(p)) return ['晴'];
  if (['起风', '刮风', '风', '风大', '有风'].includes(p) || /风/.test(p)) return ['大风'];
  if (['下雪'].includes(p)) return ['雪'];
  if (['雾', '有雾'].includes(p)) return ['起雾'];
  if (['阴天'].includes(p)) return ['阴'];
  if (kinds.includes(p)) return [p];
  // Looser words (「大晴」「下大雨」「起大雾」): one kind named inside them, never two.
  const hit = [[/雨/, RAIN], [/晴/, ['晴']], [/雪/, ['雪']], [/雾/, ['起雾']], [/阴/, ['阴']]].filter(([re]) => re.test(p));
  return hit.length === 1 && !/不/.test(p) ? hit[0][1] : null;
}
const snowPick = p => (/上|涨|高/.test(String(p)) ? '上' : /下|退|低/.test(String(p)) ? '下' : null);

export function createBets(lab) {
  const { ledger, clock } = lab;
  const on = saveId => Boolean(lab.scene(saveId).rules) && lab.features(saveId).practices;
  const host = (saveId, t, payload) => lab.worldsim.host(saveId, t, { type: 'bet', room: lab.scene(saveId).user_room, perceivers: lab.scene(saveId).characters.map(c => c.id), payload });
  const open = saveId => {
    const evs = ledger.list(saveId, { types: ['bet'], desc: true, limit: 20 });
    const made = evs.find(e => e.payload?.phase === 'made');
    return made && !evs.some(e => e.seq > made.seq && e.payload?.phase === 'resolved') ? made : null;
  };

  /** After her reply: a bet field → bet made, or why it was dropped. → { events, rejected } */
  function afterReply(saveId, charId, bet) {
    if (bet == null) return { events: [], rejected: null };
    if (!on(saveId)) return { events: [], rejected: '打赌没开' };
    if (typeof bet !== 'object') return { events: [], rejected: 'bet 不是对象' };
    const { her_pick: her, user_pick: user, stake } = bet;
    // The model words it its own way: 「明天的天气」「天气」→ 明天天气, anything with 雪 → 雪线.
    const about = /雪/.test(String(bet.about)) ? '雪线' : /天气|天/.test(String(bet.about)) ? '明天天气' : bet.about;
    if (!ABOUT.includes(about)) return { events: [], rejected: `只能赌：${ABOUT.join('、')}` };
    const kinds = lab.scene(saveId).rules.weather.kinds;
    const ok = about === '雪线' ? snowPick(her) && snowPick(user) && snowPick(her) !== snowPick(user) : weatherPick(her, kinds) && weatherPick(user, kinds) && String(weatherPick(her, kinds)) !== String(weatherPick(user, kinds));
    if (!ok) return { events: [], rejected: `押的不对：她「${her}」，他「${user}」` };
    if (open(saveId)) return { events: [], rejected: '已经有一个赌还没分输赢' };
    const t = clock.now(saveId);
    if (ledger.list(saveId, { types: ['bet'], desc: true, limit: 5 }).some(e => e.payload?.phase === 'made' && dayOf(e.t) === dayOf(t))) return { events: [], rejected: '今天已经赌过了' };
    return { events: [host(saveId, t, { phase: 'made', about, her_pick: String(her), user_pick: String(user), stake: String(stake || '输的人拾柴') })], rejected: null };
  }

  /** worldsim at 05:00, after the morning weather and the snowline: settle an open bet made before today. */
  function settle(saveId, t) {
    if (!on(saveId)) return [];
    const b = open(saveId);
    if (!b || dayOf(b.t) === dayOf(t)) return [];
    const p = b.payload;
    const st = ledger.world(saveId);
    let wins;
    if (p.about === '雪线') {
      const ch = ledger.list(saveId, { types: ['var_changed'], desc: true, limit: 30 }).find(e => e.payload?.var === 'snowline' && dayOf(e.t) === dayOf(t));
      const moved = ch ? (ch.payload.to > ch.payload.from ? '上' : '下') : null;
      wins = pick => moved != null && snowPick(pick) === moved;
    } else {
      const kinds = lab.scene(saveId).rules.weather.kinds;
      wins = pick => (weatherPick(pick, kinds) || []).includes(st.weather?.am);
    }
    const lan = wins(p.her_pick), user = wins(p.user_pick);
    const charId = lab.scene(saveId).characters[0].id;
    const winner = lan && !user ? charId : user && !lan ? 'user' : 'draw';
    const out = [host(saveId, t, { ...p, phase: 'resolved', winner })];
    // She lost: the stake is hers to do today (the 2.0 commitments take it from here: hints when due).
    if (winner === 'user') lab.commitments.add(saveId, charId, { owner: 'character', text: p.stake, dueAt: atTime(dayOf(t), '18:00'), sourceSeqs: [b.seq, out[0].seq], at: t });
    return out;
  }

  /** The bet section line for the now section: an open bet. */
  const line = saveId => { const b = open(saveId); return b ? `你们打了个赌：${b.payload.about}，你押「${b.payload.her_pick}」，他押「${b.payload.user_pick}」，赌注：${b.payload.stake}（明早见分晓）` : null; };

  return { afterReply, settle, open, line, HOUR };
}
