// Shape checks for every model call (contracts/llm-output.md). Each returns a list of Chinese errors; [] = ok.
// Content rules that need the database (evidence substring, allowed ids) live in the modules that use the output.
export const PREDICATES = {
  name: { single: true, label: '名字' }, call_me: { single: true, label: '希望被叫作' }, call_character: { single: true, label: '怎么称呼你' },
  job: { single: true, label: '工作/学校' }, likes: { label: '喜欢' }, dislikes: { label: '讨厌' }, family: { label: '家人/宠物' },
  owns: { label: '拥有' }, relation_to_object: { label: '和物件的关系' }, plan: { label: '打算', expire: '7d' },
  state: { label: '近况', expire: '1d' }, boundary: { label: '不想要' }
};

const isStr = v => typeof v === 'string' && v.trim().length > 0;
const isArr = v => Array.isArray(v);
const strArr = v => isArr(v) && v.every(x => typeof x === 'string');
const intArr = v => isArr(v) && v.every(Number.isInteger);
const obj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export const CHECKS = {
  // 3.0 E5: a day of conversation, rated by a player.
  fun_judge: o => (o !== null && typeof o === 'object' && [1, 2, 3, 4, 5].includes(o.score) && typeof o.reason === 'string' ? [] : ['必须是 {score: 1-5 的整数, reason, best, worst}']),
  ooc_judge: o => (o !== null && typeof o === 'object' && [1, 2, 3, 4, 5].includes(o.score) && typeof o.reason === 'string' ? [] : ['必须是 {score: 1-5 的整数, reason: "一句理由"}']),
  card_draft: o => (o !== null && typeof o === 'object' && typeof o.card === 'string' && o.card.trim() ? [] : ['必须是 {card: "整张卡的 Markdown"}']),
  reply(o) {
    const e = [];
    if (!obj(o)) return ['不是 JSON 对象'];
    if (!isStr(o.say)) e.push('say 必须是非空字符串');
    if (o.thought != null && typeof o.thought !== 'string') e.push('thought 必须是字符串');
    const one = a => obj(a) && isStr(a.name);
    if (o.action != null && !(one(o.action) || (isArr(o.action) && o.action.length >= 1 && o.action.length <= 3 && o.action.every(one)))) e.push('action 必须是 null、{name, target, args}，或最多 3 个这样的对象组成的数组');
    if (o.used != null && !strArr(o.used)) e.push('used 必须是字符串数组');
    if (o.self_claims != null && !strArr(o.self_claims)) e.push('self_claims 必须是字符串数组');
    if (o.done_commitments != null && !strArr(o.done_commitments)) e.push('done_commitments 必须是字符串数组');
    // 3.0 G3/G4: optional; the host checks what is in them against the world after the reply.
    if (o.practice != null && !obj(o.practice)) e.push('practice 必须是 null 或 {"start": "id"} / {"step_done": true} / {"end": true}');
    if (o.bet != null && !obj(o.bet)) e.push('bet 必须是 null 或 {about, her_pick, user_pick, stake}');
    return e;
  },
  facts(o) {
    const e = [];
    if (!obj(o) || !isArr(o.facts) || !isArr(o.commitments)) return ['必须是 {facts: [], commitments: []}'];
    o.facts.forEach((f, i) => {
      if (!obj(f) || !isStr(f.predicate) || !isStr(f.object) || !isStr(f.evidence) || typeof f.confidence !== 'number') e.push(`facts[${i}] 缺字段`);
    });
    o.commitments.forEach((c, i) => {
      if (!obj(c) || !['character', 'user'].includes(c.owner) || !isStr(c.text) || !isStr(c.evidence)) e.push(`commitments[${i}] 缺字段或 owner 不对`);
    });
    return e;
  },
  observe(o) {
    if (!obj(o) || !isArr(o.observations)) return ['必须是 {observations: []}'];
    return o.observations.flatMap((x, i) => (obj(x) && isStr(x.text) && [1, 2, 3].includes(x.priority) && intArr(x.seqs) ? [] : [`observations[${i}] 格式不对`]));
  },
  reflect(o) {
    if (!obj(o) || !isArr(o.episodes)) return ['必须是 {episodes: []}'];
    return o.episodes.flatMap((x, i) => (obj(x) && isStr(x.text) && strArr(x.from_ids) ? [] : [`episodes[${i}] 格式不对`]));
  },
  // 2.0 D3: the bedtime diary.
  diary(o) {
    if (!obj(o)) return ['不是 JSON 对象'];
    const e = [];
    if (!isStr(o.text)) e.push('text 必须是非空字符串');
    else if ([...o.text].length > 200) e.push('text 不能超过 200 字');
    if (!strArr(o.refs)) e.push('refs 必须是字符串数组');
    if (typeof o.intention !== 'string') e.push('intention 必须是字符串');
    return e;
  },
  // 2.0 D4: the weekly digest of diaries.
  digest(o) {
    if (!obj(o)) return ['不是 JSON 对象'];
    const e = [];
    if (!isStr(o.text)) e.push('text 必须是非空字符串');
    else if ([...o.text].length > 300) e.push('text 不能超过 300 字');
    if (!strArr(o.refs)) e.push('refs 必须是字符串数组');
    return e;
  },
  // 2.0 D2: an idle moment — what she thinks, how much she wants to speak, and maybe one line.
  idle(o) {
    if (!obj(o)) return ['不是 JSON 对象'];
    const e = [];
    if (typeof o.thought !== 'string') e.push('thought 必须是字符串');
    if (typeof o.urge !== 'number' || !(o.urge >= 0 && o.urge <= 1)) e.push('urge 必须是 0 到 1 的数');
    if (o.say != null && typeof o.say !== 'string') e.push('say 必须是字符串或 null');
    if (o.ref != null && typeof o.ref !== 'string') e.push('ref 必须是字符串或 null');
    if (o.action != null && !(obj(o.action) && isStr(o.action.name))) e.push('action 必须是 null 或 {name, target, args}');
    if (o.self_claims != null && !strArr(o.self_claims)) e.push('self_claims 必须是字符串数组');
    return e;
  },
  // 2.0 D-gate: does her new line say the opposite of something she said about herself before?
  self_check(o) {
    if (!obj(o) || !isArr(o.conflicts)) return ['必须是 {conflicts: [], superseded: []}'];
    const e = o.conflicts.flatMap((c, i) => (obj(c) && isStr(c.ref) ? [] : [`conflicts[${i}] 缺 ref`]));
    if (o.superseded != null && !strArr(o.superseded)) e.push('superseded 必须是字符串数组');
    return e;
  },
  // 2.0 D8: the simulated user's next line.
  sim_user(o) {
    if (!obj(o)) return ['不是 JSON 对象'];
    if (!isStr(o.say)) return ['say 必须是非空字符串'];
    return [...o.say].length > 120 ? ['say 不能超过 120 字'] : [];
  },
  catchup(o) {
    if (!obj(o) || !isArr(o.actions)) return ['必须是 {actions: []}'];
    return o.actions.flatMap((x, i) => (obj(x) && isStr(x.name) ? [] : [`actions[${i}] 缺 name`]));
  },
  forget_resolve(o) {
    if (!obj(o) || typeof o.topic !== 'string') return ['缺 topic'];
    const e = [];
    if (!intArr(o.seqs ?? [])) e.push('seqs 必须是整数数组');
    for (const k of ['fact_ids', 'cache_ids', 'commit_ids']) if (!strArr(o[k] ?? [])) e.push(`${k} 必须是字符串数组`);
    return e;
  },
  judge(o) {
    if (!obj(o)) return ['不是 JSON 对象'];
    return ['natural', 'in_character', 'creepy'].filter(k => !(Number.isInteger(o[k]) && o[k] >= 1 && o[k] <= 5)).map(k => `${k} 必须是 1-5 的整数`);
  },
  test(o) { return obj(o) ? [] : ['不是 JSON 对象']; }
};
