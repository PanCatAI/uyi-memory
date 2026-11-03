# 世界规则契约（3.0 F）

营地自己会转：天气、营地的量、意外。全部由宿主写，确定性（同一存档同一时刻 → 同样的结果），不调模型。
只在存档的 `features.world` 开着时生效；关着时场景和 2.0 一个字不差（`lab.scene()` 不带 `rules`）。
意外另要 `features.director`。数据文件放在场景旁边：`scenes/<场景 id>.<kind>.json`。

## 文件

| 文件 | 内容 | 谁读 |
|---|---|---|
| `scenes/camp.rules.json` | 量的初值、天气表、动作规则、送礼、用户操作 | `lib/rules.mjs`、`lib/climate.mjs`、`lib/worldsim.mjs`、仲裁器 |
| `scenes/camp.incidents.json` | 意外表 | `lib/director.mjs` |
| `scenes/camp.topics.json` | 话头表（G1） | `lib/memory/topics.mjs` |
| `scenes/camp.scout.json` | 探路发现（G2） | `lib/scout.mjs` |
| `scenes/camp.practices.json` | 共同活动（G3） | `lib/practices.mjs` |

`world_words`（任一文件里可选）：「世界相关率」指标认的词（`lib/fun.mjs`）。

## 随机

唯一的随机来源是 `lib/rand.mjs` 的 `rand01(saveId, ...keys)`：FNV-1a 再过 murmur3 收尾，返回 [0,1)。
键：天气 `('weather', 日期)`、下雪 `('snow', 日期)`、午后 `('pm', 日期)`、天象 `('sign', 日期)`、
意外 `(意外 id, 世界小时序号)`、找吃的 `('forage', 日期)`。不许用 `Math.random` 或真实时间。

## 世界日和时间

- 世界日 05:00 换日（02:00 还算前一天）。第 1 天 = 存档第一条事件那天。
- `lib/worldsim.mjs` 的 `advance()` 从水位（`watermarks` 表，`character_id='host'`，`job='world'`，`seq` 存世界时间 ms）
  走到现在，逐个整点执行，事件时间 = max(整点, 上一条事件时间)。
- 离开回来（`session.start`）：同样逐小时走，她的作息补完插在对应时间之间。超过 72 小时的部分只做每天 05:00、
  18:00、19:00 的量变化（天气、雪线、阿砾、晚饭），不发意外、不灭火。

## 事件（`contracts/events.mjs`）

| 类型 | payload | 说明 |
|---|---|---|
| `weather` | `kind, day, temp_hi?, temp_lo?, wind?` | 每天 05:00 后第一次推进写一次（2.0 事件，多三个可选字段） |
| `weather_change` | `kind, from, cause?` | 14:00 的午后转变；`cause` 有值 = 调试/剧本强制，当天不再被午后转变改回 |
| `sky_sign` | `sign, day` | 17:00 后，看明天上午的天气掷出来；感知者 = 在户外的角色 |
| `var_changed` | `var, from, to, cause` | 量变了；`cause` 是中文（「晚饭」「岚拾柴」「下雨了，柴没盖」） |
| `incident` | `incident, phase, sev, by?, how?, lasting?, deadline?, news?` | `phase`：`start` / `resolved` / `expired`；`by`：`char` / `user` / `together` / `host` |
| `practice` | `practice, phase, step?, outcome?` | G3 |
| `bet` | `phase, about, her_pick, user_pick, stake, winner?` | G4 |
| `user_action` | `action: cover_wood` / `help {incident}` / `scout {dir, finds}` | 上帝面板 |

世界状态（`lib/world.mjs` 折叠）多了：`vars`（量）、`weather`（今天写下的天气：`day, am, kind, temp_hi, temp_lo, wind, since, forced`）、
`sign`、`incidents`（进行中的：`id, seq, t, sev, target, deadline`）、`incidentStarts`（每种最近一次开始的时间）、`practice`。

## 条件（`lib/rules.mjs` 的 `match(cond, ctx)`）

`cond` 是对象，所有键都满足才算满足；**具体程度 = 键的个数**。不认识的键一律不满足。

| 键 | 例子 | 含义 |
|---|---|---|
| `weather_in` | `["小雨","大雨"]` | 现在的天气 |
| `yesterday_weather_in` | `["大雨"]` | 昨天上午或下午的天气（意外表用） |
| `sky_in` | `["夜里"]` | 天色：清晨 / 白天 / 黄昏 / 夜里 |
| `hour_between` | `["21:00","05:00"]` | 世界时间在 [起, 止) 里，可跨午夜 |
| `day_gte` | `3` | 第几天 |
| `temp_lte` / `temp_gte` | `2` | 现在的气温 |
| `var` | `{"food": {"lte": 2}, "wood_covered": false}` | 量：直接值 = 相等（布尔值时缺省算 false）；或 `eq/ne/gte/lte/gt/lt`；值写 `"$名字"` 是另一个量，`"$now"` 是现在 |
| `var_future` | `"crate_secure_until"` | 这个量是个时间，而且还没到 |
| `object` | `{"cup": {"holder": null}}` | 物件字段（先看 `state` 里的，再看物件本身） |
| `stage_gte` | `"熟悉"` | 关系阶段不低于 |
| `user_present` | `true` | 会话开着、用户和她在同一片区域 |
| `char_outdoors` | `true` | 她不在帐篷里 |
| `incident_active` / `incident_not_active` | `"tent_rope"` | 意外正在进行 |
| `incident_recent_h` | `{"id":"wolf_howl","h":1}` | h 小时内开始过 |
| `has_untold` | `"hunter_news"` | 她经历了、还没跟用户讲过的（G1） |
| `sign_today` | `["晚霞"]` | 今天傍晚的天象 |
| `practice_active` | `null` / `"watch"` | 正在进行的共同活动 |
| `commitment_due_today` | `"守夜"` | 今天到期、文本含这个词的 open 约定 |
| `user_scouted_today` | `true` | 今天用户去探过路 |
| `bet_resolved_today` | `true` | 今天有赌局分了输赢 |
| `not` | `{ … }` | 里面的条件不满足 |

`ctx` 由 `lab.rules.context(saveId, charId, { t })` 一次算好。

## 量（`rules.vars`）

`wood`（柴，捆，上限 `wood_max`）、`wood_wet`、`wood_covered`、`food`（口粮，天，最低 0）、`snowline`（雪线，米，
`snowline_range` 内）、`snowline_seen`（她最后一次看到的雪线）、`pass_open`、`pass_height`、`tent_secure`、`tent_down`、
`ali_eta_days`（阿砾第几天回来，相对第 1 天）、`lan_tired`（0 起）、`crate_secure_until`（时间）、`forage_day`（日期）、`clues`、`map`。
`hidden_vars` 里的量她不知道，不进上下文（雪线只通过 `snowline_seen` 进）。

随时间（`worldsim`）：05:00 天气、按前一天上午的天气调雪线（到 `pass_height` 时 `pass_open`）、在帐篷里睡了一夜 `lan_tired −1`、
帐篷塌着 `+1`；14:00 午后转变；17:00 天象；18:00 阿砾到期 `food +10`、`ali_eta_days +10`；19:00 晚饭 `food −1`；
每小时：火没人管 3 小时灭（小雨 `light_rain_fire_hours`）、湿柴在雨停后 6 小时（火点着）/ 12 小时（没火）晾干。
天气变成 `rain` 里的一种且柴没盖 → `wood_wet`；变成大雨时火点着 → `fire_out`。

## 动作规则（`rules.actions`）

```json
"gather_wood": { "spec": { "desc": "…", "target": "none" }, "requires": [{ "in": "path", "reason": "得先走到南侧小路" }], "effects": { "add": { "wood": 3 } }, "cause": "拾柴" }
```

- `spec`：场景里没有这个动作时，`features.world` 开着就加进动作表（模型和仲裁器都用）。
- `target`：只能对这个物件做。
- `requires`：`{ var, eq/ne/gte/lte/gt/lt, reason }`、`{ in: 区域, reason }`、`{ once_per_day: 量名, reason }`。
  不满足时仲裁器拒绝，原因就是 `reason`，结果带 `rule: true`；作息遇到这种拒绝只跳过这一步，不放弃整段。
- `effects`：`set`、`add`、`until_days`（量 = 现在 + N 天）、`chance { p, add, miss }`（`rand01` 决定；没中时只写 `once_per_day` 的量，cause 带上 `miss`）、
  `fire_out`（物件 id）、`object { 物件: { 字段: 值 } }`（字段可写 `state.x`、`pos.1`）。
  动作写进账本后，宿主紧接着写对应的 `var_changed`，cause = 角色名 + `cause`。
- `gifts`：用户送这个东西时的 `effects`。`user_actions`：上帝面板上的用户操作（「盖柴」）。

## 意外（`incidents.json`）

| 字段 | 说明 |
|---|---|
| `id, name, sev(1–3), text, memory` | `text` 是账本里的中文说法；`memory: true` 的会进观察和日记 |
| `when` | 条件（上面的键） |
| `p` | 每次检查的概率 |
| `check` | `hourly` / `daily@HH:MM`（那个整点检查） / `on_weather`（天气刚变时检查，不占预算、不受间隔限制） |
| `cooldown_days` | 上次开始后多少天内不再开始（999 = 只发一次） |
| `target` | 意外关于哪个物件（可选） |
| `effects` | 开始时的改动（同动作规则） |
| `resolve` | `[{ by: char/user/either, action, target? }]`：匹配的动作一写进账本就解决 |
| `resolve_when` | 条件满足就由 `host` 解决（湿柴晾干） |
| `auto_resolve_h` | 多少小时后由 `host` 解决 |
| `on_resolve` / `on_expire` | 解决 / 过期时的改动 |
| `deadline_h` | 期限；到了还没解决 → `expired` |
| `auto_fix` | `{ action, target, after_h }`：开始 `after_h` 小时后她自己去做（仲裁器同意才做）。她在睡觉时只有 `sev ≥ 2` 的会叫醒她，叫醒记 `lan_tired +1` |
| `news` | `{ 阶段: 一句话 }`：按她的关系阶段取最高一档里还没说过的那句写进 payload |

没有 `resolve` / `deadline_h` / `resolve_when` / `auto_resolve_h` 的意外是一下子的事（狼嚎、流星）：只写 `start`，不算「进行中」。

用户「搭把手」（`user_action help {incident}`）：她能做 `auto_fix` 的话马上一起做，算 `together`；做不了就等她 30 分钟内做，
过了 30 分钟还没做、而 `resolve` 里有 `help` 的，算用户解决。

## 导演节奏（`features.pace`）

| 档位 | 每世界日严重度点数 | 最短间隔 | 严重度 3 之后休息（不发 sev ≥ 2） | 2 天没出事 |
|---|---|---|---|---|
| 平静 | 2 | 6 小时 | 36 小时 | p ×1.5 |
| 起伏 | 4 | 3 小时 | 24 小时 | p ×2 |
| 热闹 | 6 | 1 小时 | 12 小时 | p ×2 |

预算、间隔、休息只算非 `on_weather` 的意外。`features.director_random === false`（剧本）时只发 `p = 1` 的。
每次检查的结果写 `director_log(save_id, t, incident, decision, reason)`，`decision`：`start / budget / gap / rest / roll / auto_fix / debug`
（条件不满足、冷却中的不记，免得每小时一行）。

## 话头（`topics.json`，G1）

`{ id, when, direction, cooldown_turns, once_per_session?, once?, priority? }`。每轮从条件满足、不在冷却里的话头中挑**得分最高**的一条：
得分 = `when` 的键数 + `priority`（缺省 0；大事和一次性的话头给 1–3，免得被泛泛的天象话头盖过）。并列时用 `rand01(save, 'topic', …)` 挑。
回复的 `used` 里有 `topic:<id>` 才算说了（`turns.topic` 记下）：冷却 `cooldown_turns` 个用户回合；`once_per_session` 这次会话不再出现；
`once` 这个存档不再出现。`custom` 键的名字：`snow_up`、`snow_down`（今天看到的雪线比上次高 / 低）、`map_clue`（1 小时内画上了线索）、
`nuts_ready`（松子在她手里或在篝火边）。

## 探路（`scout.json`，G2）

`{ at, second_chance, blocked: { 方向: { 条件…, reason } }, finds: [{ id, dir, text, li, kind, keywords, when?, once? }] }`。
会话关着时预约（`vars.scout_plan = { dir, day }`），到那天 `at` 宿主掷 1 个发现、`second_chance` 的概率再掷 1 个，写
`user_action scout { dir, finds }`，`perceivers: []`。`text` 只给用户看。她用 `mark_map`（`args: { note, sure, find? }`）画：
发现按 `find` 或 `note` 里的关键词认；`sure: true` 要这次会话用户说过这个发现的某个关键词，否则拒绝（可以 `sure: false` 打问号）。
`kind: clue` 的第一次确定画上时 `clues +1`。

## 一起做的事（`practices.json`，G3）

- 三件：认星 `stars`（晴夜）、守夜 `watch`（夜里，今天有含「守夜」的约定到期）、烤松子 `nuts`（火点着，松子在她手里或火边）。
- 回复的 `practice` 字段（`{start}` / `{step_done}` / `{end}`）由宿主按 `start_when` 和当前步骤的 `done_when` 检查：`user_said_any` 由宿主在回复前看用户这句；`model` 看她的 `step_done`；`action` 看这一轮做成的动作。不合规的记 `turns.rejected_json.practice`。
- 上下文 `practice` 节（在 `topic` 之后）：进行中写「第几步、这一步想做什么」；没在进行时列出现在能开始的。
- 做完：`practice` end 事件、`end_effects`（守夜 `lan_tired +1` 并兑现守夜约定；烤松子没烤糊 `food +1`，用掉松子）、一条 priority 1 的观察「……（一起做的）」、关系里 `together +1`（和送礼一起算 `gifts_received`）。
- 超过 `max_turns` 个用户轮次没做完，或会话结束 → `abandon`，不留记忆。
- 守夜进行中，`night_boost` 里的意外（狼嚎、流星）概率 ×3（导演日志里能看到）。

## 打赌（G4，`lib/bets.mjs`）

- 回复的 `bet` 字段：`{about: 明天天气 | 雪线, her_pick, user_pick, stake}`。天气押 7 种之一（「下雨」= 小雨或大雨，「晴天」= 晴，「起风」= 大风），雪线押上 / 下；两边不能押一样；同时只有一个没分输赢的赌；一天一个。
- 下一个 05:00（早晨天气和雪线写完之后）分输赢：`bet` resolved，winner 是角色 id / `user` / `draw`（都没中）。她输了 → 她的 open 约定（赌注，当天 18:00 到期）。
- 没分输赢时，`now` 节有一行「你们打了个赌……」。

## 剧本里的世界（G5，`lib/scenarios.mjs`）

- 存档开了 world：建档时世界就开始走（不等第一次会话），所以第一天 17:00 的天象会有。
- 连着两次 `advance`：第二次写 time_skip 之前，先把第一次跳过的钟点（世界和她的作息）走完，事件各在各的钟点。
- 步骤：`force_weather {when: 现在 | "第N天 HH:MM", kind}`（以后的早晨记在 `vars.weather_overrides`，那天全天都是这个）、`force_incident {id, at}`（以后的记在 `vars.incident_schedule`，到点由导演开始，`director_random: false` 也照样）、`scout {dir, finds?}`（预约下一个 09:00，给了 finds 就不掷骰）。
- 时间「第N天 HH:MM」是日历时间：第 2 天 03:00 是第 2 天日期的凌晨（05:00 早晨之前）。
- 断言：`incident {id, phase?, by?}`、`var {name, equals | gte | lte …}`、`topic_in_context id | {any} | {prefix}`、`practice {id, phase}`、`bet {phase, winner?}`、`map_has {find, sure?}`、`context_contains_any [..]`、`session_voice {tic_max, no_nagging, give_rate_min}`（最近一次会话的回复：口头禅次数、没有连着三句「打听」、intent 是 分享 / 提议 / 逗 / 安慰 的比例）。
- 她被半夜叫起来（10 小时内 `lan_tired` 涨过）的那夜，05:00 不算睡了整夜，不减累。
