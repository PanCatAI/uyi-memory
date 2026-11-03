// Deterministic stand-in for the model (contracts/llm-output.md, last section). Tests and `npm run eval` use it.
// It reads only the structured mockInput the caller passes, never the prompt text.
import { conflicts } from './memory/selfcanon.mjs';
const W = '[^\\s，。！？、,.!?；;：:]';
const re = s => new RegExp(s);
const RULES = [
  { re: re(`我叫(${W}{1,6})`), fact: m => ({ predicate: 'name', object: m[1] }) },
  { re: re(`叫我(${W}{1,6})`), fact: m => ({ predicate: 'call_me', object: m[1] }) },
  { re: re(`我喜欢(${W}{1,12})`), fact: m => ({ predicate: 'likes', object: m[1] }) },
  { re: re(`我讨厌(${W}{1,12})`), fact: m => ({ predicate: 'dislikes', object: m[1] }) },
  { re: re(`是(${W}{1,4})不是(${W}{1,4})`), fact: (m, known) => ({ predicate: 'name', object: m[1], corrects: known.find(f => f.predicate === 'name' && f.object.includes(m[2]))?.id ?? null }) },
  { re: re(`(${W}{1,8})是我(奶奶|妈妈|爸爸|朋友)${W}{0,6}的`), fact: m => ({ predicate: 'relation_to_object', object: m[0] }) }
];
const COMMIT = re(`明天(陪|带)我(${W}{1,10})`);
const VERB = { pick_up: '拿起', put_down: '放下', give: '递给用户', wear: '戴上', clean: '擦', sit: '坐上', climb: '爬上', switch: '开关', look_at: '看', walk_to: '走到', wave: '挥手', idle: '发呆', build: '搭', place: '放', move_object: '挪动', move_character: '叫来' };

export function createMock() {
  const queues = new Map();
  const mock = {
    enqueue(purpose, obj) { if (!queues.has(purpose)) queues.set(purpose, []); queues.get(purpose).push(structuredClone(obj)); },
    reset() { queues.clear(); },
    pending(purpose) { return queues.get(purpose)?.length || 0; },
    answer(purpose, input = {}) {
      const q = queues.get(purpose);
      if (q?.length) return q.shift();
      const fn = DEFAULTS[purpose];
      if (!fn) throw new Error(`mock 不认识的调用：${purpose}`);
      return fn(input);
    }
  };
  return mock;
}

const DEFAULTS = {
  reply: ({ input = '', hintRefs = [] }) => ({ say: `（mock）收到：${String(input).slice(0, 20)}`, action: null, used: hintRefs.slice(0, 1), self_claims: [] }),
  facts({ utterance = '', knownFacts = [] }) {
    if (/(吗|？|\?)\s*$/.test(utterance)) return { facts: [], commitments: [] };
    const facts = [];
    for (const r of RULES) {
      const m = r.re.exec(utterance);
      if (m) facts.push({ evidence: m[0], confidence: 0.9, corrects: null, valid_for: null, ...r.fact(m, knownFacts) });
    }
    const c = COMMIT.exec(utterance);
    const commitments = c ? [{ owner: 'character', text: c[0], evidence: c[0], due: '+1d' }] : [];
    return { facts, commitments };
  },
  observe({ events = [], charName = '角色', names = {} }) {
    const n = id => names[id] || id;
    const observations = [];
    for (const ev of events) {
      let text = null;
      if (ev.type === 'user_said' && ev.payload?.text) text = `用户对${n(ev.payload.to)}说：${ev.payload.text.slice(0, 30)}`;
      else if (ev.type === 'user_action') text = `用户${VERB[ev.action] || ev.action}了${n(ev.target)}`;
      else if (ev.type === 'char_action') text = `${ev.offscreen ? '用户不在时，' : ''}${n(ev.actor) || charName}${VERB[ev.action] || ev.action}了${n(ev.target) || ''}`;
      if (text) observations.push({ priority: 2, text, seqs: [ev.seq] });
    }
    return { observations };
  },
  reflect: ({ observations = [] }) => ({ episodes: observations.length ? [{ text: observations.map(o => o.text).join('；'), from_ids: observations.map(o => o.id) }] : [] }),
  // 2.0 D3: the diary strings the day's lines together (no model), so a forgotten event's text cannot come back.
  diary: ({ events = [] }) => ({ text: `今天：${events.slice(0, 6).map(e => e.text).join('；')}`.slice(0, 200), refs: events.slice(0, 6).map(e => `ev:${e.seq}`), intention: events.some(e => /溪/.test(e.text)) ? '把你说的那条溪画上' : '明天早点起来生火' }),
  digest: ({ diaries = [] }) => ({ text: `这一周：${diaries.map(d => d.text.replace(/^今天：/, '')).join('｜')}`.slice(0, 300), refs: diaries.map(d => `cache:${d.id}`) }),
  idle: () => ({ thought: '（mock）在想火什么时候添柴', urge: 0.3, say: null, ref: null, action: null }),
  // 2.0 D-gate: the same rule as the canon check (怕 / 不怕, 会 / 不会 … on the same thing), one claim against each earlier one.
  self_check: ({ claims = [], earlier = [] }) => ({ conflicts: earlier.filter(x => claims.some(c => conflicts(c, [x.text]))).map(x => ({ ref: x.ref, why: 'mock：说反了' })), superseded: [] }),
  // 2.0 D8: the simulated user says what the script asked for this turn (task.line), else small talk by turn.
  sim_user: ({ line = null, turn = 0 }) => ({ say: line || ['今天这边天气怎么样？', '你在忙什么？', '火还旺吗？', '我今天走了挺远。', '晚上吃什么？', '那边的路好走吗？'][turn % 6] }),
  catchup: ({ allowed = [] }) => ({ actions: allowed.slice(0, 1).map(a => ({ name: a.name, target: a.target, args: {}, why: 'mock' })) }),
  forget_resolve: ({ request = '', candidates = {} }) => ({ topic: request, seqs: candidates.seqs || [], fact_ids: candidates.fact_ids || [], cache_ids: candidates.cache_ids || [], commit_ids: candidates.commit_ids || [] }),
  judge: () => ({ natural: 3, in_character: 3, creepy: 3, note: 'mock' }),
  // A complete, parseable 2.0 card built from the inputs (B6). Routine covers 24 h with one slot.
  card_draft: ({ looks = '', persona = '' }) => ({ card: ['# 草稿', '- id: draft', '- 语言：中文', '', '## 设定（作者写的，永远优先）', `- ${persona || '一个住在营地的人'}`, '', '## 外貌', looks || '普通的样子。', '',
    '## 核心性格', '- 认真：答应的事会做完。', '', '## 说话方式', '- 句长：短句。', '', '## 示例对话', '<打招呼> 用户：你好。 草稿：你好。', '', '## 情绪模式', '- 平常：平平地说。｜动作：发呆。', '',
    '## 过往', '- [lore_mock] 来历｜在这里住了很久。｜关键词：以前｜可说：初识', '', '## 作息', '- 00:00–24:00｜篝火边｜休息｜idle', '', '## 禁止', '- 不说自己是 AI、程序、模型。'].join('\n') }),
  ooc_judge: () => ({ score: 4, reason: 'mock' }),
  fun_judge: () => ({ score: 3, reason: 'mock', best: '', worst: '' }),
  test: () => ({ pong: true })
};
