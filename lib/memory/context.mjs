// How a reply prompt is assembled (PLAN §4.9). The system part depends only on character + scene, so the
// provider can cache it; everything that changes goes into the user part, section by section.
import { render } from '../prompts.mjs';
import { estimate } from '../tokens.mjs';
import { formatWorldTime, formatAgo, formatSpan } from '../clock.mjs';
import { actionsText, perceivable } from '../arbiter.mjs';
import { visibility, overheardText, discovered } from '../perception.mjs';
import { sameArea } from '../scene.mjs';
import { isRichCard, cardSystemText, CARD_SYSTEM_BUDGET, stageIndex } from '../card.mjs';
import { selectLore, loreLine } from './lore.mjs';
import { pj } from '../db.mjs';
import { PREDICATES } from '../llm-checks.mjs';
import { sessionInfo, nameOf, SPEECH, eventText, turnIndexInSession } from './common.mjs';

const MODES = {
  memory: ['now', 'world', 'while_away', 'relationship', 'facts', 'self', 'commitments', 'lore', 'memories', 'map', 'hints', 'topic', 'practice', 'avoid', 'overheard', 'recent', 'mood', 'voice', 'reminder', 'input'],
  // The comparison modes get mood and reminder too, but no lore: they differ from memory mode only in memory.
  full: ['now', 'overheard', 'transcript', 'mood', 'voice', 'reminder', 'input'],
  none: ['now', 'recent', 'mood', 'voice', 'reminder', 'input']
};
const TITLES = { now: '现在', world: '最近世界里发生的事（宿主记录，以此为准）', while_away: '他不在的时候营地出的事（你经历的，可以讲给他听）', relationship: '你和用户', facts: '你知道的用户的事', self: '你说过的关于自己的话', commitments: '约定', memories: '你记得的经历', hints: '可以提起（可不提）', topic: '话头', map: '你的地图', practice: '你们在一起做的事', avoid: '不要主动提', overheard: '你旁听到的', transcript: '以前的全部对话', recent: '刚才的对话', lore: '你的过往（和现在的话题有关）', mood: '你现在的情绪', voice: '说话提醒', reminder: '提醒', input: '用户刚说' };
// 3.0 F5: how she fixed an incident, said to her.
const VERB_DONE = { fix_tent: '爬起来重新打了桩', tend_fire: '重新把火生起来了', cover_wood: '把柴重新盖好了', clean: '捡起来擦干净了', pick_up: '捡起来了', secure_crate: '把木箱捆紧了' };
const MEMORY_BUDGET = 1200;
/** 2.0 D6: how she knows a fact or an experience. */
export const KNOWN_HOW = { told: '你说的', seen: '我看见的', inferred: '我猜的' };
const GUESS = /可能|大概|也许|好像|似乎|猜|说不定/;
const WORLD_TYPES = ['char_action', 'user_action', 'object_created', 'object_removed', 'world_edit', 'fire_out', 'incident'];
export const WHILE_AWAY_TURNS = 3; // 3.0 F5: the while_away section is there for the first turns of a session
const WHILE_AWAY_MAX = 4;
const WORLD_LIMIT = 12;
// Actions with no lasting result: say so, so nobody (model included) turns them into a lasting change.
const TRANSIENT = ['clean', 'look_at', 'wave', 'idle'];
const presenceText = (e, charId) => (e.offscreen ? (e.actor === charId ? '用户不在，你自己做的' : '用户不在') : e.user_presence === 'present' ? '用户在场' : e.user_presence === 'maybe' ? '用户可能看到' : '用户不在');
const TRANSCRIPT_BUDGET = 60000;
const shortDate = t => formatWorldTime(t).split(' ')[0];

export function createContext(lab) {
  const { ledger, clock } = lab;

  /** The cause of a lan_tired change written with a fix (半夜爬起来…), or ''. */
  const tiredCause = (saveId, fix) => ledger.list(saveId, { types: ['var_changed'], before: fix.seq, desc: true, limit: 3 }).find(e => e.payload?.var === 'lan_tired' && e.t === fix.t)?.payload.cause || '';

  // 3.0 F2/F3: the weather, the temperature, the sky sign she saw and the camp's 量 she knows (not the snowline she has
  // not looked at). Wind as the rules give it.
  function worldLines(saveId, charId, scene, env) {
    const v = env.vars;
    const st = ledger.world(saveId);
    const out = [`天色：${env.sky}`];
    out.push(env.am === env.weather ? `天气：${env.weather}` : `天气：上午${env.am}，现在${env.weather}`);
    out.push(`气温：大约 ${env.temp}℃，夜里会到 ${Math.round(env.lo)}℃`, `风：${env.wind}`);
    const sign = env.sign && ledger.get(saveId, env.sign.seq);
    if (sign && visibility(sign, charId) === 'full') out.push(`天象：${env.sign.sign}（你知道这多半说明明天${scene.rules.weather.sign_meaning?.[env.sign.sign] || '变天'}，但不一定准）`);
    out.push(...env.fires.map(f => `${f.name.includes('篝火') ? '篝火' : f.name}：${f.lit ? '烧着' : '灭了'}`));
    const camp = [];
    if ('wood' in v) camp.push(`柴还有 ${v.wood} 捆${v.wood_wet ? '，湿的' : ''}${v.wood_covered ? '，盖着油布' : ''}`);
    if ('food' in v) camp.push(`口粮够 ${v.food} 天`);
    if (v.ali_eta_days != null) camp.push(`阿砾 ${formatWorldTime(lab.environment.climate(saveId, clock.now(saveId)).dayStart + (v.ali_eta_days - env.day + 1) * 86_400_000).split(' ')[0]} 回来`);
    if (v.snowline_seen != null) camp.push(`最近一次看雪线在 ${v.snowline_seen} 米，山口要 ${v.pass_height} 米`);
    if (v.tent_down) camp.push('帐篷塌了');
    else if (v.tent_secure === false) camp.push('帐篷绳松了');
    if (camp.length) out.push(`营地：${camp.join('；')}。`);
    const going = Object.values(st.incidents || {}).map(o => ({ o, inc: scene.incidents.find(i => i.id === o.id), ev: ledger.get(saveId, o.seq) }))
      .filter(x => x.inc && x.ev && visibility(x.ev, charId) === 'full');
    if (going.length) out.push(`营地正在出的事：${going.map(x => `${x.inc.name}${x.o.deadline ? `（再过 ${formatSpan(Math.max(0, x.o.deadline - clock.now(saveId)))} 不管就${x.inc.on_expire?.set?.tent_down ? '要塌' : '晚了'}）` : ''}`).join('；')}`);
    if ((v.lan_tired ?? 0) >= 2) out.push('你有点累（没睡好）');
    const bet = lab.bets.line(saveId); // 3.0 G4
    if (bet) out.push(bet);
    return out;
  }

  function system(saveId, charId) {
    const scene = lab.scene(saveId);
    const c = scene.characters.find(x => x.id === charId);
    return render('reply.system', { character_card: cardText(c), actions: actionsText(scene), moods: (c.card?.moods || [{ name: '平常' }]).map(m => m.name).join('、') });
  }

  // 1.0 cards go in verbatim; 2.0 cards are rendered from their sections and must fit the budget (no truncation).
  function cardText(c) {
    if (!isRichCard(c.card)) return c.cardText;
    const text = cardSystemText({ name: c.name, meta: c.meta, card: c.card });
    const n = estimate(text);
    if (n > CARD_SYSTEM_BUDGET) throw new Error(`${c.name}的角色卡进系统提示约 ${n} token，超过上限 ${CARD_SYSTEM_BUDGET}：请删减外貌、性格或示例对话`);
    return text;
  }

  const cardOf = (scene, charId) => scene.characters.find(x => x.id === charId)?.card;
  // Mood of this character's last committed reply; the card's first mood when there is none or it is unknown.
  function currentMood(saveId, charId, card) {
    const row = lab.db.prepare("SELECT output_json FROM turns WHERE save_id = ? AND character_id = ? AND committed = 1 ORDER BY t DESC, rowid DESC LIMIT 1").get(saveId, charId);
    const name = pj(row?.output_json, {})?.mood;
    return card.moods.find(m => m.name === name) || card.moods[0];
  }
  const recentLines = (saveId, charId, inputSeq) => ledger.list(saveId, { types: SPEECH, desc: true, limit: 40 })
    .filter(e => e.seq !== inputSeq && e.payload && (e.actor === charId || e.payload.to === charId) && visibility(e, charId) === 'full')
    .filter(e => lab.admission.allowed(saveId, charId, `ev:${e.seq}`, 'context'))
    .slice(0, 4).map(e => e.payload.text);

  /** 2.0 D6: （你说的 / 我看见的 / 我猜的） for a cache, from its source events (a guessing sentence is 我猜的). */
  function sourceTag(saveId, c) {
    if (GUESS.test(c.text)) return `（${KNOWN_HOW.inferred}）`;
    const kinds = new Set(c.derived_from.map(s => ledger.get(saveId, s)).filter(Boolean).map(e => (e.type === 'user_said' ? 'told' : e.type === 'char_said' ? null : 'seen')).filter(Boolean));
    return kinds.size ? `（${[...kinds].map(k => KNOWN_HOW[k]).join('、')}）` : '';
  }

  /**
   * 2.0 D4: with weekly digests, pick the one digest that best matches the words in play, then drill down into at
   * most 3 of that week's diaries / experiences / observations, then the newest observations not yet summarised —
   * all within MEMORY_BUDGET. No digest, or none matches → null (the 1.0 way).
   */
  function tieredMemories(saveId, charId, ok, words) {
    const weeks = lab.diary.liveWeeks(saveId, charId).filter(ok);
    if (!weeks.length) return null;
    const grams = s => { const out = new Set(); const t = String(s).replace(/[^\p{Script=Han}A-Za-z0-9]/gu, ''); for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2)); return out; };
    const want = grams(words);
    const score = text => { let n = 0; for (const g of grams(text)) if (want.has(g)) n++; return n; };
    const best = weeks.map(w => ({ w, n: score(w.text) })).filter(x => x.n > 0).sort((a, b) => b.n - a.n || b.w.day.localeCompare(a.w.day))[0];
    if (!best) return null;
    const week = best.w;
    const inWeek = c => c.derived_from.some(s => s >= week.from_seq && s <= week.to_seq);
    const below = [...lab.diary.weekDiaries(saveId, charId, week.day), ...lab.observe.live(saveId, charId, 'episode'), ...lab.observe.live(saveId, charId, 'observation')]
      .filter(c => ok(c) && (c.kind === 'diary' || inWeek(c)))
      .map(c => ({ c, n: score(c.text) })).filter(x => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 3).map(x => x.c);
    const rows = [week];
    let budget = estimate(week.text);
    for (const c of below) if (budget + estimate(c.text) <= MEMORY_BUDGET) { budget += estimate(c.text); rows.push(c); }
    const drilled = rows.length - 1;
    const last = Math.max(...weeks.map(w => w.to_seq));
    for (const o of lab.observe.live(saveId, charId, 'observation').filter(c => ok(c) && c.from_seq > last && !rows.some(r => r.id === c.id)).reverse()) {
      if (budget + estimate(o.text) > MEMORY_BUDGET) break;
      budget += estimate(o.text); rows.push(o);
    }
    const label = c => (c.kind === 'week' ? `周小结（到 ${c.day}）` : c.kind === 'diary' ? `日记 ${c.day}` : shortDate(ledger.get(saveId, Math.max(...c.derived_from))?.t ?? c.created_at));
    return { text: rows.map(c => `[cache:${c.id}] ${label(c)} ${c.text}${sourceTag(saveId, c)}`).join('\n'), refs: rows.map(c => `cache:${c.id}`), why: `先按关键词选了 1 份周小结（${week.day}），再下钻那周 ${drilled} 条，加上之后的新观察，约 ${MEMORY_BUDGET} token 以内` };
  }

  /**
   * 2.0 D6: things in her area whose last change she did not see (she was in the tent, or away): only the result,
   * "潮青陶杯现在在木桶上（不知道谁挪的）". The events themselves stay out (she did not perceive them).
   */
  function unseenMoves(saveId, charId, st, scene) {
    const c = st.characters[charId];
    const MOVES = ['user_action', 'object_changed', 'char_action'];
    const out = [];
    for (const o of Object.values(st.objects)) {
      if (o.holder || o.worn_by || !sameArea(scene, c.room, o.room)) continue;
      const last = ledger.list(saveId, { target: o.id, types: MOVES, desc: true, limit: 1 })[0];
      if (!last || last.actor === charId || visibility(last, charId) === 'full') continue;
      if (last.type === 'char_action' && last.outcome !== 'ok') continue;
      const where = o.on ? `${st.objects[o.on]?.name || nameOf(scene, o.on)}上` : nameOf(scene, o.room);
      out.push(`${o.name}现在在${where}（不知道谁挪的）`);
    }
    return out;
  }

  const line = (scene, e) => `[ev:${e.seq}] ${formatWorldTime(e.t)} ${e.actor === 'user' ? '用户' : nameOf(scene, e.actor)}：${e.payload.text}`;

  const S = {
    now({ saveId, charId, scene }) {
      const st = ledger.world(saveId);
      const c = st.characters[charId];
      const others = Object.values(st.characters).filter(x => x.id !== charId && x.room === c.room).map(x => x.name);
      const info = sessionInfo(lab, saveId);
      const lines = [`世界时间：${formatWorldTime(clock.now(saveId))}`, `你在：${nameOf(scene, c.room)}${c.elevated ? '（在高处）' : ''}${c.sitting ? `，坐在${nameOf(scene, c.sitting)}上` : ''}`];
      if (others.length) lines.push(`这里还有：${others.join('、')}`);
      // 2.0 D1: what the 作息 says she does now; asleep in the tent she only half hears what is said outside.
      const life = lab.life.now(saveId, charId);
      // 2.0 D3: what last night's diary said she wants to do today.
      const wish = lab.diary.intention(saveId, charId);
      if (wish) lines.push(`今天想：${wish}`);
      if (life) lines.push(life.asleep ? `你现在：在${nameOf(scene, c.room)}睡觉（作息 ${life.from}–${life.to}），外面的话只隐约听见` : `作息：现在是「${life.doing}」的时候（${life.from}–${life.to}，${life.place}）`);
      lines.push(c.holding ? `你手里拿着：${st.objects[c.holding]?.name || nameOf(scene, c.holding)}` : '你手里：空着');
      if (c.wearing.length) lines.push(`你身上戴着：${c.wearing.map(id => st.objects[id]?.name || id).join('、')}`);
      lines.push(st.userRoom === c.room ? '用户：在你旁边' : sameArea(scene, st.userRoom, c.room) ? `用户：在附近（在${nameOf(scene, st.userRoom)}）` : `用户：不在这里（在${nameOf(scene, st.userRoom)}）`);
      const env = lab.environment.now(saveId);
      if (env?.vars) lines.push(...worldLines(saveId, charId, scene, env));
      else if (env) lines.push(`天色：${env.sky}`, `天气：${env.weather}`, ...env.fires.map(f => `${f.name.includes('篝火') ? '篝火' : f.name}：${f.lit ? '烧着' : '灭了'}`));
      if (info.current && info.previousEnd) lines.push(`距离上次见面：${formatSpan(info.current.t - info.previousEnd.t)}`);
      // The same table the arbiter checks against: action targets must be one of these ids.
      const p = perceivable(st, scene, charId);
      lines.push('你能感知到的（id｜名称｜位置｜现在能做的动作）：', ...p.rows.map(r => `- ${r.id}｜${r.name}｜${r.where}｜${r.actions.join('、') || '现在做不了'}`));
      if (p.free.length) lines.push(`不用目标的动作：${p.free.join('、')}`);
      return { text: lines.join('\n'), refs: [], why: '世界状态和可做的动作，宿主算出来的' };
    },
    // Straight from the ledger, so it holds even when observe/reflect failed. Same admission and perception as
    // everything else: only events this character perceived, not forgotten or deleted.
    world({ saveId, charId, scene }) {
      const st = ledger.world(saveId);
      const evs = ledger.list(saveId, { types: WORLD_TYPES, desc: true, limit: 400 })
        .filter(e => e.payload && (visibility(e, charId) === 'full' || discovered(e, charId, st, scene)) && lab.admission.allowed(saveId, charId, `ev:${e.seq}`, 'context'))
        .slice(0, WORLD_LIMIT).reverse();
      // Built while this character was away: she only knows it is there now, not when or how it appeared.
      const text = e => (visibility(e, charId) === 'full' ? eventText(scene, e) : `${nameOf(scene, st.objects[e.target].room)}多了${e.payload.object?.name || nameOf(scene, e.target)}，之前没有（你不在的时候出现的）`);
      // 2.0 D6: say how she knows: her own doing, seen with her own eyes, or (below) only the result.
      const how = e => (e.actor === charId ? '' : visibility(e, charId) === 'full' ? '｜我看见的' : '');
      const line = e => `[ev:${e.seq}] ${formatWorldTime(e.t)} ${text(e)}${e.type === 'char_action' && e.outcome === 'ok' ? (TRANSIENT.includes(e.action) ? '（一时的动作，没有留下变化）' : '（成功）') : ''}｜${presenceText(e, charId)}${how(e)}`;
      const moved = unseenMoves(saveId, charId, st, scene);
      return { text: [...evs.map(line), ...moved].join('\n'), refs: evs.map(e => `ev:${e.seq}`), why: `账本里你感知到的最近 ${WORLD_LIMIT} 件动作和变化，不经过后台任务${moved.length ? `；另有 ${moved.length} 样东西被挪过但你没看见，只写现在在哪` : ''}` };
    },
    // 3.0 F5: the incidents of the last absence she lived through, one line each with how it ended (or that it is
    // still going), at most WHILE_AWAY_MAX; only in the first WHILE_AWAY_TURNS turns of the session.
    while_away({ saveId, charId, scene }) {
      const info = sessionInfo(lab, saveId);
      if (!scene.rules || !info.current || !info.previousEnd || turnIndexInSession(lab, saveId) > WHILE_AWAY_TURNS) return { text: '', refs: [] };
      const evs = ledger.list(saveId, { types: ['incident'], after: info.previousEnd.seq, before: info.current.seq, all: true })
        .filter(e => e.payload && visibility(e, charId) === 'full' && lab.admission.allowed(saveId, charId, `ev:${e.seq}`, 'context'));
      const st = ledger.world(saveId);
      const rows = evs.filter(e => e.payload.phase === 'start').map(e => {
        const inc = scene.incidents.find(i => i.id === e.payload.incident);
        const endEv = evs.find(x => x.seq > e.seq && x.payload.incident === e.payload.incident && x.payload.phase !== 'start');
        const fix = endEv && ledger.list(saveId, { types: ['char_action'], actor: charId, after: e.seq, before: endEv.seq + 1, all: true }).filter(x => x.outcome === 'ok' && x.payload?.incident === e.payload.incident).at(-1);
        const how = !endEv ? (st.incidents?.[e.payload.incident] ? '到现在还没弄好' : '')
          : endEv.payload.phase === 'expired' ? `没来得及弄，${inc?.on_expire?.set?.tent_down ? '帐篷塌了' : '过了时候'}`
            : endEv.payload.by === 'char' ? `你${fix ? (VERB_DONE[fix.action] || '弄好了') : '弄好了'}${fix && /半夜/.test(tiredCause(saveId, fix)) ? '（有点没睡好）' : ''}`
              : endEv.payload.by === 'host' ? (e.payload.incident === 'wet_wood' ? '后来晾干了' : '后来自己过去了') : '';
        return { seq: e.seq, text: `[ev:${e.seq}] ${formatWorldTime(e.t)} ${inc?.text || e.payload.incident}${e.payload.news ? `：「${e.payload.news}」` : ''}${how ? `；${how}` : ''}` };
      }).slice(-WHILE_AWAY_MAX);
      return { text: rows.map(r => r.text).join('\n'), refs: rows.map(r => `ev:${r.seq}`), why: `上次他走后到这次回来之间你感知到的意外（最多 ${WHILE_AWAY_MAX} 条），只在这次会话前 ${WHILE_AWAY_TURNS} 轮` };
    },
    topic: ({ saveId, charId }) => lab.topics.section(saveId, charId), // 3.0 G1
    practice: ({ saveId, charId }) => lab.practice.section(saveId, charId), // 3.0 G3
    // 3.0 G2: what she has drawn on her map from what the user told her (the scout itself she never saw).
    map({ saveId, scene }) {
      if (!scene.rules || !lab.features(saveId).scout) return { text: '', refs: [] };
      const st = ledger.world(saveId);
      const marks = (st.vars?.map || []).slice(-8);
      const went = st.scouted && !(marks.some(m => st.scouted.finds.includes(m.find))) ? '他出去探过路（去了哪、看见了什么你都不知道，他说了才知道；他说了的可以用 mark_map 画上）' : '';
      return { text: [...marks.map(m => `${m.dir}：${m.note}${m.sure ? '（确定）' : '（？）'}`), went].filter(Boolean).join('\n'), refs: [], why: '她地图上的记号，只来自用户说的话' };
    },
    relationship({ saveId, charId, scene }) {
      const arc = cardOf(scene, charId)?.arc?.[lab.relationship.compute(saveId, charId).stage];
      return { text: [lab.relationship.card(saveId, charId), arc && `这个阶段的你：${arc}`].filter(Boolean).join('\n'), refs: [], why: arc ? '确定性折叠：事件计数；末行是角色卡成长弧的当前阶段' : '确定性折叠：事件计数' };
    },
    lore({ saveId, charId, scene, input, inputSeq }) {
      const card = cardOf(scene, charId);
      const stage = lab.relationship.compute(saveId, charId).stage;
      // 2.0 D5: a 秘密 never enters any context below its stage; at or past it, it sits here, marked.
      const secrets = (card?.secrets || []).map((s, i) => ({ ...s, i })).filter(s => stageIndex(stage) >= stageIndex(s.stage));
      if (!card?.lore.length && !secrets.length) return { text: '', refs: [] };
      const rows = selectLore(card.lore || [], { input, recent: recentLines(saveId, charId, inputSeq), stage });
      const lines = [...rows.map(loreLine), ...secrets.map(s => `[secret:${s.i}] ${s.text}（这是你的秘密，被问到才说${s.note ? `；${s.note}` : ''}）`)];
      return { text: lines.join('\n'), refs: [...rows.map(l => `lore:${l.id}`), ...secrets.map(s => `secret:${s.i}`)], why: `角色卡「过往」按关键词选（刚说的话 ×2，最近 4 句 ×1），只选${stage}及以前能说的，最多 3 条${secrets.length ? `；加上到了${stage}能说的秘密 ${secrets.length} 条` : ''}` };
    },
    mood({ saveId, charId, scene }) {
      const card = cardOf(scene, charId);
      if (!card || !isRichCard(card)) return { text: '', refs: [] };
      const m = currentMood(saveId, charId, card);
      return { text: `你现在：${m.name}。${m.speech}${m.action ? `${/[。！？]$/.test(m.speech) || !m.speech ? '' : '。'}会${m.action.replace(/。$/, '')}。` : ''}`, refs: [], why: '上一轮回复的 mood 对应的情绪模式（第一轮用默认情绪）' };
    },
    // 3.0 E1: what she has been overdoing lately (only when the save has the voice feature).
    voice({ saveId, charId }) { return lab.voice.section(saveId, charId); },
    reminder({ scene, charId }) {
      const r = cardOf(scene, charId)?.reminder || [];
      return { text: r.map(x => `- ${x}`).join('\n'), refs: [], why: '角色卡「深度提醒」原文，放在用户这句话前面' };
    },
    facts({ saveId, charId }) {
      const now = clock.now(saveId);
      const rows = lab.facts.active(saveId, charId).reverse().filter(f => lab.admission.allowed(saveId, charId, `fact:${f.id}`, 'context')).slice(0, 60);
      return { text: rows.map(f => `[fact:${f.id}] ${PREDICATES[f.predicate]?.label || f.predicate}：${f.object}（${KNOWN_HOW[f.known_how || 'told']}，记于${formatAgo(now - f.recorded_at)}）${f.sensitivity === 'private' ? '「私密，不要主动提」' : ''}`).join('\n'), refs: rows.map(f => `fact:${f.id}`), why: '准入通过的 active 事实，新的优先；括号里是你怎么知道的' };
    },
    self({ saveId, charId }) {
      const rows = lab.selfCanon.list(saveId, charId).filter(r => r.status === 'active' && lab.admission.allowed(saveId, charId, `sc:${r.id}`, 'context')).slice(-20);
      return { text: rows.map(r => `[sc:${r.id}] ${r.text}`).join('\n'), refs: rows.map(r => `sc:${r.id}`), why: '你自己说过的设定' };
    },
    commitments({ saveId, charId, scene }) {
      const rows = lab.commitments.list(saveId, charId, 'open').filter(k => lab.admission.allowed(saveId, charId, `commit:${k.id}`, 'context'));
      return { text: rows.map(k => `[commit:${k.id}] ${k.owner === 'character' ? `${nameOf(scene, charId)}答应的` : '用户答应的'}：${k.text}${k.due_at ? `（到期：${formatWorldTime(k.due_at)}）` : ''}`).join('\n'), refs: rows.map(k => `commit:${k.id}`), why: 'open 的约定' };
    },
    memories({ saveId, charId, input, inputSeq }) {
      const ok = c => lab.admission.allowed(saveId, charId, `cache:${c.id}`, 'context');
      const tiered = tieredMemories(saveId, charId, ok, `${input || ''}\n${recentLines(saveId, charId, inputSeq).join('\n')}`);
      if (tiered) return tiered;
      const eps = lab.observe.live(saveId, charId, 'episode').filter(ok);
      const obs = lab.observe.live(saveId, charId, 'observation').filter(ok).reverse();
      let budget = eps.reduce((n, c) => n + estimate(c.text), 0);
      const picked = [];
      for (const o of obs) { if (budget + estimate(o.text) > MEMORY_BUDGET && picked.length) break; budget += estimate(o.text); picked.push(o); }
      const rows = [...eps, ...picked.reverse()];
      const when = c => ledger.get(saveId, Math.max(...c.derived_from))?.t ?? c.created_at;
      return { text: rows.map(c => `[cache:${c.id}] ${shortDate(when(c))} ${c.text}${sourceTag(saveId, c)}`).join('\n'), refs: rows.map(c => `cache:${c.id}`), why: `全部经历 + 最新的观察，约 ${MEMORY_BUDGET} token 以内；括号里是你怎么知道的` };
    },
    hints({ saveId, hints, extraHints }) {
      const lines = hints.map(h => {
        const info = lab.admission.lookup(saveId, h.ref);
        return `[${h.ref}] 理由：${h.reason}。${info?.text ? `内容：${info.text.slice(0, 80)}` : ''}`;
      });
      const head = lines.length ? ['下面的事可以自然提起，也可以不提；不要说“我记得”。'] : [];
      return { text: [...head, ...lines, ...extraHints].join('\n'), refs: hints.map(h => h.ref), why: hints.map(h => h.rule).join('、') || (extraHints.length ? '宿主提示' : '') };
    },
    avoid({ saveId, charId }) {
      const rows = lab.admission.activeSuppressions(saveId, charId).filter(s => s.topic);
      return { text: rows.map(s => `- ${s.topic}`).join('\n'), refs: [], why: '用户说过别再提' };
    },
    overheard({ saveId, charId, scene }) {
      const gone = lab.admission.forgottenSet(saveId, charId);
      const evs = ledger.list(saveId, { types: SPEECH, desc: true, limit: 200 }).filter(e => e.payload && !gone.has(e.seq) && visibility(e, charId) === 'overheard').slice(0, 6).reverse();
      return { text: evs.map(e => `${formatWorldTime(e.t)} ${overheardText(e, scene)}`).join('\n'), refs: [], why: '同一房间里别人的对话，只知道发生过' };
    },
    transcript({ saveId, charId, scene, inputSeq }) {
      // The comparison modes share the main mode's retraction policy: forgotten, deleted, suppressed speech stays out.
      const evs = ledger.list(saveId, { types: SPEECH, all: true }).filter(e => e.payload && e.seq !== inputSeq && visibility(e, charId) === 'full' && (e.actor === charId || e.payload.to === charId))
        .filter(e => lab.admission.allowed(saveId, charId, `ev:${e.seq}`, 'context'));
      const lines = evs.map(e => line(scene, e));
      let total = lines.reduce((n, l) => n + estimate(l), 0);
      let dropped = 0;
      while (total > TRANSCRIPT_BUDGET && lines.length) { total -= estimate(lines.shift()); dropped++; }
      return { text: lines.join('\n'), refs: [], dropped, why: dropped ? `对照组：聊天原文，超过约 60k token，截掉了最早的 ${dropped} 条` : `对照组：聊天原文，全部 ${lines.length} 条` };
    },
    recent({ saveId, charId, scene, inputSeq, mode }) {
      const info = sessionInfo(lab, saveId);
      const sessions = mode === 'none' ? [info.save.session_id] : [info.save.session_id, info.previousSessionId];
      const limit = mode === 'none' ? 6 : 12;
      const evs = ledger.list(saveId, { types: SPEECH, desc: true, limit: 400 })
        .filter(e => e.seq !== inputSeq && e.payload && sessions.includes(e.session_id) && (e.actor === charId || e.payload.to === charId) && visibility(e, charId) === 'full')
        .filter(e => lab.admission.allowed(saveId, charId, `ev:${e.seq}`, 'context'))
        .slice(0, limit).reverse();
      return { text: evs.map(e => line(scene, e)).join('\n'), refs: evs.map(e => `ev:${e.seq}`), why: mode === 'none' ? `对照组：短上下文，本次会话最近 6 条（这次有 ${evs.length} 条）` : '本次和上次会话最近 12 条，不经过后台任务' };
    },
    input({ input }) { return { text: input, refs: [], why: '这一句' }; }
  };

  /** → { system, user, sections: [{ name, title, text, tokens, refs, why }], hints } */
  function build({ mode = 'memory', saveId, charId, input, inputSeq, hints = [], extraHints = [] }) {
    lab.facts.expire(saveId);
    lab.commitments.expire(saveId);
    const scene = lab.scene(saveId);
    const args = { saveId, charId, scene, input, inputSeq, mode, hints, extraHints };
    const sections = [];
    for (const name of MODES[mode]) {
      const s = S[name](args);
      if (!s.text) continue;
      sections.push({ name, title: TITLES[name], text: s.text, tokens: estimate(s.text), refs: s.refs, why: s.why, ...(s.dropped ? { dropped: s.dropped } : {}) });
    }
    const sys = system(saveId, charId);
    const user = sections.map(s => `## ${s.title}\n${s.text}`).join('\n\n');
    return { system: sys, user, sections, systemTokens: estimate(sys) };
  }

  /** One section on its own (2.0 D2 idle thoughts reuse now / world / recent / hints). */
  const section = (name, args) => S[name]({ scene: lab.scene(args.saveId), mode: 'memory', hints: [], extraHints: [], ...args });

  return { build, system, section };
}
