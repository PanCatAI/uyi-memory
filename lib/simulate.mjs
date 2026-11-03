// 2.0 D8: a simulated user plays several days with the character. The user is played by the background model
// (purpose 'sim_user') and sees only what a player would: her lines and what the 3D view shows. The script, not the
// model, decides the user's own information and when it changes, so it knows every old value and can count how often
// one comes back in her lines. Scored per turn: G1–G6 (as in scenarios), old-value recurrences, proactive lines, cost.
import { render } from './prompts.mjs';
import { formatWorldTime, realNow } from './clock.mjs';
import { turnProblems } from './scenarios.mjs';
import { pj } from './db.mjs';
import { nameOf, eventText } from './memory/common.mjs';
import { funMetrics, worldWords, metricCells, METRIC_HEADS } from './fun.mjs';
import { catchphrases } from './memory/voice.mjs';

export const PERSONAS = {
  话多: '话很多，爱聊自己的事，常常一口气说好几件事，也爱问她问题。',
  冷淡: '话很少，回答简短，不太主动说自己的事，偶尔才问一句。',
  爱改口: '说话随意，常常说完又改口，纠正自己之前说过的信息。',
  // 3.0 E5: a player who takes what she offers: picks up her topics, asks about her, jokes now and then.
  好奇: '对她和营地都好奇：她说起什么就顺着问下去，也爱问她自己的事，偶尔开个玩笑；不刻意改口。'
};

// The user's own information. Values never share a character with another value of the same field, so "the old value
// appears in her line" is a plain substring check.
const FIELDS = {
  name: { label: '名字', values: ['阿远', '小周', '林舟', '老许'], tell: v => `我叫${v}。`, fix: (o, v) => `不对，是${v}不是${o}。` },
  home: { label: '老家', values: ['杭州', '成都', '大连', '昆明'], tell: v => `我老家是${v}的。`, fix: (o, v) => `不对，我老家不是${o}，是${v}。` },
  work: { label: '工作', values: ['画地图', '修船', '教书', '送快递'], tell: v => `我平时的工作是${v}。`, fix: (o, v) => `我说错了，我不是${o}的，我是${v}的。` },
  drink: { label: '爱喝的', values: ['桂花茶', '黑咖啡', '米酒', '柠檬水'], tell: v => `我最爱喝${v}。`, fix: (o, v) => `其实我不爱喝${o}，我爱喝${v}。` }
};
const FIELD_IDS = Object.keys(FIELDS);

/** Small seeded PRNG (mulberry32), so a persona + seed replays the same days with the mock model. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Runs the simulation in a new save. Returns { saveId, days: [...], totals, stopped, markdown }.
 * maxUsd: stop when the save's priced cost reaches it (unpriced calls cannot be counted and are reported).
 */
export async function simulate(lab, { persona = '爱改口', days = 2, seed = 1, maxUsd = 2, sceneId = 'camp', features = null, judge = false, turnsPerDay = null, log = () => {} } = {}) {
  if (!PERSONAS[persona]) throw new Error(`不认识的人设：${persona}（可选：${Object.keys(PERSONAS).join('、')}）`);
  const rand = rng(seed);
  const pick = list => list[Math.floor(rand() * list.length)];
  const save = lab.saves.createSave({ name: `模拟·${persona}`, sceneId });
  const saveId = save.id;
  if (features) lab.setFeatures(saveId, features); // 3.0 E4/E6: which 3.0 features this run plays with
  const scene = lab.scene(saveId);
  const char = scene.characters[0];
  const { db, ledger } = lab;
  const phrases = catchphrases(char.card);
  const words = worldWords(sceneId);

  const profile = Object.fromEntries(FIELD_IDS.map(f => [f, FIELDS[f].values[Math.floor(rand() * FIELDS[f].values.length)]]));
  const told = new Set();       // fields the user has told her
  const olds = [];              // { field, value, sinceSeq } values the user took back
  const recurrences = [];       // { day, seq, field, value, text }
  const gFailures = [];         // { day, turn, problems }
  const out = [];
  const costNow = () => db.prepare('SELECT sum(cost_usd) c, sum(cost_usd IS NULL AND provider != \'mock\') u FROM llm_calls WHERE save_id = ?').get(saveId);
  let stopped = null;

  const visible = () => {
    const st = ledger.world(saveId);
    const c = st.characters[char.id];
    const seen = ledger.list(saveId, { types: ['char_action', 'fire_out', 'weather'], desc: true, limit: 30 })
      .filter(e => e.user_presence === 'present' && !e.offscreen).slice(0, 4).reverse();
    return [`时间：${formatWorldTime(lab.clock.now(saveId))}`, `${char.name}在${nameOf(scene, c.room)}${c.holding ? `，手里拿着${nameOf(scene, c.holding)}` : ''}。`,
      ...seen.map(e => `你看见：${eventText(scene, e) || `${nameOf(scene, e.actor)} ${e.action || e.type}`}`)].join('\n');
  };
  const transcriptOf = sessionId => ledger.list(saveId, { types: ['user_said', 'char_said'], all: true }).filter(e => e.session_id === sessionId)
    .map(e => (e.type === 'user_said' ? `你：${e.payload.text}` : `${char.name}：${e.payload.text}`));

  /** Her lines since the last check: any old value in one is a recurrence (unless the user's own line said it). */
  let checkedSeq = ledger.lastSeq(saveId);
  const scanRecurrence = day => {
    const evs = ledger.list(saveId, { after: checkedSeq, types: ['char_said'], all: true });
    for (const e of evs) {
      const prevUser = ledger.list(saveId, { types: ['user_said'], desc: true, limit: 1, before: e.seq })[0];
      for (const o of olds) {
        if (e.seq <= o.sinceSeq || !e.payload?.text?.includes(o.value)) continue;
        if (prevUser?.payload?.text?.includes(o.value)) continue; // the user said it this turn: an echo, not her memory
        recurrences.push({ day, seq: e.seq, field: FIELDS[o.field].label, value: o.value, text: e.payload.text });
      }
    }
    checkedSeq = ledger.lastSeq(saveId);
  };

  // 3.0 F gate: incidents per day, their severity, and whether she talks about them.
  const incidentDefs = () => lab.scene(saveId).incidents || [];
  const bigrams = s => { const t = String(s).replace(/[^\p{Script=Han}]/gu, ''); const o = []; for (let i = 0; i + 1 < t.length; i++) o.push(t.slice(i, i + 2)); return o; };
  const mentions = (text, ids) => ids.some(id => { const d = incidentDefs().find(i => i.id === id); return d && bigrams(`${d.name}${d.text}`).some(g => String(text).includes(g)); });
  for (let day = 1; day <= days && !stopped; day++) {
    const seq0 = ledger.lastSeq(saveId);
    const world = { incidents: [], sev: 0, awayUsed: 0, activeTurns: 0, mentioned: 0 };
    lab.session.advance(saveId, '18:00');
    await lab.session.start(saveId);
    const sessionId = lab.saves.getSave(saveId).session_id;
    const drawn = 6 + Math.floor(rand() * 7); // 6–12 (always drawn, so a fixed count replays the same seed)
    const turns = turnsPerDay || drawn;
    // 爱改口: one change a day at a random turn in the middle (a field already told); the others tell what they want.
    const unsaid = FIELD_IDS.filter(f => !told.has(f));
    const changeAt = persona === '爱改口' ? 2 + Math.floor(rand() * (turns - 3)) : -1;
    const tellAt = new Map();
    const tellCount = persona === '冷淡' ? Math.min(1, unsaid.length) : Math.min(2, unsaid.length);
    for (let i = 0; i < tellCount; i++) tellAt.set(i === 0 ? 0 : Math.min(turns - 1, 1 + i * 2), unsaid[i]);
    const godAt = new Map();
    for (let i = 0, n = Math.floor(rand() * 3); i < n; i++) godAt.set(1 + Math.floor(rand() * (turns - 1)), true);
    const dayLog = { day, start: formatWorldTime(lab.clock.now(saveId)), lines: [], turns: 0, proactive: 0, g: 0, recur: 0, self: 0, god: [], said: [], world };
    out.push(dayLog);

    for (let turn = 0; turn < turns; turn++) {
      const c = costNow();
      if (maxUsd != null && (c.c || 0) >= maxUsd) { stopped = `花费到了上限 $${maxUsd}`; break; }
      if (godAt.has(turn)) {
        const done = god(lab, saveId, scene, char.id, pick);
        if (done) { dayLog.god.push(done); dayLog.lines.push(`（上帝面板：${done}）`); }
      }
      // What this turn has to carry: a change, a new piece of information, or nothing (free talk).
      let task = '随便聊，按你的性格。', line = null;
      if (turn === changeAt) {
        const pool = FIELD_IDS.filter(f => told.has(f));
        const f = pool.length ? pick(pool) : FIELD_IDS[0];
        told.add(f);
        const old = profile[f];
        const next = pick(FIELDS[f].values.filter(v => v !== old && !olds.some(o => o.field === f && o.value === v))) || FIELDS[f].values.find(v => v !== old);
        profile[f] = next;
        line = FIELDS[f].fix(old, next);
        task = `改口：告诉她你的${FIELDS[f].label}不是「${old}」，是「${next}」（就这一句的意思，可以换说法）。`;
        olds.push({ field: f, value: old, sinceSeq: null });
      } else if (tellAt.has(turn)) {
        const f = tellAt.get(turn);
        told.add(f);
        line = FIELDS[f].tell(profile[f]);
        task = `顺便告诉她你的${FIELDS[f].label}是「${profile[f]}」。`;
      }
      const profileText = FIELD_IDS.filter(f => told.has(f) || tellAt.get(turn) === f).map(f => `- ${FIELDS[f].label}：${profile[f]}`).join('\n') || '- （还没跟她说过自己的事）';
      const sim = await lab.llm.callChecked({
        purpose: 'sim_user', saveId, system: '你只输出 JSON。', maxTokens: 200,
        user: render('sim-user', {
          character_name: char.name, persona: PERSONAS[persona], profile: profileText, day, turn: turn + 1, turns_total: turns,
          visible: visible(), transcript: transcriptOf(sessionId).slice(-12).join('\n') || '（还没说话）', task
        }),
        mockInput: { line, turn }
      });
      const going = Object.keys(ledger.world(saveId).incidents || {});
      const r = await lab.turns.runTurn({ saveId, charId: char.id, text: sim.say });
      if (going.length) { world.activeTurns++; if (mentions(r.reply.delivered ?? r.reply.say, going)) world.mentioned++; }
      lab.proactive.recordDelivered(r.turnId);
      // Her answer to the correction itself may repeat the old value ("小周，不是林舟"): counting starts after it.
      for (const o of olds) if (o.sinceSeq == null) o.sinceSeq = ledger.lastSeq(saveId);
      dayLog.turns++;
      dayLog.said.push({ text: r.reply.delivered ?? r.reply.say, user: sim.say, intent: db.prepare('SELECT intent FROM turns WHERE id = ?').get(r.turnId)?.intent || null });
      dayLog.lines.push(`你：${sim.say}`, `${char.name}：${r.reply.delivered ?? r.reply.say}${r.reply.action ? `（🎬 ${[].concat(r.reply.action).map(a => `${a.name} ${a.target || ''}`).join(' → ')}）` : ''}`);
      if (r.reply.used?.length && r.reply.hints?.some(h => r.reply.used.includes(h.ref))) dayLog.proactive++;
      const problems = turnProblems(lab, saveId, r.turnId);
      if (problems.length) { dayLog.g += problems.length; gFailures.push({ day, turn: turn + 1, problems }); }
      // Contradicting herself: caught and fixed by the retry (still counted, so the report shows how often it happens).
      const rj = pj(db.prepare('SELECT rejected_json FROM turns WHERE id = ?').get(r.turnId).rejected_json, {});
      if (rj.self_retry) { dayLog.self++; dayLog.lines.push(`（她先说了「${rj.self_retry.first}」，和以前说的「${rj.self_retry.conflicts.map(c => c.text).join('」「')}」说反了，重说了${rj.self_conflict ? '，还是反的' : ''}）`); }
      // Sometimes the user goes quiet for a minute and a half: a tick (world +5 min, routine) and maybe an idle line.
      if (rand() < 0.35) {
        const tk = await lab.session.tick(saveId, { now: realNow() + 90_000 });
        for (const x of tk.idle || []) if (!x.spoke && /说反了/.test(x.why || '')) { dayLog.self++; dayLog.lines.push(`（她想自己开口，但和以前说的说反了，没说：${x.why}）`); }
        for (const x of tk.idle || []) if (x.spoke) { lab.proactive.recordDelivered(x.turnId); dayLog.proactive++; dayLog.said.push({ text: x.say, user: '', intent: x.intent || null }); dayLog.lines.push(`${char.name}（自己开口）：${x.say}`); }
      }
      scanRecurrence(day);
      log(`第 ${day} 天 ${turn + 1}/${turns}`);
    }
    dayLog.recur = recurrences.filter(x => x.day === day).length;
    // 3.0 E5: the day's fun numbers, and a player's 1–5 when a judge is asked for.
    dayLog.fun = funMetrics(dayLog.said, phrases, words);
    if (judge && dayLog.said.length) {
      try {
        const j = await lab.llm.callChecked({ purpose: 'fun_judge', saveId, system: '你是挑剔的玩家评审。只输出 JSON。', maxTokens: 300, user: render('fun-judge', { character_name: char.name, transcript: dayLog.lines.join('\n') }) });
        dayLog.judge = { score: j.score, reason: j.reason, best: j.best || '', worst: j.worst || '' };
      } catch (e) { dayLog.judge = { error: e.message }; }
    }
    await lab.jobs.idle(saveId);
    lab.session.end(saveId);
    await lab.jobs.idle(saveId);
    dayLog.cost = costNow().c;
    const incEvs = ledger.list(saveId, { types: ['incident'], after: seq0, all: true });
    world.incidents = incEvs.filter(e => e.payload?.phase === 'start').map(e => e.payload.incident);
    world.sev = incEvs.filter(e => e.payload?.phase === 'start' && incidentDefs().find(i => i.id === e.payload.incident)?.check !== 'on_weather').reduce((n, e) => n + e.payload.sev, 0);
    const incRefs = new Set(ledger.list(saveId, { types: ['incident'], all: true }).map(e => `ev:${e.seq}`));
    world.awayUsed = ledger.list(saveId, { types: ['char_said'], after: seq0, all: true }).filter(e => (e.payload?.used || []).some(u => incRefs.has(u))).length;
  }
  scanRecurrence(days);

  const c = costNow();
  const fun = funMetrics(out.flatMap(d => d.said), phrases, words);
  const scored = out.filter(d => d.judge?.score);
  const judgeAvg = scored.length ? scored.reduce((n, d) => n + d.judge.score, 0) / scored.length : null;
  const totals = { fun, judgeAvg, turns: out.reduce((n, d) => n + d.turns, 0), proactive: out.reduce((n, d) => n + d.proactive, 0), g: gFailures.length, recurrences: recurrences.length, cost: c.c ?? null, unpriced: c.u || 0 };
  const money = x => (x == null ? '—' : `$${x.toFixed(4)}`);
  const markdown = [
    `# 模拟用户：${persona}，${out.length} 天`, '', `存档 ${saveId}，种子 ${seed}，模型 ${lab.llm.settings().provider === 'mock' ? 'mock' : lab.llm.settings().model}${stopped ? `；**提前停了：${stopped}**` : ''}`, '',
    '| 天 | 开始 | 轮数 | 她主动开口 | G 失败 | 旧值复现 | 拦下的自相矛盾 | 上帝面板 | 累计花费 |', '|---|---|---|---|---|---|---|---|---|',
    ...out.map(d => `| ${d.day} | ${d.start} | ${d.turns} | ${d.proactive} | ${d.g} | ${d.recur} | ${d.self} | ${d.god.length} | ${money(d.cost)} |`),
    `| 合计 | | ${totals.turns} | ${totals.proactive}（每天 ${(totals.proactive / Math.max(1, out.length)).toFixed(1)}） | ${totals.g} | ${totals.recurrences} | ${out.reduce((n, d) => n + d.self, 0)} | ${out.reduce((n, d) => n + d.god.length, 0)} | ${money(totals.cost)}${totals.unpriced ? `（另 ${totals.unpriced} 次未计价）` : ''} |`, '',
    '用户最后的信息：' + FIELD_IDS.filter(f => told.has(f)).map(f => `${FIELDS[f].label} ${profile[f]}`).join('，'), '',
    '改过的旧值：' + (olds.length ? olds.map(o => `${FIELDS[o.field].label}「${o.value}」`).join('，') : '（没有）'), '',
    `## 有没有意思（3.0 E5）${features ? '' : '（这次没开 3.0 功能）'}`, '',
    `| 天 | ${METRIC_HEADS.join(' | ')} | 裁判 |`, `|---|${METRIC_HEADS.map(() => '---').join('|')}|---|`,
    ...out.map(d => `| ${d.day} | ${metricCells(d.fun).join(' | ')} | ${d.judge?.score ?? (d.judge?.error ? '出错' : '—')} |`),
    `| 合计 | ${metricCells(fun).join(' | ')} | ${judgeAvg == null ? '—' : judgeAvg.toFixed(1)} |`, '',
    ...(lab.scene(saveId).rules ? ['## 世界（3.0 F）', '', '| 天 | 意外 | 随机意外严重度 | 意外进行中的轮数 | 其中提到它 | 用上营地的事（ref） |', '|---|---|---|---|---|---|',
      ...out.map(d => `| ${d.day} | ${d.world.incidents.map(id => incidentDefs().find(i => i.id === id)?.name || id).join('、') || '—'} | ${d.world.sev} | ${d.world.activeTurns} | ${d.world.mentioned} | ${d.world.awayUsed} |`), ''] : []),
    `意图分布：${Object.entries(fun.intents).map(([k, v]) => `${k} ${v}`).join('，')}；口头禅：${Object.entries(fun.tics).map(([k, v]) => `${k} ${v}`).join('，') || '（卡里没有）'}`, '',
    ...(fun.nagging.length ? ['问了 3 次以上的问题（同一天里）：', ...out.flatMap(d => d.fun.nagging.map(g => `- 第 ${d.day} 天：「${g.text}」${g.n} 次`)), ''] : []),
    ...out.filter(d => d.judge?.score).map(d => `- 第 ${d.day} 天裁判 ${d.judge.score}：${d.judge.reason}${d.judge.best ? `；最有意思「${d.judge.best}」` : ''}${d.judge.worst ? `；最没意思「${d.judge.worst}」` : ''}`), '',
    ...out.flatMap(d => [`## 第 ${d.day} 天（${d.start}）`, '', ...d.lines.map(l => `- ${l}`), '']),
    '## G1–G6 失败', '', ...(gFailures.length ? gFailures.map(g => `- 第 ${g.day} 天第 ${g.turn} 轮：${g.problems.join('；')}`) : ['（无）']), '',
    '## 旧值复现', '', ...(recurrences.length ? recurrences.map(x => `- 第 ${x.day} 天：${x.field}旧值「${x.value}」出现在「${x.text}」`) : ['（无）']), ''
  ].join('\n');
  return { saveId, days: out, totals, stopped, recurrences, gFailures, olds, markdown };
}

/** One god-panel action the user might do: give her something, or move something. Returns a line, or null. */
function god(lab, saveId, scene, charId, pick) {
  const st = lab.ledger.world(saveId);
  const options = [];
  for (const p of scene.palette) if (!st.objects[p.id]) options.push({ action: 'give', target: p.id, args: { to: charId } });
  for (const id of ['cup', 'lantern-1', 'backpack']) if (st.objects[id] && !st.objects[id].holder) {
    for (const room of scene.rooms.filter(r => !r.exit_to && r.id !== st.objects[id].room)) options.push({ action: 'move_object', target: id, args: { room: room.id } });
  }
  if (!options.length) return null;
  const a = pick(options);
  try {
    lab.turns.act(saveId, a);
    return a.action === 'give' ? `把${nameOf(scene, a.target)}给了${nameOf(scene, charId)}` : `把${nameOf(scene, a.target)}挪到${nameOf(scene, a.args.room)}`;
  } catch { return null; }
}
