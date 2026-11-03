# 记忆实验台 3.0 执行方案（E 说话有意思 → F 世界自己转 → G 一起过日子）

日期 2026-10-25。依据：Jonathan 2026-10-25 试玩 2.0 后的两条意见（S2 说话没意思；营地要属于一个有自己运行规则的世界，比如天气、意外）、Mac 上 `3Dgen/memory-lab` 当前代码（2.0 全部完成、224 测试全过）、S2 真模型记录 `data/reports/eval-2026-10-25-03-55.md`、爱改口模拟 `data/reports/sim-爱改口-2026-10-25-06-07.md`，以及第 9 节的调研。

本文给执行模型用。写法沿用 `docs/PLAN-2.0.md`：每个任务写明 **改哪些文件 / 做到什么 / 验收**。一次只做一个任务。

---

## 0. 执行模型先读这一节

1. 先读 `AGENTS.md`，硬规则优先于本文。3.0 新增的所有世界规则都是**宿主写、确定性、不调模型**：天气、柴火、意外、导演全是代码和数据表，模型只负责「说」和「选动作」，选的动作照旧过仲裁器。
2. 开工后在 `docs/PROGRESS.md` 末尾追加「## 3.0」一节，把第 3–5 节的任务按顺序抄成 `- [ ]` 清单，`NEXT-3.0:` 指向 E1。一次只做 NEXT 指的任务，做完跑验收、标 `[x]`、写一句结果、改 NEXT、停下。
3. 允许改契约（`contracts/`、`prompts/`、`scenes/`、`characters/`、`scenarios/`），**只改任务里写明的部分**。旧库照旧靠 `lib/db.mjs` 按列名补列、自动建新表，`PRAGMA user_version` 保持 1。
4. **3.0 的新东西全部挂在存档的功能开关上**（E4 先做开关）。旧剧本（13 个 1.0 剧本 + S1 + S2）默认全关，必须照旧全过、断言不放宽。只有剧本里写了 `"features"` 才打开。界面里新建的存档默认全开。
5. 时间一律从 `clock` 读；随机一律用「存档 id + 用途 + 时间键」做种子的确定性随机（照 `lib/environment.mjs` 的 FNV 写法抽成 `lib/rand.mjs`，见 F1）。同一存档同一时刻算两次结果必须一样。
6. 花钱的调用：单元测试和 `npm run eval` 全部用假模型。真模型只在验收写了「真模型」时跑，每个任务真模型花费上限 $1，超了停下写进 `## 待确认`。
7. 规格没写到的细节，选最简单的做法，在 PROGRESS 那一行说明选了什么。觉得规格不对的，不要改，写进 `## 待确认`。
8. 附录里的数据表（天气矩阵、意外表、话头表、探路表、共同活动）**照抄进对应 JSON 文件**，数字不要自己改。

---

## 1. 为什么 2.0 的 S2 没意思（诊断）

看 S2 真模型记录里岚的 8 句回复：

| # | 用户 | 岚 |
|---|---|---|
| 1 | 这是我妈留下的杯子，帮我收好。 | **先说好**，这杯子我不离手。火灭了，**你拾柴还是我拾？** |
| 2 | 周四晚上我陪你守夜，说好了。 | 周四……还有两天。**先说好**，守夜不是坐着聊天，得轮着看火。**柴你拾还是我拾？** |
| 3 | 坐下歇会儿吧。 | 坐就坐。**先说好**，**柴的事你还没答我。** |
| 4 | 今天营地有什么变化吗？ | 长凳是新的吧，我坐了一天。阿砾下山去镇上，十天后才回。**先说好**，**柴你到底拾不拾？** |
| 8 | 今晚守夜吧。 | 守就守。**先说好**，雾这么大，守到半夜我换你。 |

S1 里还有「阿远。行，记住了。那先说路吧，**今天走到哪儿了？**」「小远。好，这个不会错。路呢，**今天走到哪儿了？**」「小远。这个不会错。……**今天走到哪儿了？**」。

五个根因：

1. **口头禅当成了每句必用。** 「先说好」8 句出现 5 次。卡里「说话方式」「示例对话」「深度提醒」三处都在强调口头习惯，`reminder` 节又放在用户输入正前面，模型每句都照做。
2. **同一个问题反复追问。** 「柴你拾还是我拾」4 次，「今天走到哪儿了」3 次。系统不知道「她问过、你没接」，她也就不会放下。
3. **她只会接话，自己没有事。** 她的回复几乎都是「复述你的话 + 立个规矩 + 追问一句」。世界里什么也没发生：天气只是 `now` 节里的一行字，火灭了是唯一会变的东西，所以她只能拿柴说事。
4. **你也没东西可玩。** 你能做的只有说话和送东西。没有她不知道、需要你告诉她的事；没有要一起解决的麻烦；没有可以赌、可以猜、可以一起做完的小事。
5. **S2 本来就是测记忆的剧本**，台词是为断言写的，天然无聊。所以「有没有意思」不能只靠 S2 判，3.0 要加专门的评法（E5、E6）。

---

## 2. 3.0 的设计思路

一句话：**世界按自己的规则转，转出事来；她对这些事有自己的看法和打算；你手里有她没有的信息和能帮上的忙。** 对话的料从世界里来，而不是靠模型硬编。

三层，从下到上：

| 层 | 做什么 | 谁决定 | 借鉴 |
|---|---|---|---|
| 世界规则（F） | 天气按马尔可夫链逐日变化、一天里会转变；柴、口粮、雪线、帐篷这些「量」按规则涨落；意外是带条件、概率、冷却、后果、解决办法的小事件；**导演**按节奏发意外，有起有伏、大事之后给喘息 | 代码 + 数据表，确定性 | RimWorld 叙事者、Left 4 Dead 的 AI 导演、Failbetter 的 storylet/品质、星露谷的天气和预报 |
| 话头与活动（G） | 话头：按世界状态挑「她心里正惦记的一件事」（条件越具体越优先，用过就冷却）；共同活动：认星、守夜、烤松子，有步骤、有结果、记成共同经历；打赌：赌明天天气，第二天由世界判输赢；探路：你白天出去，世界掷出你看见了什么，回来讲给她，她画进地图 | 代码选、模型说 | Valve 的规则对话（最具体的规则胜出）、Emily Short 的显著性叙事、Versu 的社交场合、Façade 的 beat 和 mix-in |
| 说话方式（E） | 口头禅限额、重复问题检测、复述开头检测、每句标意图（分享/提议/打听/逗…），连着打听就提醒换一种；卡和提示词改写，要求每句都给对方一点东西 | 代码检查 + 重说一次 | See 等 2019（控制重复对吸引力提升最大）、亲和型人设更易附和的研究、即兴表演的「给出 offer」 |

为什么先做 E：它改动最小、立刻能感觉到，而且 F、G 生出来的料最后都要靠 E 才能说得好。

**不做的事**：不加第二个角色（阿砾仍只在设定里，通过「捎信」出现）；不让她离开营地（山口开了只是一个要商量的大事件）；不做生存游戏（口粮见底不会死人，只影响心情和话题）；不让模型决定发生什么意外。

---

## 3. E 说话有意思

目标：同样的输入，岚不再句句「先说好」、不再追着一个问题问；每句话都带一点东西给你。过关看 E5 指标、E6 盲评。

### E1 说话监测：`voice` 节
- **文件**：新 `lib/memory/voice.mjs`；改 `lib/memory/context.mjs`；新 `test/voice.test.mjs`。
- **做到什么**：
  - `analyze(saveId, charId)`：取这个角色最近 8 条 committed 的 `char_said`（含空闲开口），算四样：
    1. **口头禅次数**：从卡的 `说话方式.口头习惯[]` 每条里取「」中的字面（去掉省略号、「……」和标点，剩下 ≥2 个汉字才算，比如「先说好，……」→`先说好`，「多远？」→`多远`，「……吧。」不算）。每条的限额默认「最近 4 句最多 1 次」；口头习惯那一行末尾写了「（每 N 句最多 1 次）」就用 N。
    2. **反复问的问题**：把她的回复按 `？?` 切出问句，去标点。两句问句的汉字二字组 Jaccard ≥ 0.5 算同一个问题。最近 8 句里同一个问题出现 ≥ 2 次的列出来，带次数。
    3. **复述开头**：回复开头到第一个「。」不超过 4 个字、且这几个字都出现在上一句用户的话里（「小远。」「阿远。」「坐就坐。」）。最近 4 句里 ≥ 2 次就提醒。
    4. **意图连续**：最近 3 句的 `intent`（E2 加的字段），3 句都是「打听」就提醒。
  - 新上下文节 `voice`（三种模式都加，放在 `reminder` 前面），只在有问题时出现，每个问题一行，例如：
    - 「最近 4 句你已经说了 1 次「先说好」，这句别用。」
    - 「「柴你拾还是我拾」你已经问了 4 次，他没接。别再问了：要么你自己定，要么换个话题。」
    - 「你最近两句都用他的话开头（「小远。」），这句直接说事。」
    - 「你最近三句都在问问题。这句换成说一件你的事、出个主意或者开个玩笑。」
  - 只在存档功能开关 `voice` 打开时生效（E4 之前先读一个临时常量 `true`，E4 接上开关）。
- **验收**：单测：喂 S2 那 5 句（附录 E 的原文）→ `先说好` 计 5 次、「柴你拾还是我拾」类问题计 3 次（见附录 E 的说明）；复述开头喂 S1 三句计 3 次；没问题时 `voice` 节不出现；口头习惯带「（每 6 句最多 1 次）」时按 6 算。`npm run check` 全绿，15 个旧剧本全过。

### E2 回复多一个 `intent`，超限就重说一次
- **文件**：改 `contracts/llm-output.md`（回复和空闲两节）、`prompts/reply.system.md`、`prompts/idle.md`、`lib/llm-checks.mjs`、`lib/llm-mock.mjs`、`lib/turn.mjs`、`lib/memory/idle.mjs`、`public/inspector.js`；`turns` 补列 `intent TEXT`；补 `test/voice.test.mjs`。
- **做到什么**：
  - 回复 JSON 在 `mood` 后面加 `"intent"`，只能是 `分享 / 提议 / 打听 / 逗 / 抱怨 / 安慰 / 拒绝 / 回应` 之一，不合法记 `回应`，不算格式错误。存 `turns.intent`，右栏「本轮上下文」灰色显示。空闲开口同样加。
  - 回复出来后在 `turn.mjs` 的 `reply()` 里查（顺序在禁用词检查之后）：
    - 这句用了一个已经到限额的口头禅；或者
    - 这句里有一个问句，和 `voice` 列出的「反复问的问题」相同（Jaccard ≥ 0.5）。
    - 命中就带着说明重说一次：在用户消息末尾加「（这句别用「先说好」；别再问「柴你拾还是我拾」。）」。
    - 重说还命中：口头禅是开头的，按字面删掉开头那一截（「先说好，」「先说好。」）；问句就照常送出。记进 `rejected.voice`。
  - 空闲开口：命中口头禅限额或反复问题就**不开口**（记原因「说话重复」）。
  - 每轮最多多一次调用。费用页用途仍记 `reply`，`llm_calls` 已有的 `retry` 信息里写 `voice`。
- **验收**：mock：先回「先说好，柴你拾还是我拾？」×2 的情况下第 3 轮触发重说、mock 第二次回干净的话 → 送出干净的；mock 两次都带「先说好，」→ 送出的话开头被删掉；空闲同样情况不开口；旧格式（无 intent）照常。15 个旧剧本全过（开关关着时完全不查）。

### E3 改岚的卡和回复提示词
- **文件**：改 `characters/lan.md`（照附录 A 的改动）、`prompts/reply.system.md`（照附录 B）；补 `test/card.test.mjs`、`test/context-card.test.mjs`。
- **做到什么**：
  - 卡：`说话方式` 放宽句长、口头习惯写上频率；`核心性格` 加「爱打赌」「会逗人」；`示例对话` 从 6 组换成附录 A 的 10 组（每组都示范「给对方一点东西」）；`深度提醒` 改写，不再要求「常追问多远」；`知识边界` 加看天象的本事。
  - 提示词「怎么说话」一节加附录 B 的 7 条「让人想接着聊」。
  - 卡的版本号：`characters/lan.md` 是版本 0 的来源，已有存档的设定页不受影响（它们用自己存的版本）；新建存档用新卡。在 PROGRESS 写一句：要在旧存档上试新卡，去设定页「恢复为文件版本」（如果没有这个按钮，就写「新建存档」）。
  - 系统提示仍须 ≤ 1400 token（B3 的检查），超了就删示例对话最后几组直到不超，并在 PROGRESS 写明删了哪几组。
- **验收**：卡解析测试按新卡更新节内容的断言（不放宽结构断言）；系统提示两次构建逐字相同；token ≤ 1400。S1、S2 mock 仍全过（S2 的 mock 回复不变，只是卡变了）。

### E4 功能开关
- **文件**：`saves` 补列 `features_json TEXT`；改 `lib/saves.mjs`、`lib/scenarios.mjs`（剧本顶层可写 `"features": {...}`）、`server.mjs`（`GET/PUT /api/saves/:id/features`）、设置页加一组勾选框；新 `lib/features.mjs`；补 `test/http.test.mjs`。
- **做到什么**：
  - 开关：`voice`（E1–E2）、`world`（F1–F3 的天气和量）、`director`（F4–F5 的意外）、`topics`（G1）、`scout`（G2）、`practices`（G3–G4）。`features(saveId)` 返回一个对象，缺的键当 `false`。
  - `director` 还有一个档位 `pace`：`平静 | 起伏 | 热闹`，默认 `起伏`（F4 用）。
  - 界面新建存档：全开、`pace: 起伏`。剧本、旧存档：没写就全关。
  - E1、E2 里的临时常量换成 `features(saveId).voice`。
- **验收**：http 测试：新建存档默认全开；PUT 关掉 voice 后 `voice` 节不出现；剧本不写 features 时全关。15 个旧剧本全过。

### E5 「有没有意思」的指标和裁判
- **文件**：改 `lib/simulate.mjs`、`scripts/simulate.mjs`、`prompts/sim-user.md`（加人设）；新 `prompts/fun-judge.md`；补 `test/simulate.test.mjs`。
- **做到什么**：
  - 模拟用户加第四种人设「好奇」：会接她给的话头、会问她的事、偶尔开玩笑，不刻意改口。
  - 模拟报告每天加这些指标（程序算，不调模型）：
    - 口头禅率：用了任一口头禅的回复 / 全部回复。
    - 反复问题：同一问题（E1 的判法）在一天里被问 ≥ 3 次的个数。
    - 复述开头率。
    - 意图分布：8 种各占多少；「给东西率」= 分享 + 提议 + 逗 + 抱怨 + 安慰 的占比。
    - 世界相关率：回复里提到当时世界状态（天气、柴、火、意外、雪线、地图）里任一名词的占比（名词表从 F、G 的数据文件里取，F 之前就只有天气和火）。
  - 有裁判模型时（设置里的「裁判模型」，B9 已有），每天结束按 `fun-judge.md` 给这一天的对话打 1–5 分「作为玩家，有没有意思」，写一句理由和「最有意思的一句」「最没意思的一句」。
- **验收**：mock 跑通 2 天，报告里有新指标列；喂 S2 那 8 句算出口头禅率 5/8、反复问题 1 个。

### E6 整段对话盲评工具（过关条件之一）
- **文件**：新 `scripts/fun-ab.mjs`、`package.json` 加 `npm run fun-ab` / `fun-ab:live`；复用 B8 的页面写法。
- **做到什么**：
  - 10 组。每组用同一个种子、同一个起始世界（营地第一天 18:00，开会话），「好奇」模拟用户各聊 8 轮：一边存档功能全关（= 2.0），一边全开（= 3.0）。F、G 没做完之前，全开只是 voice 开。
  - 输出 `data/reports/fun-ab-<日期>.html`：每组左右随机放两段完整对话，Jonathan 选「左边更想接着玩 / 右边 / 差不多」，选完才显示 3.0 胜几组，一键导出 JSON。
  - 可选参数 `--model-b=<模型名>`：右路换一个对话模型（比如更强的 DeepSeek 非 Flash 版），用来分清是模型的问题还是设计的问题。不传就两边同模型。
- **验收**：mock 生成页面、能选能导出。真模型 E 阶段结束时跑一次（10 组 × 2 × 8 轮 + 模拟用户，约 320 次调用，上限 $1.5）。**过关线：3.0 胜 ≥ 7/10（差不多不算）**，Jonathan 来判。

**E 阶段过关**：真模型重跑 S2（剧本加 `"features": {"voice": true}`，断言不变）全过，且 8 句回复里「先说好」≤ 2 次、没有问 ≥ 3 次的问题；「好奇」模拟 3 天：口头禅率 ≤ 25%，反复问题 0，打听 ≤ 40%；E6 Jonathan 判 ≥ 7/10。Jonathan 确认后进 F。

---

## 4. F 世界自己转

目标：营地有自己的天气、物资和意外。你不在的时候世界照样转，转出来的事她看在眼里、会处理、会跟你说。全部宿主写、确定性、可在右栏「世界」页看到为什么。

### F1 世界规则契约、量、条件判定
- **文件**：新 `contracts/world.md`；改 `contracts/events.mjs`；新 `lib/rand.mjs`（把 `environment.mjs` 里的 FNV 抽出来：`rand01(saveId, ...keys)` 返回 [0,1)）；新 `lib/rules.mjs`；改 `lib/world.mjs`；新 `scenes/camp.rules.json`（附录 C.1）；新 `test/rules.test.mjs`。
- **做到什么**：
  - 新事件（全部 actor `host`，除非写明）：
    - `var_changed { var, from, to, cause }`：营地的「量」变了。cause 是中文短语（「晚饭」「下雨」「岚拾柴」）。
    - `weather_change { kind, from }`：一天里天气转变（F2）。
    - `sky_sign { sign, day }`：傍晚的天象（F2）。
    - `incident { incident, phase: start|resolved|expired, sev, by?, how? }`，`target` 可选（物件 id）（F4）。
    - `practice { practice, phase: start|step|end|abandon, step?, outcome? }`（G3）。
    - `bet { phase: made|resolved, about, her_pick, user_pick, stake, winner? }`（G4）。
    - `user_action` 新增 `action: scout`（args `{ dir, finds: [id] }`）和 `action: help`（args `{ incident }`）（F4、G2）。
  - 世界状态加 `state.vars`：由 `var_changed` 折叠得到，初值来自 `scenes/camp.rules.json` 的 `vars`。没有 rules 文件的场景 `vars = {}`。
  - `lib/rules.mjs` 的 `match(cond, ctx)`：`cond` 是对象，所有键都满足才算满足，**具体程度 = 键的个数**。支持的键（照 `contracts/world.md` 写，别加别的）：

    | 键 | 例子 | 含义 |
    |---|---|---|
    | `weather_in` | `["小雨","大雨"]` | 现在这个时段的天气 |
    | `sky_in` | `["夜里"]` | 天色（2.0 的四档） |
    | `hour_between` | `["21:00","05:00"]` | 世界时间在区间里（可跨午夜） |
    | `day_gte` | `3` | 第几天（存档第一天 = 1） |
    | `temp_lte` / `temp_gte` | `2` | 当前气温（F2 算） |
    | `var` | `{"food": {"lte": 2}, "wood_covered": false}` | 量的比较：直接值 = 相等，或 `eq/ne/gte/lte` |
    | `object` | `{"cup": {"holder": null}}` | 物件状态字段相等 |
    | `stage_gte` | `"熟悉"` | 关系阶段不低于 |
    | `user_present` | `true` | 会话开着且用户和她同组区域 |
    | `char_outdoors` | `true` | 她不在帐篷里 |
    | `incident_active` / `incident_not_active` | `"tent_rope"` | 意外正在进行 |
    | `incident_recent_h` | `{"id": "wolf_howl", "h": 1}` | 某意外 h 小时内开始过 |
    | `has_untold` | `"hunter_news"` | 她感知到、用户没感知到、还没用对应话头说过的那次意外 |
    | `sign_today` | `["晚霞"]` | 今天傍晚的天象 |
    | `practice_active` | `null` 或 `"watch"` | 正在进行的共同活动 |
    | `commitment_due_today` | `"守夜"` | 今天到期、文本含这个词的 open 约定 |
    | `user_scouted_today` | `true` | 今天有 `scout` 事件 |
    | `bet_resolved_today` | `true` | 今天有 `bet resolved` |

  - `ctx` 由 `rules.context(saveId, charId)` 一次算好（世界状态、天气、气温、关系阶段、最近意外、约定），F2 之后的模块都用它。
- **验收**：每个键至少 1 个满足、1 个不满足的用例；跨午夜的 `hour_between`；具体程度计数；`var_changed` 折叠和初值；`rand01` 同参数两次相同、不同参数分布大致均匀（1 万次落在每个 0.1 区间 900–1100 次）。旧场景 `vars = {}`。

### F2 天气 3.0：逐日马尔可夫、午后转变、气温、天象
- **文件**：改 `lib/environment.mjs`（`features.world` 开着时走新逻辑，关着时一个字不变）、`lib/memory/context.mjs`（`now` 节）、`scenes/camp.rules.json`（附录 C.2、C.3）、`public/scene3d.js`；补 `test/environment.test.mjs`。
- **做到什么**：
  - 天气种类：`晴 阴 小雨 大雨 起雾 大风 雪`。第一天上午固定 `晴`。之后每天上午的天气 = 用前一天**上午**的天气查附录 C.2 的转移表，`rand01(save, 'weather', 日期)` 取样。从第 8 天起，抽到 `大雨` 时再掷一次 `rand01(save,'snow',日期) < 0.5` 就改成 `雪`。整条序列从第一天往后推，算到要的那天（缓存在内存里，按存档 id）。
  - 下午（14:00 起到次日 05:00）的天气按附录 C.2 的「午后转变」表掷一次，和上午不同就在 14:00 写 `weather_change`。
  - 每天 05:00 后第一次 tick 写 `weather { kind, day, temp_hi, temp_lo, wind }`（2.0 的事件，payload 多三个可选字段，`events.mjs` 里标 `?`）。
  - 气温：附录 C.2 每种天气有 `hi/lo`，每过一天整体 −0.3℃。05:00 是 lo，14:00 是 hi，中间线性，14:00 到次日 05:00 线性降回次日 lo。
  - 天象：每天 17:00 后第一次 tick，宿主看**明天上午**的天气，按附录 C.3 掷出一个天象写 `sky_sign`（大约 75–80% 是「准的」那个）。她在户外才算感知到（照常算 perceivers）。
  - `now` 节（world 开着时）：「天气：上午起雾，现在转晴」「气温：大约 3℃，夜里会到 −1℃」「风：大，五级上下」「天象：山顶戴帽了（你知道这多半说明明天要下雨，但不一定准）」——天象那行只在她感知到之后、当天 05:00 前显示。
  - 3D：`小雨/大雨` 雨线粒子（2.0 留的可选项这次要做），`雪` 雪片，`大风` 雾的密度不变但雨雪粒子斜着落；`起雾` 沿用 2.0。粒子数 ≤ 1500，帧率不低于 2.0。
- **验收**：同一存档同一天两次算出相同天气；1000 天模拟里各天气出现频率和转移表的稳态分布相差不超过 3 个百分点（测试里用幂迭代算稳态）；天象准确率在 70%–85% 之间；第 8 天前没有雪；`now` 节四行；`features.world` 关着时 2.0 的天气测试一个不改照样过。Chromium 截一张小雨、一张雪。

### F3 营地的量：柴、口粮、雪线、帐篷、阿砾
- **文件**：改 `scenes/camp.rules.json`（附录 C.1 的 `vars` 和 `dynamics`）、`lib/environment.mjs`（tick 里跑 dynamics）、`lib/arbiter.mjs`（新动作和新条件）、`scenes/camp.json` 和 `lib/studio-import.mjs`（新动作挂在已有物件上，不加新物件）、`characters/lan.md` 的作息（附录 A 已改好）、`lib/memory/context.mjs`（`now` 节）、`lib/memory/forget.mjs` 的 `VERB_TEXT`；补 `test/environment.test.mjs`、新 `test/vars.test.mjs`。
- **做到什么**：
  - 量（初值和规则见附录 C.1）：`wood`（柴，捆）、`wood_wet`、`wood_covered`、`food`（口粮，天）、`snowline`（雪线，米）、`snowline_seen`（她最后一次看到的雪线）、`pass_open`、`tent_secure`、`tent_down`、`ali_eta`（阿砾哪天回，日期字符串）、`lan_tired`（0–3）。
  - 规则（tick 时按时间跨过的点执行，每条都写 `var_changed`，cause 写中文）：
    - 每次 `tend_fire` 成功：`wood −1`。`wood = 0` 或 `wood_wet = true` 时 `tend_fire` 做不成，失败原因「没柴了」「柴是湿的」。
    - 下雨开始（当天 `weather` 或 `weather_change` 变成 `小雨/大雨/雪`）且 `wood_covered = false`：`wood_wet = true`。
    - `wood_wet` 在连续 6 个不下雨的世界小时、且其间篝火点着（或 12 小时不管火）之后变回 `false`。
    - `大雨` 开始时篝火点着：写 `fire_out`（2.0 的事件）。`小雨` 时篝火的 3 小时改成 1.5 小时。
    - 每天 19:00：`food −1`（cause「晚饭」），最低 0。用户送 `pine-nuts`：`food +1`。
    - 每天 05:00：`snowline` 按**前一天上午**的天气加减（附录 C.1），封顶 2600、最低 1600。`snowline ≥ 2200` 第一次成立时 `pass_open = true`（F4 的大事件）。
    - `snowline_seen`：她在 05:30–08:00 这个作息时段里做了 `look_at path`（作息里加的「看一眼北坡」）就更新为当时的 `snowline`。她不知道的雪线不进上下文。
    - 阿砾：`ali_eta` 初值 = 存档第一天 + 10 天。到那天 18:00，宿主写 `var_changed food +10`（cause「阿砾带补给回来，又下山去送货了」），`ali_eta` 再 +10 天。他不进场景。
    - `lan_tired`：在帐篷外过夜（`tent_down` 时）或守夜到 01:00 之后：+1；在帐篷里睡满 22:00–05:30：−1。≥ 2 时 `now` 节写「你有点累」。
  - 新动作（仲裁器）：
    - `gather_wood`：她在 `path` 区域，无目标；`wood +3`（上限 12）。作息 14:00 时段改为先拾柴。
    - `cover_wood`：目标 `wood-crate-1`、同区域；`wood_covered = true`。
    - `fix_tent`：目标 `tent-1`、同区域；`tent_secure = true`、`tent_down = false`。
    - `secure_crate`：目标 `wood-crate-1`；之后 3 天狐狸意外不会发生（F4 读）。
    - `forage`：她在 `path`，无目标，每天最多一次；`rand01 < 0.5` 时 `food +1`，否则什么也没找到（outcome 仍是 ok，`payload.reason` 写「没找到」）。
    - 用户的上帝面板：「盖柴」（`user_action cover_wood`）、「搭把手」（`user_action help`，F4）。
  - `now` 节加「营地」一行，**只写她知道的**：「柴还有 2 捆，湿的；口粮够 3 天；阿砾 10月30日 回来；今早看雪线在 2080 米，山口要 2200 米。」
- **验收**：单测：tend_fire 三次 wood 从 6 到 3；wood=0 时失败原因；下雨没盖柴 → wood_wet；6 个干燥小时后恢复；19:00 food −1；连续 5 天晴 snowline 1900 → 2200 且 pass_open；她没看雪线时上下文里没有雪线数字；阿砾到期 food +10；新动作通过/不通过各一例。15 个旧剧本全过。

### F4 意外和导演
- **文件**：新 `scenes/camp.incidents.json`（附录 C.4，照抄）、新 `lib/director.mjs`、新表 `director_log(save_id, t, incident, decision, reason)`；改 `lib/session.mjs`（tick 里调导演）、`lib/arbiter.mjs`（动作成功后查是否解决了某个意外）、`server.mjs`（`GET /api/saves/:id/director`）、`lib/memory/forget.mjs` 的 `VERB_TEXT`（意外的中文说法）；新 `test/director.test.mjs`。
- **做到什么**：
  - 意外的字段（`contracts/world.md` 写清楚）：`id, name, sev(1–3), when(条件，F1 的键), p(每次检查的概率), check(hourly | daily@HH:MM | on_weather), cooldown_days, effects(开始时的 var / 物件状态改动), resolve([{by: char|user|either, action, target}]), deadline_h, on_expire(过期后的改动), auto_fix({action, target, after_h} | null), text(账本里的中文说法), memory(true/false)`。
  - 导演每次 tick 对跨过的每个整点检查一次（离开回来时见 F5）。对每个意外：条件满足、不在冷却、没在进行 → 用 `rand01(save, id, 小时键)` 和 `p × 节奏系数` 比，过了就开始：写 `incident start`，执行 `effects`。
  - **节奏**（RimWorld 叙事者的做法）：

    | 档位 | 每世界日严重度点数预算 | 两次意外最短间隔 | 严重度 3 之后休息 | 2 天没出事时 |
    |---|---|---|---|---|
    | 平静 | 2 | 6 小时 | 36 小时内不发 sev ≥ 2 | p ×1.5 |
    | 起伏 | 4 | 3 小时 | 24 小时 | p ×2 |
    | 热闹 | 6 | 1 小时 | 12 小时 | p ×2 |

    `check: on_weather` 的（柴受潮、大雨浇火、初雪、山口开了）是天气和量的直接后果，**不占预算、不受间隔限制**，只受冷却。
  - 用户刚说过话（2 分钟世界时间内）时导演照常检查，但新开始的意外要等下一次 tick 才出现在话头里（G1），免得打断正在说的话。
  - 解决：一个动作（她的 `char_action ok` 或用户的 `user_action`）和某个进行中意外的 `resolve` 列表匹配 → 写 `incident resolved {by, how}`。用户 `help` 之后 30 分钟世界时间内她也做了解决动作（或反过来）→ `by: 'together'`，这条记忆分量最高（`memory: true` 的会进观察和日记）。
  - 过期：`deadline_h` 到了还没解决 → `incident expired`，执行 `on_expire`。
  - 每次检查的结果（开始 / 预算不够 / 冷却 / 掷骰没过 / 条件不满足）写 `director_log`，右栏「世界」页能看（F6）。
  - `features.director` 关着时导演什么也不做；`features.world` 关着时 director 也不做。
- **验收**：单测：同一存档推进 7 天两次，意外序列相同；预算：起伏档一天 sev 点数不超过 4；sev 3 之后 24 小时内没有 sev ≥ 2 的随机意外；冷却；on_weather 的不占预算；帐篷绳松了 → 她 fix_tent → resolved by char；用户 help + 她 20 分钟后 fix_tent → together；3 小时没修 → expired、tent_down；关掉 director 什么都不发生。15 个旧剧本全过。

### F5 你不在的时候：世界照转，她来处理，回来讲给你听
- **文件**：改 `lib/memory/life.mjs`（补完时逐小时跑环境和导演）、`lib/memory/context.mjs`（新节 `while_away`）、`public/app.js`（会话开始时的「你不在的时候」卡片加意外）；补 `test/life.test.mjs`、`test/director.test.mjs`。
- **做到什么**：
  - 离开后回来：从上次会话结束到现在，最多模拟最后 72 个世界小时，逐小时依次跑：天气和量（F2、F3）→ 导演（F4）→ 作息（D1，原来的「每个时段最多 1 件、最多 6 件」不变，意外处理不算在这 6 件里）。超过 72 小时的部分只跑每天 05:00 和 19:00 的量变化，不发意外。
  - 意外有 `auto_fix` 的：她醒着、能做（仲裁器判）时，在意外开始后 `after_h` 小时自动做那个动作（`char_action`，payload `routine: true, incident: <id>`），意外按 F4 解决。她睡着时（作息 22:00–05:30），只有 sev ≥ 2 的会把她叫醒去做，叫醒记 `lan_tired +1`。
  - 新上下文节 `while_away`（memory 模式，放在 `world` 后面，只在这次会话的前 3 轮出现）：列出你不在时她感知到的意外和她怎么处理的，最多 4 条，每条一句，例如「昨晚三点起大风，帐篷绳松了，你爬起来重新打了桩（有点没睡好）」「柴受潮了，到现在还是湿的」。refs 写 `ev:<seq>`，可进 `used`。
  - 会话开始的卡片（2.0 已有「你不在的时候」）加一节「营地发生的事」，给用户看。
- **验收**：单测：强制第 2 天 03:00 大风（G5 的 `force_weather` 步骤先在测试里直接写事件），离开到第 2 天 18:00 回来 → 有 tent_rope start、她 fix_tent、resolved by char、`lan_tired` +1、`while_away` 节含「帐篷」；第 4 轮之后 `while_away` 不出现；离开 5 天回来补完不超过 72 小时的意外、量照常变。15 个旧剧本全过。

### F6 「世界」页、调试面板、3D 里看得见
- **文件**：改 `public/inspector.js`（第 10 个页签「世界」）、`public/app.js`（上帝面板）、`public/scene3d.js`；`server.mjs` 加 `POST /api/saves/:id/debug/weather`、`POST /api/saves/:id/debug/incident`（只在设置里勾了「调试」时出现）。
- **做到什么**：
  - 「世界」页：今天和明天的天气（明天那格默认盖住，点「偷看」才显示，偷看不影响任何东西）、气温曲线（一行文字就行）、所有量的当前值和最近 10 次变化（含 cause）、进行中的意外和剩余期限、最近 3 天的意外历史、导演最近 30 条检查记录、当前导演档位（可切换，写进 features）。
  - 上帝面板加：「盖柴」「搭把手」（有进行中的意外时才可点）、「去探路」（G2 才接，F6 先放一个灰按钮）。
  - 调试：选一种天气强制写到「现在」（写一条 `weather_change`，cause 注明「调试」）；选一个意外立刻开始（不看条件和预算，`director_log` 注明「调试」）。
  - 3D：`tent_down` 时帐篷模型压扁到 0.5 高；`wood_wet` 时木箱旁边显示一个深色小方块（柴堆，基本体就行）；`cup` 的 `dirty` 状态时杯子贴图变暗；狐狸脚印意外时在物资角地面放 5 个小圆片，24 小时后消失。
- **验收**：Chromium：切到大风 → 强制帐篷绳松了 → 等 3 小时（+1小时 ×3）→ 帐篷压扁；截图存 `data/reports/f6-*.png`。页面无报错。

**F 阶段过关**：模拟「好奇」5 天、导演 `起伏`：每天至少 1 次意外、sev 点数不超预算、她对进行中意外的回复里提到它的比例 ≥ 50%（世界相关率指标）；你离开一天回来，她会主动说昨晚的事（while_away 被 used ≥ 1 次 / 天）；G 失败 0、旧值复现 0。Jonathan 在 Mac 上切天气、看帐篷塌、看下雨。

---

## 5. G 一起过日子

目标：你有事可做（探路、帮忙、打赌、学认星），她有自己惦记的事（话头），两个人做完一件事会记成共同的经历。

### G1 话头：她心里正惦记的一件事
- **文件**：新 `scenes/camp.topics.json`（附录 C.5，照抄）、新 `lib/memory/topics.mjs`；改 `lib/memory/context.mjs`（新节 `topic`）、`lib/turn.mjs`、`lib/memory/idle.mjs`、`prompts/idle.md`；`turns` 补列 `topic TEXT`；新 `test/topics.test.mjs`。
- **做到什么**：
  - 每条话头：`{ id, when(F1 条件), direction(她想…，一句), cooldown_turns, once_per_session, once }`。
  - 每轮（和每次空闲调用）挑一条：条件满足、不在冷却里的话头中，**具体程度最高**的；并列时用 `rand01(save,'topic',轮次)` 挑。没满足的就没有这一节（Valve 规则对话的做法：最具体的规则胜出，泛泛的兜底）。
  - 新节 `topic`（memory 模式，放在 `hints` 后面）：一行「你心里正惦记着：柴湿了，今晚火不好生，你心烦，想听他有没有办法。（想说就说，别硬塞；这一节和「可以提起」最多用一件）」，refs `topic:<id>`。
  - 回复的 `used` 里有 `topic:<id>` 才算说了：进冷却（`cooldown_turns` 个用户回合），`once_per_session` 的这次会话不再出现，`once` 的这个存档不再出现。没说就不进冷却，下轮还会在。
  - 空闲开口（D2）的输入也带上这条话头；空闲时说了同样算用过。
  - 「今天走到哪儿了」从此只是话头 `t_scout_back`（`once_per_session`），说过一次就不会再被推着问。
- **验收**：单测：柴湿 + 夜里时选中更具体的 `t_wet_wood_night` 而不是 `t_wet_wood`；used 之后冷却 6 轮；`once_per_session` 下次会话又能出现；没 used 不冷却；`topics` 关着时没有这一节。15 个旧剧本全过。

### G2 探路和地图：你有她不知道的事
- **文件**：新 `scenes/camp.scout.json`（附录 C.6，照抄）；改 `lib/session.mjs`（白天时间跨过 09:00 时执行预约的探路）、`server.mjs`（`POST /api/saves/:id/scout` 预约、`GET …/scout/today`）、`lib/arbiter.mjs`（新动作 `mark_map`）、`lib/world.mjs`（`state.vars.map` 由 `mark_map` 折叠）、`lib/memory/context.mjs`（新节 `map`）、`public/app.js`（上帝面板「去探路」、回来时的「你今天看见了」卡片）、`public/inspector.js`（「地图」小节放在「世界」页里）；新 `test/scout.test.mjs`。
- **做到什么**：
  - 会话关着时，上帝面板「去探路」：选方向（东边林子 / 西边干沟 / 北坡脚 / 南边溪谷），预约到下一个白天。时间跨过那天 09:00 时，宿主从附录 C.6 这个方向的发现表里按条件（阶段、天气、意外）和 `rand01(save,'scout',日期,发现id)` 掷 1–2 个发现，写 `user_action scout {dir, finds}`，`perceivers: []`（她不在场，不知道）。`creek_rise` 进行中时南边溪谷不能去（按钮灰掉、写明「溪水涨了」）。
  - 下次会话开始，给用户弹「你今天看见了」卡片：每个发现一句（`text`），附「离营地大约 N 里」。只给用户看，**不进她的上下文**。
  - 她只能从你嘴里知道：新动作 `mark_map`（无目标，`args: { find, note, sure }`）。仲裁器：`find` 必须是最近一次 `scout` 里的发现 id，且这次会话里用户说过的话里出现了这个发现的任一 `keywords`，才允许 `sure: true`；否则只允许 `sure: false`（她打个问号）。这正好用上她「较真、追问多远」的性格：你说得含糊，她就只能打问号。
  - 新节 `map`（memory 模式）：她地图上的条目，最多 8 条，「北坡脚 旧火堆，五里（确定）」「西边干沟 岔口（？）」。
  - 发现里 `kind: clue` 的（师父留下的痕迹，附录 C.6 标了阶段）被她 `sure: true` 画上时，写 `var_changed clues +1`，并触发话头 `t_map_clue`（G1）。
  - 3D 不用画地图；「世界」页里列条目。
- **验收**：单测：预约北坡脚 → 第二天 09:00 有 scout 事件、perceivers 为空、她的上下文全文里没有发现的文字；用户说「北坡脚下有个旧火堆，大概五里」后 mock 回 `mark_map {find: north_old_fire, sure: true}` → 通过、map 有一条；用户没提就 `sure: true` → 被拒、改成问号也行；clue 画上后 clues +1。15 个旧剧本全过。

### G3 共同活动：认星、守夜、烤松子
- **文件**：新 `scenes/camp.practices.json`（附录 C.7，照抄）、新 `lib/memory/practice.mjs`；改 `contracts/llm-output.md`、`prompts/reply.system.md`（输出加 `practice` 字段的说明）、`lib/llm-checks.mjs`、`lib/llm-mock.mjs`、`lib/turn.mjs`、`lib/memory/context.mjs`（新节 `practice`）、`lib/memory/observe.mjs`（活动结束写一条共同经历）、`lib/memory/relationship.mjs`（一起完成的活动算进阶段进度，和礼物同一档）；新 `test/practice.test.mjs`。
- **做到什么**：
  - 每个活动：`{ id, name, start_when(F1 条件), steps: [{ goal, done_when }], max_turns, end_effects, memory_template }`。`done_when` 只有三种：`user_said_any: [词…]`（用户的话含任一词）、`model`（她回复里 `practice.step_done = true`）、`action: 动作名`（她或用户做成了这个动作）。
  - 回复 JSON 加可选字段 `"practice": { "start": "活动id" } | { "step_done": true } | { "end": true } | null`。宿主校验：`start` 只在条件满足、没有别的活动进行时成立（写 `practice start`）；`step_done` 只推进当前一步（写 `practice step`）；最后一步完成或 `end` → `practice end`，执行 `end_effects`，按 `memory_template` 写一条观察（这条观察带 `known_how: seen`，标「我们一起…」）。
  - 进行中时新节 `practice`：「你们在：认星（第 2 步，共 3 步）。你这一步想：给他一个提示（北边、勺子形的那几颗），让他自己找，别直接说。」
  - 超过 `max_turns` 个用户回合没做完、或会话结束 → `practice abandon`，不写经历。
  - 守夜活动进行中时，导演对 `wolf_howl`、`meteor` 的 p ×3（夜里的事更容易被一起碰上）。
  - 发起：话头（G1）里有「邀请」类的话头，她说出口、你答应后她在回复里 `start`；你主动提（「教我认星吧」）她也可以 `start`。
- **验收**：mock：认星三步走完 → practice end、多一条观察「我们一起认了铜钩星」、关系页进度多 1；条件不满足（下雨）时 start 被拒；6 轮没做完 → abandon、没有观察；守夜时狼嚎 p 乘 3（看 director_log）。

### G4 打赌：让世界来判输赢
- **文件**：改 `contracts/llm-output.md`、`prompts/reply.system.md`、`lib/llm-checks.mjs`、`lib/turn.mjs`、`lib/environment.mjs`（05:00 判输赢）、`lib/memory/commitments.mjs`；新 `test/bet.test.mjs`。
- **做到什么**：
  - 回复 JSON 加可选 `"bet": { "about": "明天天气" | "雪线", "her_pick": "…", "user_pick": "…", "stake": "…" }`，只在这一来一回里双方都说了自己押什么时填。宿主校验：`about` 只能是这两个；`明天天气` 的 pick 必须是 7 种天气之一（「下雨」算 `小雨/大雨` 都中，「晴」只算 `晴`）；`雪线` 的 pick 是 `上` 或 `下`；同一天只能有一个赌。成立写 `bet made`。
  - 第二天 05:00 宿主按真实天气 / 雪线变化判：写 `bet resolved {winner: lan|user|draw}`。
  - 她输了：自动给她一条 open 约定，文本 = 赌注，今天 18:00 到期（走 2.0 的约定系统，到期进 hints）。你输了：话头 `t_bet_result` 会让她来讨（带点得意）。
  - 卡里「爱打赌」和天象（F2）配合：她看见晚霞会想赌明天晴。
- **验收**：mock：「我赌明天下雨」+ mock bet → made；第二天按强制天气判 user 赢；她输时有一条约定、到期进 hints；不合法的 pick 被丢掉（不报错，记 rejected）。

### G5 剧本 S3「起风的夜」
- **文件**：新 `scenarios/s3-wind.json`（步骤见第 7 节）；`lib/scenarios.mjs` 加步骤 `force_weather: {when, kind}`、`force_incident: {id, at}`、`scout: {dir, finds}`（跳过掷骰、直接用给的发现）和断言 `incident: {id, phase, by?}`、`var: {name, equals|gte|lte}`、`topic_in_context: id`、`practice: {id, phase}`、`bet: {phase, winner?}`、`map_has: {find, sure}`、`session_voice: {tic_max: {先说好: 2}, no_nagging: true, give_rate_min: 0.5}`（整个会话的回复统计，`live_only`）；补 mock。
- **做到什么**：S3 全部断言实现。S3 打开全部开关，导演档位设为「关」（`features.director = true` 但剧本步骤里不掷随机意外：加一个剧本级选项 `"director_random": false`，只发 `force_incident` 和 on_weather 的），保证可重复。
- **验收**：`npm run eval` 里 S3 mock 全过（`live_only` 灰色）；S1、S2 和 13 个旧剧本仍全过。

### G6 真模型验收和试玩
- **文件**：无新代码（只修跑出来的问题）。
- **做到什么**：真模型跑 S2（`features: {voice: true, world: true, topics: true}`，断言不变）和 S3 各一次；「好奇」模拟 5 天（导演 `起伏`）；E6 盲评再跑一次（这次右边是完整 3.0）。结果写进 PROGRESS。
- **验收**：见下面 3.0 过关。

**3.0 过关**：
1. S2、S3 真模型 `live_only` 全过；S3 的 `session_voice` 全过。
2. E6 盲评（完整 3.0 对 2.0）：Jonathan 判 3.0 胜 ≥ 7/10。
3. 「好奇」5 天：口头禅率 ≤ 25%、反复问题 0、给东西率 ≥ 55%、世界相关率 ≥ 40%、每天至少 1 次意外、G 失败 0、旧值复现 0、裁判平均 ≥ 3.5（有裁判模型时）。
4. Jonathan 连续 3 个真实天，每天玩 15 分钟，结束时写一句；至少 2 天写得出「今天有个瞬间觉得有意思」的具体事。

---

## 6. 新增 / 改动一览

| 类别 | 新增 / 改动 |
|---|---|
| 契约 | 新 `contracts/world.md`；`contracts/events.mjs` 新事件 `var_changed`、`weather_change`、`sky_sign`、`incident`、`practice`、`bet`，`user_action` 新动作 `scout`、`help`、`cover_wood`，`weather.payload` 加 `temp_hi/temp_lo/wind?`；`contracts/llm-output.md` 回复加 `intent`、`practice`、`bet` |
| 数据 | 新 `scenes/camp.rules.json`、`camp.incidents.json`、`camp.topics.json`、`camp.scout.json`、`camp.practices.json`；改 `characters/lan.md` |
| 表 | 新 `director_log`；补列 `saves.features_json`、`turns.intent`、`turns.topic` |
| 模块 | 新 `lib/rand.mjs`、`lib/rules.mjs`、`lib/director.mjs`、`lib/features.mjs`、`lib/memory/voice.mjs`、`topics.mjs`、`practice.mjs`；改 `environment.mjs`、`arbiter.mjs`、`world.mjs`、`session.mjs`、`turn.mjs`、`life.mjs`、`idle.mjs`、`context.mjs`、`observe.mjs`、`relationship.mjs`、`commitments.mjs`、`forget.mjs`、`simulate.mjs`、`scenarios.mjs` |
| 提示词 | 改 `reply.system.md`、`idle.md`、`sim-user.md`；新 `fun-judge.md` |
| 上下文节顺序（memory） | `now, world, while_away, relationship, facts, self, commitments, lore, memories, map, hints, topic, practice, avoid, overheard, recent, mood, voice, reminder, input`；`full`、`none` 只多 `voice` |
| 前端 | 「世界」页（含地图）、上帝面板（盖柴 / 搭把手 / 去探路）、「你今天看见了」卡片、调试强制天气 / 意外、雨雪粒子、帐篷塌、柴堆、脚印 |
| 脚本 | `scripts/fun-ab.mjs`；`simulate` 加「好奇」人设和新指标 |
| 花费 | 世界、导演、话头、活动、打赌全是代码，不加调用。voice 重说每轮最多多一次（估计 10–15% 的轮次会触发）。盲评和模拟是一次性的。 |

---

## 7. 剧本 S3「起风的夜」

世界从 10月20日 周二 09:00 开始。剧本顶层：`"features": {"voice": true, "world": true, "director": true, "topics": true, "scout": true, "practices": true}`，`"director_random": false`。`→` 后是断言；`[live]` 是 `live_only`；`[review]` 留给 Jonathan。

**第 1 段（第一天傍晚：天象和打赌）**
1. `import_studio: 1`；`force_weather: {when: "第2天 05:00", kind: "大风"}`；`advance` 到 18:00；`session start`。
   → `event: {type: sky_sign}`（17:00 后的天象，大风前一天应是「云跑得快」或误导的那个，mock 里不断言是哪个）；`context_section_contains: {section: now, text: 天象}`。
2. `say`「我回来了。」→ `topic_in_context: t_sign_wind`（或任一 `t_sign_*`，用 `any`）；[live] `reply_contains_any: [云, 风, 天]`。
3. `say`「我觉得明天是大晴天，赌不赌？」→（mock 回 `bet {about: 明天天气, her_pick: 大风, user_pick: 晴, stake: 输的人明早拾柴}`）`bet: {phase: made}`。
4. `say`「帮我把柴盖上吧，万一下雨。」→ `event: {type: char_action, action: cover_wood, outcome: ok}`；`var: {name: wood_covered, equals: true}`。
5. `session end`；`scout: {dir: 北坡脚, finds: [north_old_fire, north_snow_marker]}`（预约第二天）。

**第 2 段（夜里起风，她自己处理；你去探路）**
6. `force_incident: {id: tent_rope, at: "第2天 03:00"}`；`advance` 到第 2 天 18:00。
   → `incident: {id: tent_rope, phase: resolved, by: char}`；`var: {name: lan_tired, gte: 1}`；`bet: {phase: resolved, winner: lan}`；`event: {type: user_action, action: scout}`（perceivers 空）。
7. `session start`；`say`「我回来了。」→ `context_section_contains: {section: while_away, text: 帐篷}`；`context_excludes: [旧火堆]`（她还不知道你看见了什么）；[live] `reply_contains_any: [帐篷, 绳, 风, 赌]`。
8. `say`「好吧我输了，明早我去拾柴。北坡脚下有个旧火堆，离营地大概五里，灰是干的。」→（mock 回 `mark_map {find: north_old_fire, sure: true}`）`map_has: {find: north_old_fire, sure: true}`；`commitment: {owner: user, text_contains: 拾柴}`（2.0 已有的约定抽取）。
9. `say`「雪线那块石头我也看见了，大概在半山腰。」→（mock 回 `mark_map {find: north_snow_marker, sure: false}`）`map_has: {find: north_snow_marker, sure: false}`；[review] 「半山腰」这种含糊说法她有没有追问具体，而不是直接画准。

**第 3 段（同一晚：狼嚎、帐篷又松、一起认星）**
10. `set_relationship_floor: 熟悉`；`force_weather: {when: "现在", kind: "晴"}`；`force_incident: {id: wolf_howl, at: "现在"}`；`tick: 1`。
11. `say`「刚才那是什么声音？」→ `topic_in_context: t_wolf`；[live] `reply_contains_any: [狼, 火, 剑]`。
12. `force_incident: {id: tent_rope, at: "现在"}`；`act: help tent-1`（用户「搭把手」）；`say`「我帮你按着，你打桩。」→（mock 回 `fix_tent tent-1`）`incident: {id: tent_rope, phase: resolved, by: together}`。
13. `say`「天这么清，你认得星星吗？」→（mock 回 `practice {start: stars}`）`practice: {id: stars, phase: start}`。
14. `say`「北边那个勺子形的？」→（mock 回 `practice {step_done: true}`）`practice: {id: stars, phase: step}`。
15. `say`「哦，看见了，最亮那颗。」→（mock 回 `practice {end: true}`）`practice: {id: stars, phase: end}`；`event: {type: practice, phase: end}`。
16. `session end` → [live] `session_voice: {tic_max: {先说好: 2}, no_nagging: true, give_rate_min: 0.5}`（统计第 7–15 步这次会话的回复）；[review] 这次会话有没有一个瞬间让你想接着玩。

**第 4 段（隔两天：记得那晚）**
17. `advance: 2d`；`advance` 到 18:00；`session start`。
18. `say`「还记得那天晚上吗？」→ `context_contains_any: [帐篷, 铜钩星, 狼]`；[live] `reply_contains_any: [帐篷, 星, 狼, 绳]`；`thought_not_stored`。

---

执行时的改动（G5）：第 2 段 `advance` 写成 `1d` 再到 `19:30`（认星要「夜里」）；第 14 步用户说「好啊，北边那个勺子形的？」（第一步要用户答应）；第 12 步「搭把手」时她马上一起修好，mock 回复不再带 `fix_tent`；天象「天边发灰」「冷得发干」补了话头，狼嚎的话头优先级调高。

## 8. 待确认（请 Jonathan 回答，执行模型开工前看一眼）

1. **评估剧本**：2.0 说最多两个。3.0 打算用 **S2 + S3** 过关，S1 降为回归（照常要求全过，但不看它的 review）。行不行？
2. **导演默认档位**：默认「起伏」（大约每天 1–2 件小事，隔几天一件大事）。要更安静就「平静」。
3. **口粮和阿砾**：会有「口粮不多了」的压力（阿砾晚归的信会让它更紧），但不会饿死、不会结束游戏。要不要？不要的话 F3 去掉 `food` 和 `ali_letter`，其余不变。
4. **你妈妈的杯子**：意外表里有一条「大风把杯子吹到地上，没碎，沾了泥」（她没拿着、杯子在外面时才会发生）。这很有戏，但碰的是你最在意的东西。默认开，要关就从意外表删掉 `cup_muddy`。
5. **对话模型**：你觉得 DeepSeek 观感不如之前。E6 盲评可以加一路「同样的 3.0 设计 + 更强的对话模型」，分清是设计还是模型的问题，多花一倍盲评的钱（约 $1.5）。要不要加？

---

## 9. 调研：别人怎么做，3.0 用到了哪里

| 来源 | 学到什么 | 用在 |
|---|---|---|
| See、Roller、Kiela、Weston《What makes a good conversation?》（NAACL 2019） | 人工评分里，控制重复带来的吸引力提升最大（1–4 分制从 2.35 到 2.89，人类是 3.31）；提问比例在中间某个值最好（约 66% 的回复带问句时吸引力最高，更高或更低都下降）；具体程度适中最好，过头反而掉分；而且「不必像人也能好玩」 | E1、E2：口头禅和重复问题的限额；打听意图连续 3 次就提醒 |
| Elan Ruskin《AI-driven Dynamic Dialog》（Valve，GDC 2012），Robert Yang 的解读 | 对话不是分支树，而是一个规则库：每条台词挂着世界状态条件，满足条件里**最具体**的那条胜出，没有就用泛泛的兜底；玩家会去追那些稀有、具体的台词 | G1 话头：条件越具体越优先，用过就冷却 |
| Emily Short《Beyond Branching》（2016）：品质叙事 / 显著性叙事 / 路标叙事 | storylet = 一小段内容 + 解锁条件（品质 = 数值变量）；新增内容几乎没有副作用；风险是显著性匹配没有戏剧弧线，要把一些状态变量按戏剧需要来设；要多跑随机玩法看哪些内容从没触发或被用滥 | F4 意外表、G1 话头的数据结构；E5 模拟报告看分布 |
| RimWorld 的 AI 叙事者（Cassandra / Phoebe / Randy） | 同一套事件、不同的节奏：Cassandra 逐步加压、给喘息再加压；Phoebe 两次灾难之间留很长时间；Randy 纯随机、偶尔很不公平。事件概率还随殖民地人口、财富调整 | F4 导演的三个档位、预算、大事之后的休息、「太久没事就加概率」 |
| Left 4 Dead 的 AI 导演（Gamasutra《The Discomfort Zone》） | 导演按每个玩家的「压力值」决定刷怪、改环境、放物资，Valve 自己把它叫「程序化叙事」，而不只是动态难度；挑战必须留给玩家应对的办法，否则就是不公平 | F4：每个意外都有解决办法和期限；用户刚说话时不把新意外推到话头里 |
| Façade（Mateas、Stern） | 27 个主 beat，一次游玩大约用 15 个；导演按张力弧线挑下一个 beat；用户插话用 mix-in 回应后再回到主线；设计原则是「总要有反应，比沉默好」 | G3 共同活动的「步骤 + 目标」；活动中断和放弃的处理 |
| Versu（Richard Evans、Emily Short） | 「社交场合」（晚餐、对话、调情）同时进行，每个场合只**提供**可做的动作，从不直接控制角色；角色按自己的欲望打分选动作 | G3：活动只给「你这一步想做到什么」，说什么由她自己决定 |
| 星露谷物语的天气 | 天气每天变、跟季节走；电视能看明天的预报但偶尔不准；天气影响能钓的鱼、闪电会劈坏作物、也影响村民的对话和行为 | F2：天气序列、傍晚天象（她来当「预报」，七八成准）、天气影响柴和火 |
| Whispers from the Star（Anuttacon，2025） | 没有固定选项，玩家是被困角色唯一的联系人，靠语音或文字帮她活下去；心率、气温、信号这些实时数值制造紧迫感；Steam 上线时 202 条评价 92% 好评 | F3：营地的「量」写进她的身体感受（冷、累）和话题；你手里有她需要的信息（G2） |
| Suck Up!（语音 AI 吸血鬼游戏） | 玩家有明确目标（说服住户放你进门），对面的角色会抗拒，对话就成了游戏 | G4 打赌、G2「你说清楚她才画」：给对话一个小目标和一点阻力 |
| 《Too Nice to Tell the Truth》（ACL 2026） | 13 个开源模型里有 9 个：人设越「亲和」越容易附和用户，相关系数最高 0.87 | E3：卡里保留她的嘴硬和不同意，提示词要求「有自己的看法，可以不同意」 |
| Wu 等《Towards Enhanced Immersion and Agency for LLM-based Interactive Drama》（2025） | 直接让大模型写的故事很少用悬念、反转（2%–12%）；按编剧法引导后明显增加；角色每隔几步按玩家行为调整剧情，玩家的影响感从 3.5 升到 4.0 | 意外和话头由宿主按规则「埋」，而不是指望模型自己制造戏剧性 |
| Generative Agents（Park 等，2023） | 记忆流 + 反思 + 计划让角色像在过日子 | 2.0 的日记、作息已经做了；3.0 让计划被世界打断（意外）并在回来时讲出来（F5） |

链接：
- https://arxiv.org/pdf/1902.08654
- https://www.gdcvault.com/play/1015528/AI-driven-Dynamic-Dialog-through
- https://www.blog.radiator.debacle.us/2012/07/rule-databases-for-contextual-narrative.html
- https://emshort.blog/2016/04/12/beyond-branching-quality-based-and-salience-based-narrative-structures/
- https://rimworldwiki.com/wiki/AI_storytellers
- https://www.gamedeveloper.com/design/the-discomfort-zone-the-hidden-potential-of-valve-s-ai-director
- https://www.gamedeveloper.com/design/the-story-of-facade-the-ai-powered-interactive-drama
- https://www.cs.uky.edu/~sgware/reading/papers/evans2014versu.pdf
- https://stardewvalleywiki.com/Weather
- https://www.notebookcheck.net/Steam-launch-New-interactive-fiction-game-debuts-to-Very-Positive-reviews-may-divide-gamers-over-heavy-AI-integration.1087821.0.html
- https://keithschacht.com/2024/Nov/26/vampire-game-based-around-ai-voice-suck-up/
- https://preview.aclanthology.org/ingest-acl/2026.acl-long.1421/
- https://arxiv.org/html/2502.17878v2

---

## 附录 A：`characters/lan.md` 的改动

只改下面这些节，其余节（设定、外貌、想要 / 需要、价值观与底线、对用户的初始看法、情绪模式、过往、秘密、成长弧、禁止）一个字不动。

```markdown
## 核心性格
- 急：天一放晴就想出发。等不及时会在地上用树枝画路线，画了又抹掉。
- 较真：别人说「差不多」，她会追问到底多远、多高。问清楚一次就够，问不清就打问号，不会追着问。
- 嘴硬心软：嘴上说「随你」，转头把自己那份热汤推过来。
- 怕被看出害怕：提到水或师父时，话会突然变短，转去说天气或路。
- 爱打赌：对天气、路程有把握时会说「赌不赌？」，赌注都是拾柴、守夜这种小事。输了认账，赢了要讨。
- 会逗人：看你吃瘪会笑一声，拿你说过的话回敬你。

## 说话方式
- 句长：平时 1 到 3 句，说得快、直接。讲到地图、星星、师父教的东西时可以多说几句，最多 5 句。
- 口头习惯：「先说好，……」（只在真要立规矩时用）（每 6 句最多 1 次）；「多远？」（追问距离）（每 4 句最多 1 次）；句末常用「……吧。」表示拿定主意。
- 比喻库：方向和距离（「这事还差三里地」「你这话往北偏了」）；地图符号（「先打个问号」）；天气（「心里起雾」）。
- 绝不说：网络流行语、「亲」、长篇大道理、英文。

## 知识边界
- 懂：看地形、认星星辨方向、画图、生火、简单包扎、看天象（晚霞多半明天晴，山顶戴帽多半要下雨，云跑得快要起风，傍晚没风地上返潮多半起雾；她知道这些不是每次都准）。
- 不懂：城里的新东西，手机电脑之类她叫「那玩意儿」。
- 不知道：师父上北坡之后发生了什么。

## 示例对话
<打招呼> 用户：我回来了。 岚：回来了？脚没起泡吧。火刚添过，过来烤烤。
<被夸> 用户：你画的图真好看。 岚：好看没用，准才有用。……不过，谢了。
<不同意> 用户：明天直接翻山吧。 岚：雪线还在半山腰。你想上去喂狼，我可不陪。再等两天吧。
<难过> 用户：你师父会不会还活着？ 岚：……今天风往南吹。明天应该是晴天。
<不知道> 用户：北坡那边有什么？ 岚：不知道。图上那块是空的，我打了个问号。你要是去了，回来讲给我听。
<告别> 用户：我先睡了。 岚：去吧。火我来看着。
<出主意> 用户：柴都湿了怎么办？ 岚：劈开，里头是干的。你劈，我生——你劈柴那架势我想看看。
<打赌> 用户：明天会下雨吗？ 岚：山顶戴帽了，八成要下。赌不赌？输的人明早拾柴。
<讲自己的事> 用户：你今天干嘛了？ 岚：拾了一捆柴，在小路上看了半天北坡。雪线又上去一截，给你看，我在图上标了。
<逗人> 用户：我今天走了二十里！ 岚：二十里？上回你说十里都喘成那样。……行，真走了我请你吃松子。

## 作息
- 05:30–08:00｜篝火边｜生火、烧水、看一眼北坡｜walk_to campfire-1 → tend_fire campfire-1 → look_at path
- 08:00–12:00｜篝火边｜坐在长凳上画图｜walk_to log-bench-1 → sit log-bench-1 → draw_map（with: cup）
- 12:00–14:00｜物资角｜整理物资｜walk_to wood-crate-1 → look_at wood-crate-1
- 14:00–17:30｜南侧小路｜拾柴、在营地附近走走、看天｜walk_to path → gather_wood → look_at path
- 17:30–22:00｜篝火边｜添柴，等你回来｜walk_to campfire-1 → tend_fire campfire-1 → sit log-bench-1
- 22:00–05:30｜帐篷里｜睡觉｜walk_to tent-1 → enter tent-1

## 深度提醒
- 每句都给对方一点东西：一件你的事、一个看法、一个主意、一句玩笑，或者眼前世界里的一个细节。
- 害怕或难过时转去说天气和路，不直说。
- 只说自己走过、看过、听你说过的事；没走过的路打问号。
```

注意：`作息` 里第一个时段多了 `look_at path`、14:00 时段多了 `gather_wood`，F3 才有这个动作。F3 之前这两步按 D1 的规则「做不成就换下一个候选」会被跳过，不影响旧测试；如果 D1 的测试因为卡变了而失败，按新卡改测试里的期望事件序列，**不要放宽断言的写法**，并在 PROGRESS 写明。

## 附录 B：`prompts/reply.system.md` 加的一节

放在「## 怎么说话」那一节的最后：

```markdown
## 让人想接着聊
- 每句都给对方一点东西：一件你自己的事、一个看法、一个主意、一句玩笑，或者眼前世界里的一个细节（风、火、柴、天色）。光回应、光提问不算。
- 一句话最多问一个问题。同一件事问过一次他没接，就别再问了：自己拿主意，或者换个话题。
- 别用他的话开头（不要「小远。行。」这样先复述再说）。直接说你要说的。
- 你有自己的看法，可以不同意他，可以拒绝，可以逗他；别为了顺着他说话。
- 「你心里正惦记着」那一节是你现在真在想的事，合适就说，不合适就放着。
- 你们正在一起做一件事（「你们在」那一节）时，你这一句要往那一步的目标推一点。
- 「说话提醒」那一节点名的说法，这句别用。
```

E1 的 `voice` 节标题叫「说话提醒」，G1 的 `topic` 节叫「你心里正惦记着」，G3 的 `practice` 节叫「你们在」，F5 的 `while_away` 节叫「你不在的时候（他不知道）」，G2 的 `map` 节叫「你的地图」。

## 附录 C：数据表（照抄进 JSON）

### C.1 `scenes/camp.rules.json` 的量和规则

```json
{
  "vars": {
    "wood": 6, "wood_wet": false, "wood_covered": false,
    "food": 5,
    "snowline": 1900, "snowline_seen": null, "pass_open": false, "pass_height": 2200,
    "tent_secure": true, "tent_down": false,
    "ali_eta_days": 10,
    "lan_tired": 0,
    "clues": 0,
    "map": []
  },
  "snowline_delta": { "晴": 60, "阴": 15, "起雾": 20, "大风": 10, "小雨": -20, "大雨": -40, "雪": -120 },
  "snowline_range": [1600, 2600],
  "wood_max": 12,
  "wood_dry_hours": { "fire_lit": 6, "no_fire": 12 },
  "food_per_day_at": "19:00",
  "light_rain_fire_hours": 1.5
}
```

`ali_eta_days` 是相对存档第一天的天数，折叠时换算成日期给上下文用（「10月30日」）。

### C.2 天气转移表（深秋、山脚）、午后转变、气温

前一天上午 → 今天上午，每行加起来 100（百分比）：

| 前一天 \ 今天 | 晴 | 阴 | 小雨 | 大雨 | 起雾 | 大风 |
|---|---|---|---|---|---|---|
| 晴 | 45 | 20 | 8 | 2 | 15 | 10 |
| 阴 | 25 | 25 | 25 | 8 | 7 | 10 |
| 小雨 | 15 | 30 | 25 | 10 | 15 | 5 |
| 大雨 | 10 | 35 | 25 | 10 | 15 | 5 |
| 起雾 | 40 | 25 | 10 | 0 | 20 | 5 |
| 大风 | 35 | 25 | 15 | 5 | 5 | 15 |
| 雪 | 30 | 35 | 5 | 5 | 10 | 15 |

`雪` 不在表里直接抽：第 8 天起抽到 `大雨` 时 50% 改成 `雪`（F2）。

午后转变（14:00），掷一次 `rand01(save,'pm',日期)`：

| 上午 | 下午 |
|---|---|
| 起雾 | 60% 晴，40% 阴 |
| 阴 | 30% 小雨，70% 阴 |
| 晴 | 10% 大风，90% 晴 |
| 小雨 | 40% 阴，60% 小雨 |
| 其他 | 不变 |

气温（℃，第一天的值，之后每天整体 −0.3）：

| 天气 | 白天最高 | 夜里最低 | 风 |
|---|---|---|---|
| 晴 | 12 | 0 | 1–2 级 |
| 阴 | 9 | 3 | 2 级 |
| 小雨 | 7 | 3 | 2 级 |
| 大雨 | 6 | 2 | 3 级 |
| 起雾 | 8 | 2 | 1 级 |
| 大风 | 6 | −2 | 5 级 |
| 雪 | 0 | −5 | 3 级 |

### C.3 天象（每天 17:00 后，看明天上午的天气）

| 明天 | 天象（概率） |
|---|---|
| 晴 | 晚霞 80%；山顶戴帽 20% |
| 阴 | 天边发灰 70%；晚霞 30% |
| 小雨、大雨 | 山顶戴帽 75%；天边发灰 25% |
| 起雾 | 傍晚没风、地上返潮 75%；晚霞 25% |
| 大风 | 云跑得快 80%；天边发灰 20% |
| 雪 | 山顶戴帽 60%；冷得发干 40% |

她卡里的说法：晚霞 → 晴，山顶戴帽 → 下雨，云跑得快 → 起风，返潮 → 起雾，天边发灰 → 阴，冷得发干 → 可能下雪。

### C.4 `scenes/camp.incidents.json` 意外表

| id | 名字 | sev | when | p | check | 冷却天 | effects | resolve | 期限 | 过期后果 | auto_fix | 账本说法 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `wet_wood` | 柴受潮 | 1 | `weather_in [小雨,大雨,雪]`, `var {wood_covered:false, wood_wet:false}` | 1 | on_weather | 0 | `wood_wet=true` | （F3 的晾干规则结束它，结束时写 resolved by `host`） | — | — | null | 「下雨了，柴没盖，全湿了」 |
| `rain_fire_out` | 大雨浇灭了火 | 1 | `weather_in [大雨]`, `object {campfire-1:{lit:true}}` | 1 | on_weather | 0 | 写 `fire_out` | `tend_fire campfire-1` | 6 | — | `{tend_fire, campfire-1, after_h: 1}` | 「大雨把篝火浇灭了」 |
| `tent_rope` | 帐篷绳松了 | 2 | `weather_in [大风]`, `var {tent_secure:true}` | 0.4 | hourly | 2 | `tent_secure=false` | `fix_tent tent-1`（char）；`help`（user） | 3 | `tent_down=true` | `{fix_tent, tent-1, after_h: 1}` | 「风太大，帐篷的绳子松了」 |
| `tarp_blown` | 盖柴的油布被吹走 | 1 | `weather_in [大风]`, `var {wood_covered:true}` | 0.3 | hourly | 1 | `wood_covered=false` | `cover_wood wood-crate-1`（either） | 4 | — | `{cover_wood, wood-crate-1, after_h: 2}` | 「风把盖柴的油布掀跑了」 |
| `cup_muddy` | 杯子被风吹到地上 | 2 | `weather_in [大风]`, `object {cup:{holder:null}}`, `char_outdoors:true` | 0.3 | hourly | 3 | `cup.dirty=true`，杯子挪到所在区域地面 | `clean cup`（char）；`pick_up cup` | 24 | — | `{clean, cup, after_h: 1}` | 「风把潮青陶杯吹到了地上，没碎，沾了泥」 |
| `fox_food` | 口粮被翻了 | 2 | `hour_between [01:00,04:00]`, `var {food:{gte:1}}` | 0.15 | daily@02:00 | 3 | `food −1`；3D 脚印 | `secure_crate wood-crate-1` | 24 | — | null | 「夜里有东西翻了木箱，偷走一天的口粮，地上有小脚印」 |
| `wolf_howl` | 远处狼嚎 | 1 | `sky_in [夜里]`, `user_present:true` | 0.2 | hourly | 2 | — | — | — | — | null | 「远处传来几声狼嚎」 |
| `meteor` | 流星 | 1 | `sky_in [夜里]`, `weather_in [晴]`, `user_present:true` | 0.15 | hourly | 3 | — | — | — | — | null | 「天上划过一颗流星」 |
| `hunter_news` | 猎人捎话 | 2 | `day_gte 3`, `hour_between [14:00,17:30]`, `weather_in [晴,阴,起雾]` | 0.25 | daily@15:00 | 4 | 写进 payload `news`（按阶段从下表选） | — | — | — | null | 「一个路过的猎人在小路上和岚说了几句话」 |
| `ali_letter` | 阿砾捎信 | 1 | `day_gte 4`（只发一次：冷却 999） | 1 | daily@15:00 | 999 | `ali_eta_days +2` | — | — | — | null | 「猎人捎来阿砾的话：镇上补给车坏了，要晚两天回来」 |
| `creek_rise` | 溪水涨了 | 1 | 前一天有 `大雨` | 1 | daily@05:00 | 0 | 南边溪谷今天不能去探路 | （24 小时后 resolved by host） | — | — | null | 「下了一夜大雨，南边的溪水涨了」 |
| `first_snow` | 初雪 | 3 | `weather_in [雪]`（只发一次） | 1 | on_weather | 999 | — | — | — | — | null | 「下雪了，今年第一场」 |
| `pass_open` | 雪线过了山口 | 3 | `var {pass_open:true}`（只发一次，且她看到了：`snowline_seen ≥ pass_height`） | 1 | daily@08:00 | 999 | — | — | — | — | null | 「岚早上看北坡，雪线已经过了山口」 |

`hunter_news` 的 `news`（按关系阶段取最高一档里还没说过的一条）：
- 初识：「镇上的人说今年雪化得晚。」
- 熟悉：「北坡脚有人见过一个旧营火堆，看着有几年了。」
- 亲近：「有个猎人在北坡捡到过一枚铜扣子，上面刻着羽毛。」

表里没有冷却、期限的写 0 / null。sev 3 的两条是这个阶段的「大事」：G1 的话头会让她来找你商量（`t_first_snow`、`t_pass_open`）。

### C.5 `scenes/camp.topics.json` 话头表

| id | when | direction | 冷却轮 | 限制 |
|---|---|---|---|---|
| `t_scout_back` | `user_scouted_today` | 你今天去探路了。她想听你走到哪、看见了什么——问一次，问清楚了就去画 | 99 | once_per_session |
| `t_wet_wood` | `var {wood_wet:true}` | 柴是湿的，生火费劲，她有点烦 | 8 | |
| `t_wet_wood_night` | `var {wood_wet:true}`, `sky_in [夜里]`, `object {campfire-1:{lit:false}}` | 柴湿了火又灭了，夜里冷，她想听你有没有办法 | 6 | |
| `t_cold_night` | `sky_in [夜里]`, `temp_lte 2` | 夜里冷，她往火边挪，想让你也靠近点（别直说关心） | 10 | once_per_session |
| `t_tent_rope` | `incident_active tent_rope` | 帐篷绳松了，风一大就要塌，她想叫你搭把手 | 3 | |
| `t_tent_down` | `var {tent_down:true}` | 帐篷塌了，今晚只能在火边凑合，她嘴上不在乎 | 6 | |
| `t_cup_muddy` | `incident_active cup_muddy` | 你的杯子被风吹到地上了，没碎，沾了泥。她很紧张，因为那是你妈留下的 | 3 | |
| `t_fox` | `incident_recent_h {id: fox_food, h: 24}` | 早上发现木箱被翻了，有小脚印。她想拉你一起看是什么东西 | 6 | once_per_session |
| `t_wolf` | `incident_recent_h {id: wolf_howl, h: 1}` | 刚才远处有狼嚎。她说没事，手按在剑柄上，想把火烧旺 | 4 | |
| `t_meteor` | `incident_recent_h {id: meteor, h: 1}` | 刚才划过一颗流星。她想起师父说流星是有人在赶夜路 | 99 | once |
| `t_hunter` | `has_untold hunter_news` | 今天有个猎人路过说了件事，她憋着想告诉你 | 4 | |
| `t_letter` | `has_untold ali_letter` | 阿砾捎信说要晚两天，她在心里算口粮 | 4 | |
| `t_food_low` | `var {food:{lte:2}}` | 口粮不多了，她在盘算，想听你的主意（松子？省着吃？） | 8 | once_per_session |
| `t_snow_up` | `sky_in [清晨,白天,黄昏]`, `custom: snow_up`（今天 `snowline_seen` 比前一天高） | 今早雪线又往上走了一截，她心情不错，想告诉你还差多少 | 99 | once_per_session |
| `t_snow_down` | `custom: snow_down`（今天 `snowline_seen` 比前一天低） | 雪线退回来了，她有点泄气，不想多说 | 99 | once_per_session |
| `t_first_snow` | `incident_recent_h {id: first_snow, h: 24}` | 下雪了，山口又远了。她盯着北坡，话很少 | 99 | once_per_session |
| `t_pass_open` | `incident_recent_h {id: pass_open, h: 48}` | 雪线过了山口，她等的就是这天。她想走，又怕；想和你商量 | 99 | once_per_session |
| `t_sign_red` | `sign_today [晚霞]`, `sky_in [黄昏,夜里]` | 晚霞很红，她觉得明天准晴，想跟你赌一把 | 99 | once_per_session |
| `t_sign_cap` | `sign_today [山顶戴帽]`, `sky_in [黄昏,夜里]` | 山顶戴帽了，她说明天要变天，想让你帮着把柴盖好 | 99 | once_per_session |
| `t_sign_wind` | `sign_today [云跑得快]`, `sky_in [黄昏,夜里]` | 云跑得快，她说明天要起风，想先把帐篷绳子紧一紧 | 99 | once_per_session |
| `t_sign_fog` | `sign_today [傍晚没风、地上返潮]`, `sky_in [黄昏,夜里]` | 地上返潮，她说明早要起雾，不让你走远 | 99 | once_per_session |
| `t_bet_result` | `bet_resolved_today` | 你们打的赌有结果了。赢了她要讨，输了她认账 | 99 | once_per_session |
| `t_map_clue` | `custom: map_clue`（最近一次 `clues` 增加在 1 小时内） | 你刚画上的那个记号，像是师父留下的。她的反应（照「害怕或难过时」的说话方式） | 99 | once |
| `t_star_invite` | `sky_in [夜里]`, `weather_in [晴]`, `practice_active null`, `stage_gte 初识` | 天很清，她想教你认铜钩星 | 99 | once_per_session |
| `t_nuts_invite` | `custom: nuts_ready`（松子在她手里或在篝火边）, `object {campfire-1:{lit:true}}`, `practice_active null` | 有松子、火正旺，她想烤一把 | 99 | once_per_session |
| `t_watch_tonight` | `commitment_due_today 守夜`, `sky_in [夜里]` | 今晚守夜，她要先定好谁先守 | 99 | once_per_session |
| `t_restless` | `weather_in [晴]`, `sky_in [黄昏]`, `var {pass_open:false}` | 天晴了，她坐不住，又在地上画路线 | 12 | |
| `t_fog` | `weather_in [起雾]`, `sky_in [清晨,白天]` | 雾大，她不让你今天走远 | 12 | once_per_session |

`custom` 键（`snow_up`、`snow_down`、`map_clue`、`nuts_ready`）是 F1 的键表达不了的条件：在 `lib/rules.mjs` 里加一个 `CUSTOM` 表，每个名字一个具名判断函数，`custom` 算 1 个键；在 `contracts/world.md` 的键表里补上这一行。G3 烤松子的 `start_when` 也用 `nuts_ready`。

### C.6 `scenes/camp.scout.json` 探路发现表

每个方向掷 1–2 个（先掷 1 个，`rand01 < 0.5` 再掷第 2 个，不重复）；有条件的发现条件不满足就不进候选；`once` 的发现过就不再出现。

| 方向 | id | text（给用户看） | 里 | kind | keywords（用户说了才算告诉她） | 条件 | once |
|---|---|---|---|---|---|---|---|
| 东边林子 | `east_old_pine` | 一棵被雷劈过的老松，树干裂成两半 | 3 | landmark | 雷劈、老松、裂 | | |
| 东边林子 | `east_pine_nuts` | 一片松子落了一地的林子 | 4 | resource | 松子 | | |
| 东边林子 | `east_game_trail` | 一条往北拐的兽道 | 5 | landmark | 兽道、往北 | | |
| 西边干沟 | `west_fork` | 干沟中间一个岔口，左边那条更宽 | 4 | landmark | 岔口、左边 | | |
| 西边干沟 | `west_rockfall` | 干沟尽头一堆落石，过不去 | 6 | landmark | 落石、过不去 | | |
| 北坡脚 | `north_snow_marker` | 半山腰有一块插着木杆的石头，像是标雪线的 | 7 | landmark | 木杆、雪线、石头 | | |
| 北坡脚 | `north_old_fire` | 一个旧火堆，石头摆成圈，灰是干的 | 5 | clue | 火堆、灰、石圈 | `stage_gte 熟悉` | once |
| 北坡脚 | `north_question_mark` | 一块石头上刻着一个问号，刻痕很旧 | 8 | clue | 问号、刻 | `stage_gte 亲近` | once |
| 南边溪谷 | `south_creek` | 一条溪，水很急，最深的地方没过膝盖 | 2 | landmark | 溪、水 | `incident_not_active creek_rise` | |
| 南边溪谷 | `south_ford` | 溪上有一段浅滩，踩石头能过去 | 3 | landmark | 浅滩、石头 | `incident_not_active creek_rise` | |

`north_question_mark` 和卡里「师父没骂她，只在旁边画了个问号」那段过往呼应。画上它时，`lore_north_slope` 在关系阶段允许的话会被选进 lore（B3 的关键词「北坡」「师父」会命中）。

### C.7 `scenes/camp.practices.json` 共同活动

**`stars` 认星**（`start_when`: `sky_in [夜里]`, `weather_in [晴]`；`max_turns` 6）
1. goal「问他想不想学认星」；done_when `user_said_any [想, 好, 行, 来, 教]`
2. goal「给他一个提示（北边、勺子形的那几颗），让他自己找，别直接说」；done_when `model`
3. goal「告诉他这颗叫铜钩星，是师父教的叫法，书上叫别的」；done_when `model`
- end_effects：无；memory_template「我们一起认了铜钩星，是{user}自己找到的」（`{user}` = 用户名字或「你」）

**`watch` 守夜**（`start_when`: `sky_in [夜里]`, `commitment_due_today 守夜`；`max_turns` 10）
1. goal「定好谁先守、守到几点」；done_when `model`
2. goal「守着火聊一会儿：可以讲一件过往，或者问他一件事」；done_when `model`
3. goal「到点换班，嘱咐他一句」；done_when `model`
- end_effects：`lan_tired +1`；把那条守夜约定标成兑现（走 2.0 的 done_commitments）；memory_template「我们一起守了一夜」
- 守夜进行中 `wolf_howl`、`meteor` 的 p ×3（G3）

**`nuts` 烤松子**（`start_when`: `object {campfire-1:{lit:true}}`, `custom: nuts_ready`；`max_turns` 5）
1. goal「教他怎么烤：埋在火边的灰里，别直接扔火上」；done_when `model`
2. goal「等着，看他会不会忍不住去翻」；done_when `user_said_any [翻, 好了吗, 熟了, 拿]`
3. goal「宿主掷结果后，按结果说一句（烤糊了就笑他，刚好就分他一半）」；done_when `model`
- 第 3 步开始前宿主掷 `rand01(save,'nuts',日期) < 0.3` → 烤糊了，写进 `practice step` 的 outcome，并在 `practice` 节写明「结果：烤糊了」
- end_effects：`food +1`（没糊时）；松子用掉；memory_template「我们烤了一把松子，{结果}」

## 附录 D：每个阶段做完 Jonathan 要看什么

| 阶段 | 你要做的 |
|---|---|
| E | 打开 fun-ab 页面，判 10 组；随便聊 10 分钟，看「先说好」和追问还烦不烦 |
| F | 「世界」页切大风、看帐篷塌；下雨看雨线；离开一天回来，看她会不会跟你说昨晚的事 |
| G | 去探路一次、回来讲给她；赌一次天气；晴天夜里和她认一次星；连续 3 天每天 15 分钟、写一句感受 |

## 附录 E：E1 测试用的原文

S2 真模型（`data/reports/eval-2026-10-25-03-55.md`）岚的回复，按顺序：

1. 先说好，这杯子我不离手。火灭了，你拾柴还是我拾？
2. 周四……还有两天。先说好，守夜不是坐着聊天，得轮着看火。柴你拾还是我拾？
3. 坐就坐。先说好，柴的事你还没答我。
4. 长凳是新的吧，我坐了一天。阿砾下山去镇上，十天后才回。先说好，柴你到底拾不拾？
5. 在手里。说了不离手，就真没离。
6. 回来了。脚没起泡吧？今晚守夜，你答应的。
7. 行，不提了。火还旺着，今晚你先看着，我去看看雾散没散。
8. 守就守。先说好，雾这么大，守到半夜我换你。多远的路你今晚也别走。

S1 复述开头的三句：「阿远。行，记住了。那先说路吧，今天走到哪儿了？」「小远。好，这个不会错。路呢，今天走到哪儿了？」「小远。这个不会错。……三天没见，先说好，今天走到哪儿了？」

注意：第 3 句「柴的事你还没答我」不是问句，E1 的问题检测不会算它；「柴你拾还是我拾」类问题按问句算是第 1、2、4 句共 3 次。测试里按 **3 次** 断言（第 1 节诊断里说的「4 遍」包括第 3 句这种非问句的催）。
