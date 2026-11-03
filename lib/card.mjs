// Character card 2.0 (contracts/card.md): markdown → structured card. Old cards (设定 / 说话方式 / 禁止 only) still
// parse; missing sections come back empty. Errors are Chinese and carry the line number.

export const STAGES = ['初识', '熟悉', '亲近', '挚友'];
export const stageIndex = s => STAGES.indexOf(s);

const SECTIONS = [
  ['canon', '设定'], ['looks', '外貌'], ['traits', '核心性格'], ['wants', '想要'], ['values', '价值观'], ['voice', '说话方式'],
  ['view', '对用户的初始看法'], ['knows', '知识边界'], ['examples', '示例对话'], ['moods', '情绪模式'], ['lore', '过往'],
  ['routine', '作息'], ['secrets', '秘密'], ['arc', '成长弧'], ['reminder', '深度提醒'], ['forbid', '禁止']
];
export const SECTION_TITLES = Object.fromEntries(SECTIONS.map(([k, t]) => [k, t]));

const bullet = l => /^\s*-\s+/.test(l.text);
const unbullet = s => s.replace(/^\s*-\s+/, '').trim();
const splitList = (s, re = /[；;]/) => s.split(re).map(x => x.trim().replace(/。$/, '')).filter(Boolean);
const keyVal = s => { const m = /^([^：:]+)[：:]\s*(.*)$/.exec(s); return m ? [m[1].trim(), m[2].trim()] : [null, s]; };
const plain = lines => lines.map(l => l.text).join('\n').trim();

function fail(line, msg) { throw new Error(`第 ${line} 行：${msg}`); }

function minutes(hhmm, line) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m || Number(m[1]) > 24 || Number(m[2]) > 59) fail(line, `时间写法不对：${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

function parseSteps(s, line) {
  return s.split(/\s*→\s*/).map(x => x.trim()).filter(Boolean).map(x => {
    const w = /[（(]\s*with\s*[:：]\s*([\w-]+)\s*[）)]\s*$/.exec(x);
    const head = (w ? x.slice(0, w.index) : x).trim().split(/\s+/);
    if (!/^[a-z_]+$/.test(head[0] || '')) fail(line, `作息动作写法不对：${x}`);
    return { name: head[0], target: head[1] || null, args: w ? { with: w[1] } : {} };
  });
}

const PARSERS = {
  canon: ls => ls.filter(bullet).map(l => unbullet(l.text)),
  traits: ls => ls.filter(bullet).map(l => { const [name, how] = keyVal(unbullet(l.text)); return { name: name || '', how }; }),
  voice: ls => {
    const v = { length: '', habits: [], metaphors: [], never: [] };
    const rest = [];
    for (const l of ls) {
      const [k, val] = keyVal(unbullet(l.text));
      if (k === '句长') v.length = val;
      else if (k === '口头习惯') v.habits = splitList(val);
      else if (k === '比喻库') v.metaphors = splitList(val);
      else if (k === '绝不说') v.never = splitList(val, /[、，,；;]/);
      else if (l.text.trim()) rest.push(unbullet(l.text));
    }
    if (rest.length) v.length = [v.length, ...rest].filter(Boolean).join('\n');
    return v;
  },
  examples: ls => ls.filter(l => l.text.trim()).map(l => {
    const m = /^\s*(?:-\s+)?<([^>]+)>\s*用户[：:]\s*(.+?)\s+([^\s：:]+)[：:]\s*(.+)$/.exec(l.text);
    if (!m) fail(l.line, '示例对话要写成「<场合> 用户：… 角色名：…」');
    return { occasion: m[1].trim(), user: m[2].trim(), speaker: m[3].trim(), reply: m[4].trim() };
  }),
  moods: ls => {
    const out = [];
    for (const l of ls.filter(bullet)) {
      const [head, act] = unbullet(l.text).split('｜');
      const [name, speech] = keyVal(head);
      if (!name) fail(l.line, '情绪模式要写成「名：怎么说话｜动作：…」');
      if (out.some(m => m.name === name)) fail(l.line, `情绪模式重名：${name}`);
      out.push({ name, speech, action: act ? keyVal(act)[1] : '' });
    }
    return out;
  },
  lore: ls => {
    const out = [];
    for (const l of ls.filter(bullet)) {
      const m = /^\[([a-z0-9_]+)\]\s*(.+)$/.exec(unbullet(l.text));
      if (!m) fail(l.line, '过往要以 [id] 开头');
      const [title, text, kw, st] = m[2].split('｜').map(x => x.trim());
      if (!text) fail(l.line, `过往 ${m[1]} 缺正文`);
      const stage = st ? keyVal(st)[1] : '初识';
      if (!STAGES.includes(stage)) fail(l.line, `阶段名不认识：${stage}`);
      if (out.some(x => x.id === m[1])) fail(l.line, `过往 id 重复：${m[1]}`);
      out.push({ id: m[1], title, text, keywords: kw ? splitList(keyVal(kw)[1], /[、，,]/) : [], stage });
    }
    return out;
  },
  routine: ls => {
    const out = [];
    for (const l of ls.filter(bullet)) {
      const [span, place, doing, steps] = unbullet(l.text).split('｜').map(x => x?.trim());
      const t = /^(\d{1,2}:\d{2})\s*[–—-]\s*(\d{1,2}:\d{2})$/.exec(span || '');
      if (!t) fail(l.line, '作息要写成「HH:MM–HH:MM｜地点｜做什么｜动作」');
      out.push({ from: t[1], to: t[2], fromMin: minutes(t[1], l.line), toMin: minutes(t[2], l.line), place: place || '', doing: doing || '', steps: steps ? parseSteps(steps, l.line) : [], line: l.line });
    }
    if (out.length) {
      const used = new Array(1440).fill(null);
      for (const r of out) {
        const len = (r.toMin - r.fromMin + 1440) % 1440 || 1440;
        for (let i = 0; i < len; i++) {
          const m = (r.fromMin + i) % 1440;
          if (used[m] !== null) fail(r.line, `作息时间段重叠（和第 ${used[m]} 行）`);
          used[m] = r.line;
        }
      }
      const gap = used.indexOf(null);
      if (gap >= 0) fail(out.at(-1).line, `作息没有覆盖 24 小时（${String(Math.floor(gap / 60)).padStart(2, '0')}:${String(gap % 60).padStart(2, '0')} 没安排）`);
    }
    for (const r of out) delete r.line;
    return out;
  },
  secrets: ls => ls.filter(bullet).map(l => {
    const [text, st, note] = unbullet(l.text).split('｜').map(x => x?.trim());
    const stage = st ? keyVal(st)[1] : '挚友';
    if (!STAGES.includes(stage)) fail(l.line, `阶段名不认识：${stage}`);
    return { text, stage, note: note || '' };
  }),
  arc: ls => {
    const arc = {};
    for (const l of ls.filter(bullet)) {
      const [k, v] = keyVal(unbullet(l.text));
      if (!STAGES.includes(k)) fail(l.line, `阶段名不认识：${k}`);
      arc[k] = v;
    }
    return arc;
  },
  reminder: ls => {
    const r = ls.filter(bullet).map(l => unbullet(l.text));
    if (r.length > 3) fail(ls.filter(bullet)[3].line, '深度提醒最多 3 条');
    return r;
  },
  forbid: ls => ls.filter(bullet).map(l => unbullet(l.text))
};

const EMPTY = () => ({ canon: [], looks: '', traits: [], wants: '', values: '', voice: { length: '', habits: [], metaphors: [], never: [] }, view: '', knows: '', examples: [], moods: [], lore: [], routine: [], secrets: [], arc: {}, reminder: [], forbid: [] });

/** Markdown → { name, meta, text, canon, card: {…sections}, extra: { 节名: 原文 } }. Throws `第 N 行：…`. */
export function parseCardV2(text) {
  const lines = String(text).split(/\r?\n/).map((t, i) => ({ text: t, line: i + 1 }));
  const name = (/^#\s+(.+)$/m.exec(text) || [])[1]?.trim() || '';
  const meta = {};
  const groups = [];
  let cur = null;
  for (const l of lines) {
    if (/^#\s/.test(l.text)) continue;
    const h = /^##\s+(.+)$/.exec(l.text);
    if (h) { cur = { title: h[1].trim(), lines: [], line: l.line }; groups.push(cur); continue; }
    if (!cur) { const [k, v] = keyVal(unbullet(l.text)); if (bullet(l) && k) meta[k] = v; continue; }
    cur.lines.push(l);
  }
  const card = EMPTY();
  const extra = {};
  for (const g of groups) {
    const hit = SECTIONS.find(([, t]) => g.title.startsWith(t));
    if (!hit) { extra[g.title] = plain(g.lines); continue; }
    const [key] = hit;
    card[key] = PARSERS[key] ? PARSERS[key](g.lines) : plain(g.lines);
  }
  if (card.moods.length === 0) card.moods = [{ name: '平常', speech: '', action: '' }];
  return { name, meta, text: String(text).trim(), canon: card.canon, card, extra };
}

/** Old-style card text: 设定 + 说话方式 (one paragraph) + 禁止. Used by the B8 blind comparison as the "1.0 card". */
export function thinCard(parsed) {
  const c = parsed.card, v = c.voice;
  const voice = [v.length, v.habits.length ? `口头习惯：${v.habits.join('；')}` : ''].filter(Boolean).join(' ');
  return [`# ${parsed.name}`, '', '## 设定（作者写的，永远优先）', ...c.canon.map(x => `- ${x}`), '', '## 说话方式', `- ${voice}`, '', '## 禁止', ...c.forbid.map(x => `- ${x}`)].join('\n');
}

/** A 2.0 card has more than the three 1.0 sections. Old cards keep their text verbatim in the system prompt. */
export const isRichCard = c => Boolean(c && (c.traits.length || c.examples.length || c.lore.length || c.moods.length > 1 || c.looks));

export const CARD_SYSTEM_BUDGET = 1400;

/**
 * The fixed, cacheable part of a 2.0 card for the system prompt, in PLAN-2.0 B3 order: identity and canon, looks,
 * traits, wants, values, voice, view of the user, knowledge, forbid, examples. Lore, moods, routine, secrets, arc and
 * reminders are not here: they go into the per-turn context. Depends only on the card text.
 */
export function cardSystemText({ name, meta = {}, card }) {
  const v = card.voice;
  const who = [meta['年龄'] && `${meta['年龄']} 岁`, meta['性别']].filter(Boolean).join('，');
  const out = [`# ${name}${who ? `（${who}）` : ''}`, '', '## 设定（作者写的，永远优先）', ...card.canon.map(x => `- ${x}`)];
  const block = (title, body) => { if (body && (Array.isArray(body) ? body.length : String(body).trim())) out.push('', `## ${title}`, ...(Array.isArray(body) ? body : [body])); };
  block('外貌', card.looks);
  block('核心性格', card.traits.map(t => `- ${t.name}：${t.how}`));
  block('想要 / 需要', card.wants);
  block('价值观与底线', card.values);
  block('说话方式', [v.length && `- 句长：${v.length}`, v.habits.length && `- 口头习惯：${v.habits.join('；')}`, v.metaphors.length && `- 比喻库：${v.metaphors.join('；')}`, v.never.length && `- 绝不说：${v.never.join('、')}`].filter(Boolean));
  block('对用户的初始看法', card.view);
  block('知识边界', card.knows);
  block('禁止', card.forbid.map(x => `- ${x}`));
  block('示例对话（语气参考，不要照抄）', card.examples.map(e => `<${e.occasion}> 用户：${e.user} ${e.speaker}：${e.reply}`));
  return out.join('\n');
}
