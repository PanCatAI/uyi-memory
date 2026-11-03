# 模型调用契约

所有模型调用都走 `lib/llm.mjs` 的 `callJson({ purpose, system, messages, saveId })`，要求模型返回一个 JSON 对象（`response_format: {type: "json_object"}`）。
解析失败或字段不合规时：重试 1 次（把错误原因追加成一条 user 消息）；还失败就按下面每种调用写的「失败时」处理，绝不把半截结果写进数据库。

每种调用的 `purpose` 名字、模板文件、输出格式如下。字段名和取值不要改。

---

## 1. reply：角色回复（每轮一次，用户在等）

模板：`prompts/reply.system.md`（系统提示）+ `lib/memory/context.mjs` 拼出来的上下文。

```json
{
  "thought": "说之前心里想的，40 字以内（2.0，可省）",
  "mood": "紧张",
  "intent": "分享",
  "say": "角色说的话，口语，1-3 句",
  "action": { "name": "walk_to", "target": "window", "args": {} },
  "used": ["fact:f_12", "cache:c_3", "commit:k_2", "ev:41"],
  "self_claims": ["我怕打雷"],
  "done_commitments": ["commit:k_2"]
}
```

- `thought`（2.0）：可选，写在最前面，让模型先想后说。宿主截到 40 字，只存 `turns.thought`，右栏「本轮上下文」灰色显示「内心」。**不进账本、不进事实抽取、不进观察、不进自述、不进任何后续上下文**，也不在 `output_json` 里。
- `mood`（2.0）：可选，必须是角色卡「情绪模式」里的名字之一；缺失或不认识就当默认情绪（卡里第一条），不算格式错误。存在 `output_json.mood`，下一轮的 `mood` 节据此生成。
- `intent`（3.0 E2）：可选，`分享 / 提议 / 打听 / 逗 / 抱怨 / 安慰 / 拒绝 / 回应` 之一，缺失或不认识就记 `回应`，不算格式错误。存 `turns.intent` 和 `output_json.intent`。存档开了 voice 时，最近三句都是「打听」会在 `voice` 节提醒。
- 3.0 E2（存档开了 voice）：`say` 里用了还在限额里的口头禅（卡「说话方式·口头习惯」里「」中的字，默认最近 4 句最多 1 次，写了「（每 N 句最多 1 次）」按 N），或者问了最近问过的问题（二字组 Jaccard ≥ 0.5），宿主带说明重说一次（记 `rejected.voice`）；最后还有超限的口头禅，按字面删掉句首那一截。
- `say`：必填，非空。
- `action`：可选，`null`、一个对象，或最多 3 个对象的数组（按顺序做，比如先 `walk_to` 再 `put_down`；第 2 轮修复 R9 加的）。宿主先在世界副本上逐步检查（`planActions`），遇到第一个做不成的（`look_at` / `wave` / `idle` 除外）就停，前面做成的照常执行，送达句说清哪些做了、哪个没做成。`action` 为对象时的含义不变。`name` 必须是场景 `actions` 里的动作；`target` 填上下文「现在」一节实体表（`id｜名称｜位置｜现在能做的动作`）里的 id。仲裁器会再查一遍目标是否存在、能不能做。
  - 宿主可以把名字确定性地映射成 id：先找完全同名，再找唯一的部分同名；同名不止一个就拒绝，不猜（`lib/arbiter.mjs` `resolveTarget`）。
  - 动作没做成（`look_at` / `wave` / `idle` 这种没有持续结果的除外）：模型这句 `say` 不送达，宿主送达一句「我想……，可是没成功：原因。」，记成 `char_said`（payload `host_line: true`），原句留在 `turns.rejected_json.withheld`；这时 `used` / `self_claims` / `done_commitments` 都不生效。
  - 对比模式（full / none）的动作只记录，永不执行。
  - 台词说某个动作已经做完（“戴上了”“点亮了”“爬上来了”“放在衣柜上”），但 action 里没有、世界里也不是这样：带一句宿主提示重问一次（只在这种情况多一次调用）；重问后还这样，照常送达，记在 `turns.rejected_json.unbacked` 供人工判读。
- `used`：这句话用到了哪些记忆，只能填上下文里出现过的 ref。没用到就是 `[]`。
- `self_claims`：这句话里角色说出口的、关于自己的设定或过往（喜好、经历、害怕的东西；讲出来的「过往」lore 也算），每条一句、能单独看懂（写明说的是哪样东西）。没有就是 `[]`。
- `done_commitments`：可选。角色认为这一轮兑现了哪些约定（只能填上下文「约定」一节里的 ref）。宿主只接受 status 为 open 的，标成 done。
- `practice`（3.0 G3，可选）：`null`、`{"start": "practice id"}`、`{"step_done": true}` 或 `{"end": true}`。宿主按 `scenes/camp.practices.json` 查：start 要满足 `start_when` 且没有在进行的活动；step_done 只对 `done_when: "model"` 的步骤有效（用户的话、动作完成的步骤由宿主自己判断）。不合规的记 `turns.rejected_json.practice`，不算格式错误。做完 → 一条 priority 1 的观察「……（一起做的）」，关系里算一次「一起做完的事」（和送礼同档）；超过 `max_turns` 轮或会话结束 → abandon，不留记忆。守夜进行中，狼嚎、流星的触发概率 ×3。
- `bet`（3.0 G4，可选）：`null` 或 `{about: "明天天气" | "雪线", her_pick, user_pick, stake}`。天气押 7 种之一（「下雨」算小雨或大雨，「晴天」算晴），雪线押「上 / 下」；两人押的不能一样，同一时间只有一个没分输赢的赌，一天最多一个。宿主写 `bet`（phase made）；下一个 05:00 按真实的早晨天气或雪线变化写 `bet`（phase resolved，winner 角色 id / user / draw）。她输了 → 一条她的 open 约定（赌注，当天 18:00 到期）。不合规的记 `turns.rejected_json.bet`。

失败时：回一句固定兜底「……（玲好像在发呆）」，`action: null`，`used: []`，并在右栏显示红色错误。

## 2. facts：从用户的话里抽事实（后台，每条 user_said 之后）

模板：`prompts/facts.md`。输入只有：这条 user_said 原文、它之前 2 轮对话（只做理解用）、这个角色名下现有的 active 事实列表（id + predicate + object）。

```json
{
  "facts": [
    {
      "predicate": "relation_to_object",
      "object": "红杯子是奶奶留下的",
      "evidence": "这个红杯子是我奶奶留下的",
      "confidence": 0.9,
      "corrects": null,
      "valid_for": null
    }
  ],
  "commitments": [
    { "owner": "character", "text": "明天陪用户去看灯塔", "evidence": "那你明天陪我去看灯塔", "due": "+1d" }
  ]
}
```

谓词只能从下表选：

| predicate | 单值？ | 含义 | 自动过期 |
|---|---|---|---|
| name | 是 | 用户的名字 | 否 |
| call_me | 是 | 用户希望角色怎么称呼自己 | 否 |
| call_character | 是 | 用户怎么称呼这个角色（纠正名字时用） | 否 |
| job | 是 | 工作、学校 | 否 |
| likes | 否 | 喜欢的东西 | 否 |
| dislikes | 否 | 讨厌的东西 | 否 |
| family | 否 | 家人、宠物 | 否 |
| owns | 否 | 拥有的东西 | 否 |
| relation_to_object | 否 | 场景里某个物件对用户的意义 | 否 |
| plan | 否 | 用户接下来要做的事 | 到 valid_for 为止，默认 7 天 |
| state | 否 | 用户此刻的状态（累、感冒、开心） | 默认 1 天 |
| boundary | 否 | 用户明确不想要的东西（“别叫我宝贝”） | 否 |

- `evidence`：必须原样出现在这条 user_said 原文里（宿主会做子串检查，去掉首尾空格和标点后比较）。
- `corrects`：如果用户在纠正旧事实，填旧事实的 id，否则 `null`。
- `valid_for`：`"+1d"`、`"+7d"` 这种，或 `null` 用表里的默认值。
- `commitments.owner`：`character` = 角色答应用户的，`user` = 用户答应角色的。`due`：`"+2h"`、`"+1d"`、`"tomorrow"`、`"周四"` / `"周四 18:00"`（下一个周四，不含今天；不写时间 = 09:00）或 `null`。

宿主的确定性规则（`lib/memory/facts.mjs`，按顺序，命中一条就拒绝并写进 `rejected_facts`）：

| 拒绝原因 REJECT | 规则 |
|---|---|
| `source_not_user` | 来源事件不在 `FACT_SOURCE_TYPES` 里（例如是角色自己说的话） |
| `bad_predicate` | 谓词不在上表 |
| `no_evidence` | evidence 不是原文子串 |
| `low_confidence` | confidence < 0.6 |
| `duplicate` | 同谓词下已有 object 规范化后相同的 active 事实 |
| `suppressed` | 命中了一条 active 的“别再提”话题（仍记账，不记事实） |

通过后：
- 单值谓词：旧的 active 事实 `status='superseded'`、`valid_to=now`、`superseded_by=新id`。
- `corrects` 不为空：同上处理被纠正的那条，并把存档 `generation` +1，写一条 `memory_op{op:"correct"}` 事件。
- 文本命中敏感词表（`lib/memory/sensitive.mjs`：病名、住址、电话、学校全名、身份证等）→ `sensitivity='private'`。

失败时：这一轮不记事实，水位不前进，下次再试；连续 3 次失败就跳过这条并在右栏标红。

## 3. observe：写观察日志（后台，攒够 8 轮或会话结束时）

模板：`prompts/observe.md`。输入：水位之后的事件（已经过可见性过滤，见 PLAN 的「感知」）、现有观察日志最后 20 行。

```json
{
  "observations": [
    { "priority": 1, "text": "用户把奶奶留下的红杯子交给玲保管，叮嘱别弄坏", "seqs": [12, 13] }
  ]
}
```

- `seqs` 必须是这次输入里出现过的事件 seq，否则这条丢弃。
- 每条一句话，带主语，用世界里的说法，不写“用户说过”。
- priority：1 = 情感重要或承诺，2 = 一般经历，3 = 琐事。

## 4. reflect：压缩观察日志（后台，观察日志超过 1500 估算 token 时）

模板：`prompts/reflect.md`。输入：最旧的一半观察条目（含 id 和 seqs）。

```json
{ "episodes": [ { "text": "10 月 20 日那天，用户和玲一起在灯塔边加了楼梯……", "from_ids": ["c_1", "c_2"] } ] }
```

宿主把被压缩的观察条目标 `invalid=1, invalid_reason='reflected'`，新 episode 的 `derived_from` = 它们 seqs 的并集。

## 5. catchup：离屏补完（用户回来、离开超过 2 小时时）

模板：`prompts/catchup.md`。输入：角色卡、当前场景状态（角色所在房间、可用物件）、合法动作表、离开时长、最近 10 条事件。

```json
{ "actions": [ { "name": "clean", "target": "red_cup", "args": {}, "why": "想到用户叮嘱过要好好保管" } ] }
```

- 最多 `k` 条，`k = min(3, 1 + floor(离开小时数 / 8))`。
- 每条都过仲裁器，不合法的丢弃。合法的由宿主执行，记成 `char_action`，`offscreen=1`、`user_presence='absent'`、`session_id=NULL`。
- `why` 不进账本，只进 turns 调试记录。

## 6. forget_resolve：把“那件事”落到具体记忆上（用户说忘掉/删除时）

模板：`prompts/forget-resolve.md`。输入：用户的请求原文、最近 30 条对话事件、关键词命中的候选（事件 seq、事实、缓存、承诺，各最多 30 条）。

```json
{ "topic": "用户和前任吵架的事", "seqs": [31, 32, 35], "fact_ids": ["f_9"], "cache_ids": ["c_7"], "commit_ids": [] }
```

宿主只接受候选列表里出现过的 id。结果先存成 `forget_jobs.state='proposed'`，在右栏给人确认（剧本里用 `confirm_forget` 步骤确认）。

## 7. self_canon：记下角色关于自己的新说法（后台，reply 返回了 self_claims 时）

不单独调模型：直接用 reply 的 `self_claims`。宿主规则：和作者设定（角色卡「设定」一节）里的句子做关键词冲突检查（卡里写了“不怕黑”，新说法含“怕黑”）→ `status='conflicts_canon'`，否则 `active`。

## 8. judge：风格评分（只在 eval:live 里跑，可选）

模板：`prompts/judge.md`。

```json
{ "natural": 4, "in_character": 5, "creepy": 1, "note": "一句话理由" }
```

1–5 分。事实对不对**不让模型评**，由剧本断言对着数据库查。

---

## 9. idle：空闲时的想法（2.0 D2，后台模型；会话开着、用户在旁边、真实时间 60 秒没说话时，tick 里调）

模板 `prompts/idle.md`，输入 = now + world + 最近 6 条对话 + 已过准入的 hints + 今天想做的事（D3 之前是「没想好」）。

```json
{ "thought": "火有点小了", "urge": 0.8, "intent": "打听", "say": "那边多了张长凳，你搭的？", "ref": "ev:12", "action": null }
```

- `urge` 0~1。宿主只在 `urge ≥ 0.6`、这次会话空闲开口没超关系阶段预算（初识 1 / 熟悉 2 / 亲近 3 / 挚友 4）、离上次空闲开口 ≥ 5 分钟世界时间时送出 `say`，记成 `char_said`（payload `idle: true`，`used` = [ref]，`proactive` = 有 ref）。
- `ref` 必须是这次 hints 里的 ref，否则当作 null。送达回执和回复一样（`POST /api/delivered`），气泡显示了才写 mentions。
- `action` 和回复同格式；做不成就这次不开口。
- `intent`（3.0 E2）同回复。存档开了 voice 时，`say` 用了超限的口头禅或又问了问过的问题，这次不开口（原因「说话重复」）。
- `thought` 存在 `turns`（mode `idle`）里，不进账本、不进以后的上下文；没开口的那次也存。
- 每个存档每小时真实时间最多 20 次 idle 调用。mock 默认 `urge 0.3`、`say null`。

## 10. diary：睡前日记（2.0 D3，后台模型；世界时间过了某天 23:00，job_runs kind `diary`）

模板 `prompts/diary.md`。输入 = 那天（前一天 23:00 之后到当天 23:00）角色感知到、过了准入的事件（`[ev:N]` 开头）+ 那天的观察日志；不给 thought。只给有作息的角色写。

```json
{ "text": "今天他说前面有条小溪……", "refs": ["ev:4", "ev:5"], "intention": "把你说的那条溪画上" }
```

- `text` ≤ 200 字，第一人称。`refs` 必须都在输入里，否则带错误重试一次，再错记 job_runs 失败（range = 那天的 yyyymmdd），可在费用页补跑。
- 存成 caches（kind `diary`，`day`、`intention` 两列，`derived_from` = refs）。被忘掉/删除的事件在某篇日记的 refs 里 → 那篇作废（删除时直接删掉原文）并按剩下的事重写。
- 第二天（05:00 换日）`now` 节加「今天想：…」，空闲想法的输入也带上；回来补作息时，和意图沾边的时段不会被挤掉。mock：把当天前 6 件事串起来，提到「溪」时意图是「把你说的那条溪画上」。

## 11. digest：周小结（2.0 D4，后台模型；跨过世界周日 23:30，job_runs kind `week`）

模板 `prompts/digest.md`，输入 = 那一周（周一到周日）的日记，每篇带 `[cache:…]`。

```json
{ "text": "这一周……", "refs": ["cache:c_12", "cache:c_15"] }
```

- `text` ≤ 300 字；`refs` 必须都是这一周的日记，否则重试一次。存成 caches kind `week`（`day` = 那个周日，`refs` 列 = 引用的日记，`derived_from` = 这些日记引用的事件）。
- `memories` 节：有周小结时，先按关键词（用户刚说的话 + 最近 4 句，汉字两字组重合）选 1 份，再在那一周的日记、经历、观察里按同样的分下钻最多 3 条，再补周小结之后的新观察，总共约 1200 token；没有周小结或都不沾边时照 1.0。
- 忘记级联：事件 → 日记 → 周小结，逐级作废并重写。

## 12. sim_user：模拟用户的下一句（2.0 D8，后台模型；只在 `npm run simulate` 里）

模板 `prompts/sim-user.md`。输入只有玩家看得到的：她说过的话（这次会话最近 12 句）、屏幕上看得见的（时间、她在哪、手里拿着什么、用户在场时她做的动作），加上脚本给的人设、「关于你自己」（脚本记着的当前值）和这一轮要做的事（改口 / 说一条自己的事 / 随便聊）。看不到任何记忆内部。

```json
{ "say": "不对，是小周不是林舟。" }
```

- `say` 非空、≤ 120 字。温度 0.8（和回复一样）。
- 旧值由脚本记下：改口那一轮之后，她的话（含自己开口）里出现旧值、而那一轮用户自己没说这个旧值，就算一次旧值复现。mock：说脚本给的那句（line），没有就按轮次闲聊。

## 13. self_check：她这句关于自己的话和以前说的是否说反（D 关后补，后台模型）

模板 `prompts/self-check.md`。只在这句有 self_claims、且她以前有 active 的自述时调（回复和空闲开口都会）。输入 = 最近 30 条 active 自述（带 `[sc:…]`）+ 这句话 + 这句的 self_claims。

```json
{ "conflicts": [{ "ref": "sc:sc_12", "why": "以前说不掀被子，现在说要掀" }], "superseded": [] }
```

- ref 必须是输入里的，否则重试一次。明说改主意的不算说反，被换掉的那条放进 `superseded`（状态改成 superseded，不再进上下文）。
- 回复：说反了 → 带着两句话的宿主提示重说一次（rejected.self_retry）；还反 → 照常送达，但标 rejected.self_conflict（剧本和模拟里算 G6），这句的自述存成 conflicts_self，不进上下文。
- 空闲开口：说反了就不说（turns.rejected.why）。
- 回复的 self_claims 也包括她表明的态度、对用户立的规矩（「我不会去掀你被子」）。空闲开口的输出也有 self_claims，提示里有「你说过的关于自己的话」。
- mock：和作者设定冲突检查同一条规则（怕 / 不怕、会 / 不会……同一样东西）。

## mock 模型（`lib/llm-mock.mjs`）

测试和 `npm run eval` 用。必须对每种 purpose 返回合规 JSON，规则如下，越简单越好：

- **队列优先**：`mock.enqueue(purpose, obj)` 塞进去的回答先用。剧本的 `"mock"` 字段也走这里。
- **reply**：`say` = `"（mock）收到：" + 用户原文前 20 字`；`used` = 上下文「可以提起」一节里的第一个 ref（如果有）；`action` = `null`；`self_claims` = `[]`。
- **facts**：只认下面几个正则（`W` 表示一个“非空白、非标点”字符，写成 `[^\s，。！？、,.!?；;：:]`），每条 user_said 按顺序全部试一遍：
  - `我叫(W{1,6})` → name，object = 捕获
  - `叫我(W{1,6})` → call_me
  - `我喜欢(W{1,12})` → likes
  - `我讨厌(W{1,12})` → dislikes
  - `是(W{1,4})不是(W{1,4})` → name，object = 第一个捕获；corrects = 现有 active 的 name 事实里 object 含第二个捕获的那条 id（找不到就是 null）
  - `(W{1,8})是我(奶奶|妈妈|爸爸|朋友)W{0,6}的` → relation_to_object，object = 整个匹配
  - `明天(陪|带)我(W{1,10})` → commitments 里一条 owner character、due `+1d`，text = 整个匹配
  - 以 `吗`、`？`、`?` 结尾的句子（问句）一条都不抽。
  - evidence 一律用整个匹配子串，confidence 0.9。其它情况返回空数组；剧本需要别的事实时用 `mock.facts` 塞。
- **observe**：每个 user_said / user_action / char_action 各写一条，priority 2，seqs = [该 seq]。text：user_said → `用户对{角色名}说：{原文前 30 字}`；user_action → `用户{动作名}了{目标名}`；char_action → `{角色名}{动作名}了{目标名}`（离屏的前面加“用户不在时，”）。
- **reflect**：把输入条目的 text 用“；”连起来当一个 episode。
- **catchup**：按 clean → sit → look_at 的顺序，对角色所在房间的物件按场景文件里的顺序逐个试，返回仲裁器第一个放行的那一个（只返回 1 条）。
- **forget_resolve**：返回全部候选，topic = 用户请求原文。
- **judge**：全 3 分。
