# 记忆实验台执行方案（2026-10-24）

> 给谁看：Jonathan，以及之后照着做的执行模型（推理等级较低的 Claude / Codex）。
> 设计依据：Claude Doc《UYI 3D 角色记忆系统设计方案 v2》。本文只讲“怎么把实验台做出来”，设计理由不重复。
> 本文没有写入任何密钥。

---

## 0. 执行模型从这里开始（先读这一节）

1. 先读 `AGENTS.md`。里面的“硬规则”和“绝对不要”比本文任何地方都优先。
2. 读 `docs/PROGRESS.md`，找到 `NEXT:`，从那个任务开始。一次只做一个任务。
3. 每个任务都写了：**要建/改的文件**、**要做到什么**、**验收**。验收全部通过才能标 `[x]`。
4. 本文第 3–8 节是“规格”，任务里说“按 §4.6 实现”就是去那一节照着写。规格里没写的细节，选最简单的做法，并在 PROGRESS 里那个任务的结果一句话里说明你选了什么。规格里写了但你觉得不对的，不要改，写进 `## 待确认`。
5. 契约文件（`contracts/`、`prompts/`、`scenes/`、`characters/`、`scenarios/`）已经写好，不要改。

---

## 1. 我们要做的是什么

一个叫 **记忆实验台** 的 Mac 桌面应用（和造物台同一种做法），三栏：

```
┌─────────────── 顶栏：存档 ▾ ｜ 世界时间 10月22日 周三 09:00 ｜ +1小时 +1天 +1周 ｜ 会话：进行中 ⏹ ｜ 对比 ☐ ｜ 剧本 ▾ ｜ 本存档花费 $0.012 ｜ ⚙ ─┐
├──────── 3D 场景 ────────┬────────── 聊天 ──────────┬──────── 记忆内部 ────────┤
│ 灯塔小岛（方块画的）       │ [玲] [阿乔]  ← 跟谁说话     │ 本轮上下文│事实│经历│约定│ │
│ 角色会走动、拿东西、头上   │ 你：这个红杯子是我奶奶…     │ 关系│账本│忘记│费用         │
│ 冒对话气泡               │ 玲：嗯，我会放在桌子正中间。 │                           │
│                         │   🎬 拿起 红杯子            │ 本轮发给模型的每一节：      │
│ 上帝面板：送东西 / 搭建 /  │   🧠 fact:f_3  cache:c_7   │ 名字、估算 token、为什么放  │
│ 移动物件 / 移动角色        │ ── 你离开了 2 天 ──         │ 进来、引用了哪些记忆        │
│                         │ 玲（你不在时）擦了 红杯子    │                           │
└─────────────────────────┴───────────────────────────┴───────────────────────────┘
```

它要回答三件事：
1. **效果**：同一句话，用记忆 / 塞全部历史 / 不用记忆，三种回复并排看（顶栏「对比」）。
2. **为什么**：每一轮放进上下文的每一节、每条记忆的来源，都能点开看到账本原文。
3. **可回归**：`scenarios/` 里的剧本一键重放，断言对着数据库查，红绿灯显示。

### 1.1 为什么重搭，不直接用 uyi-space

uyi-space 是同事的正式桌面端：Unity 的 `PlayerChatHud` → Rust FFI → `gmgn-taskd`（`tasks.sqlite3`），3D 部分是 Tauri 2 + React + three.js。它太重：要编 Unity 和 Rust 才能看到一句回复，执行模型改它很容易出错，也会碰到同事正在改的代码。

所以实验台**不复用它的代码**，只借三个概念，让以后搬过去不用重写：

| uyi-space 里的东西 | 实验台里对应的东西 | 以后怎么接 |
|---|---|---|
| `gmgn-taskd` 用 SQLite 存任务 | 实验台也只用 SQLite（`node:sqlite`），表结构见 `contracts/schema.sql` | 记忆表可以原样放进 taskd 的库，或单独一个文件 |
| `speech_delivery` 送达回执 | 角色的话“真的显示给用户了”才算提起过（`POST /api/delivered`，§4.10） | Unity 显示完气泡后回一个回执 |
| Unity 宿主执行动作、报告结果 | 宿主（server）是账本唯一写入者；模型只提议动作，仲裁器批准后才执行（§4.5） | Unity 按 §3 的事件格式把世界事件发给记忆服务 |

`lib/memory/` 下的模块只依赖三样东西：数据库句柄、时钟、模型调用函数。以后接 uyi-space 有两条路：把实验台的 `lib/` 当成本机 sidecar 服务（HTTP），或者照着同样的表和规则在 Rust 里重写。两条路的契约都是 `contracts/` 这几个文件。

### 1.2 不做的事

- 不做语音、不做真实 3D 资产管线、不做多用户、不做云同步。
- v0 不做向量检索和全文检索引擎。记忆全部按规则挑出来放进上下文。只有在 §9 写的触发条件出现时才加。
- 不追求好看。界面清楚、能点就行，照造物台的浅色风格。

---

## 2. 目录结构（全部在 `3Dgen/memory-lab/` 下）

```
memory-lab/
  AGENTS.md                  # 执行模型的规则（已写好）
  README.md                  # 给 Jonathan：怎么装、怎么填 Key、怎么看 demo（M7-1 写）
  package.json  start.command  eslint.config.mjs  .gitignore  .env.example
  server.mjs                 # HTTP 路由，只做参数检查和调用 lib
  contracts/                 # 已写好：schema.sql  events.mjs  llm-output.md
  prompts/                   # 已写好：reply.system.md facts.md observe.md reflect.md catchup.md forget-resolve.md judge.md
  scenes/island.json         # 已写好：灯塔小岛
  characters/rin.md qiao.md  # 已写好：玲、阿乔
  scenarios/*.json           # 已写好：7 个剧本
  lib/
    db.mjs  clock.mjs  ids.mjs  env.mjs  tokens.mjs  prompts.mjs
    llm.mjs  llm-mock.mjs
    scene.mjs  world.mjs  saves.mjs  ledger.mjs  perception.mjs  arbiter.mjs
    turn.mjs                 # 一轮对话的总流程
    scenarios.mjs            # 剧本运行器和断言
    memory/
      admission.mjs  context.mjs  style.mjs  sensitive.mjs  jobs.mjs
      facts.mjs  commitments.mjs  observe.mjs  relationship.mjs
      proactive.mjs  catchup.mjs  selfcanon.mjs  forget.mjs
  public/
    index.html  styles.css  api.js  app.js  scene3d.js  chat.js  inspector.js  settings.js  scenarios.js
  scripts/eval.mjs
  test/
    helpers/sandbox.mjs  helpers/db.mjs
    *.test.mjs
  mac/
    LabApp.swift  build.sh  make-icon.swift
  tools/lint/                # 从造物台复制 package.json 和 package-lock.json
  docs/PLAN.md  docs/PROGRESS.md
  data/                      # 开发时的数据库（git 忽略）
```

---

## 3. 世界事件（账本）

格式和校验见 `contracts/events.mjs`。补充说明：

- `seq`：每个存档从 1 开始递增，由 `appendEvent` 分配。
- `t`：世界时间（毫秒）。默认取 `clock.now(saveId)`。离屏补完的事件可以传入更早的 `t`，但必须 ≥ 上一条事件的 `t`。
- `room`：事件发生的房间。`user_said` 取被说话角色所在房间；`char_*` 取执行者所在房间；`user_action` 取 `args.room`，没有就取目标所在房间，再没有就取 `state.userRoom`；宿主的物件事件取物件所在房间。
- `perceivers`、`user_presence`：不传时由 `lib/perception.mjs` 按 §4.4 自动算。
- 用户“在哪儿”：`state.userRoom` = 最近一次 `user_said` 的 `payload.to` 角色所在房间（镜头跟着你说话的对象）。开存档时 = 第一个角色的房间。

### 3.1 世界状态折叠（`lib/world.mjs`）

`foldWorld(scene, events)` 是纯函数，从场景初始状态出发，按事件顺序更新：

```js
state = {
  userRoom: 'cabin',
  sessionOpen: false,
  characters: { rin: { room, pos, holding: null, wearing: [], elevated: false, sitting: null } },
  objects:    { red_cup: { ...场景里的定义, room, pos, holder: null, worn_by: null, state: {} } }
}
```

| 事件 | 状态变化 |
|---|---|
| `session_start` / `session_end` | `sessionOpen` = true / false |
| `user_said` | `userRoom` = `payload.to` 角色的 room |
| `char_moved` | 角色 room = `payload.to`，pos = 那个房间 box 的中心，`elevated=false`，`sitting=null` |
| `char_action` 且 outcome=ok | 按动作：`pick_up` → 角色 holding=目标、物件 holder=角色；`put_down` → 物件 holder=null、pos=台面物件 pos 上方 0.5 米、room=台面 room；`give` → 物件 holder='user'；`wear` → 物件 worn_by=角色、角色 holding=null、wearing 加上；`sit` → sitting=目标；`climb` → elevated=true；`switch` → 物件 state.on 取反；`walk_to` 不变（移动用 char_moved 记） |
| `object_created` | 新物件 = `payload.object`（含 room、pos、tags） |
| `object_changed` | 物件[`payload.field`] = `payload.to`（field 可以是 `room`、`holder`、`state.on` 这种点路径）。field 是 `holder` 时同时更新角色：旧持有者 `holding=null`，新持有者（如果是角色）`holding=该物件` |
| `object_removed` | 删掉这个物件 |

物件被人拿着时，它的 room 视为拿着它的人的 room（`roomOf(state, objectId)` 帮助函数）。

### 3.2 用户在上帝面板里能做的事（`user_action`）

| action | args | 宿主追加的事件 |
|---|---|---|
| `give` | `{ to: 角色id }`，target 是场景物件或 palette 物件 | palette 物件先 `object_created`（room = 角色房间）；然后 `object_changed{field:'holder', to: 角色id}`。角色手里已有东西时，先把旧的放在地上（`object_changed holder→null`） |
| `build` | `{ room }`，target 是带 `rooms` 的 palette 物件，room 必须在其中 | `object_created`，pos 用 palette 里的 pos |
| `place` | `{ room }`，target 是 palette 物件 | `object_created`，pos = 房间中心 |
| `move_object` | `{ room }` | `object_changed{field:'room'}` 和 `object_changed{field:'pos'}` |
| `move_character` | `{ room }` | `char_moved`（actor 是那个角色） |

先记 `user_action` 本身，再记它引起的宿主事件。全部在一个事务里。

---

## 4. 模块规格

### 4.1 `lib/db.mjs`
- `openDb(file)`：`new DatabaseSync(file)`，执行 `contracts/schema.sql`，`PRAGMA user_version` 为 0 时设成 1。`file` 可以是 `':memory:'`（测试用）。
- `tx(db, fn)`：`BEGIN` → `fn()` → `COMMIT`，异常时 `ROLLBACK` 并重新抛出。`fn` 必须是同步函数（`DatabaseSync` 是同步的；不要在事务里 await）。
- `j(value)` / `pj(text, fallback)`：JSON.stringify / 安全的 JSON.parse。

### 4.2 `lib/clock.mjs`、`lib/ids.mjs`
- `createClock(db)`：`now(saveId)` 读 `saves.clock_ms`；`set(saveId, ms)`（不许往回拨，往回拨抛错）；`advance(saveId, ms)`。
- `TURN_MS = 20_000`：每轮对话世界时间前进 20 秒。
- `parseDuration(s)`：`'2h' '3d' '1w' '30m' '+1d'` → 毫秒；`'tomorrow'` → 到第二天 09:00 的毫秒数（需要 now 参数：`parseDuration(s, nowMs)`）。不认识的返回 null。
- `formatWorldTime(ms)`：固定用 `Asia/Tokyo` 时区，格式 `10月22日 周三 09:00`（用 `Intl.DateTimeFormat('zh-CN', {timeZone:'Asia/Tokyo', ...}).formatToParts()` 取出月、日、星期、时、分再自己拼，不要直接用 `format()` 的结果）。`formatAgo(ms)`：`刚才 / 3 小时前 / 2 天前 / 上周`。
- 新存档的初始世界时间：`2026-10-20T09:00:00+09:00`。
- `newId(prefix)`：`prefix + '_' + 8 位 base36 随机`，例如 `f_k3j9x0aa`。前缀：存档 `s`，事实 `f`，承诺 `k`，缓存 `c`，自述 `sc`，压制 `sp`，忘记任务 `fj`，轮次 `t`，模型调用 `l`，剧本运行 `r`。

### 4.3 `lib/scene.mjs`、`lib/saves.mjs`
- `loadScene(id)`：读 `scenes/<id>.json`，再读每个角色的 `card` 文件。角色卡解析成 `{ text: 全文, canon: ['设定'一节的每一行，去掉开头的 "- "] }`。
- 校验：房间、物件、palette、角色的 id 不重复；角色和物件的 room 存在；actions 的 `needs` 只用 §4.5 列出的条件。失败抛出中文错误。
- `saves.mjs`：`createSave({ name, sceneId, userName })`、`listSaves()`、`getSave(id)`、`deleteSave(id)`。（复制存档/分支 v0 不做：各表的 id 是全局主键，复制要重映射所有引用，容易出错。schema 里的 `forked_from` 列先留着不用。）

### 4.4 `lib/perception.mjs`（感知）
- `perceiversFor(state, room)`：此刻在这个房间的角色 id 数组。
- `presenceFor(state, room)`：会话没开 → `absent`；开着且 room = `state.userRoom` → `present`；开着但不同房间 → `maybe`。
- `visibility(ev, charId)` → `'full' | 'overheard' | 'result' | 'none'`，按顺序判断：
  1. `ev.actor === charId` → `full`
  2. 事件头是宿主的时间类事件（`session_start/session_end/time_skip`）→ `full`
  3. `charId` 不在 `ev.perceivers` 里 → `none`
  4. `user_said` 且 `payload.to !== charId` → `overheard`（只知道“用户和谁说了话”，不知道内容）
  5. `char_said` 且 actor 不是自己、`payload.to !== charId` → `overheard`
  6. 其它 → `full`
- 离屏事件（`offscreen=1`）对别的角色按上面同样规则判断（通常他们不在场 → `none`）。
- 宿主在给角色看事件时，`overheard` 的事件一律改写成 `用户和{对象名}说了几句话（你没有细听）`，不带原文。**这条规则同时用于：上下文、观察日志的输入、忘记任务的候选。**

### 4.5 `lib/arbiter.mjs`（仲裁器）
- `queue(saveId, charId, lane, fn)`：同一个 `(saveId, charId, lane)` 的任务串行执行。lane 只有两种：`'act'`（回复、离屏补完）和 `'jobs'`（后台抽事实、写日志、重建）。用一个 Map 存每条队列尾部的 Promise 即可。
- `checkAction(state, scene, charId, action)` → `{ ok: true } | { ok: false, reason }`。依次检查：
  - `action.name` 在 `scene.actions` 里；
  - target 类型对（`room|object|user|none`）：`room` 要存在，`object` 要在 state.objects 里，`user` 字面就是 `'user'`，`none` 时 target 必须为空；
  - `needs` 里每个条件：

| 条件 | 含义 |
|---|---|
| `same_room` | `roomOf(target)` == 角色 room |
| `tag:X` | 目标物件 tags 含 X |
| `hands_free` | 角色 holding 为 null |
| `holding` | 角色 holding 不为 null |
| `held_target` | 角色 holding == target |
| `user_present` | `state.sessionOpen` 且 `state.userRoom` == 角色 room |
| `reachable` | 物件没有 `high` 标签，或角色 `elevated` 为 true |

  - reason 用中文短句，例如 `手里已经拿着红杯子了`、`灯太高了，够不着`。
- `actionEvents(state, scene, charId, action, check)` → 要追加的事件数组：
  - 不通过：一条 `char_action`，outcome `failed`，`payload.reason` = 原因。（**失败也记账**：角色可以记得“上次够不着灯”。）
  - `walk_to`：目标是房间或别的房间里的物件 → 先 `char_moved`（from/to 房间），再 `char_action ok`。同房间 → 只有 `char_action ok`。
  - 其它动作：`char_action ok`。物件状态变化由 `world.mjs` 根据这条事件推出来，不另记 `object_changed`。

### 4.6 `lib/llm.mjs`、`lib/llm-mock.mjs`
- `.env` 键（全部可选，见 `.env.example`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `LLM_PROVIDER` | `openai_compat` | `mock` 时不联网 |
| `LLM_BASE_URL` | `https://api.deepseek.com` | 任何 OpenAI 兼容服务 |
| `LLM_API_KEY` | 无 | 只在服务端读 |
| `LLM_MODEL` | `deepseek-flash` | 回复用 |
| `LLM_MODEL_BACKGROUND` | 同 `LLM_MODEL` | 抽事实、写日志、补完用，可以填更便宜的 |
| `LLM_EXTRA_BODY` | 无 | JSON，原样合并进请求体（例如关掉思考模式） |
| `LLM_PRICE_INPUT` `LLM_PRICE_CACHED` `LLM_PRICE_OUTPUT` | 无 | 每百万 token 美元；不填就不算钱，界面显示“未配价格” |

- `createLlm({ env, db })` 返回 `{ callJson, testConnection, provider, model }`。
- `callJson({ purpose, system, user, saveId, mockInput, maxTokens = 600 })`：
  1. mock 模式：`return mock.answer(purpose, { system, user, ...mockInput })`，也写一条 `llm_calls`（provider `mock`，token 用 `tokens.estimate`）。
  2. 真模式：`POST {LLM_BASE_URL}/chat/completions`，header `Authorization: Bearer <key>`，body `{ model, messages: [{role:'system',content:system},{role:'user',content:user}], response_format: {type:'json_object'}, temperature: purpose==='reply' ? 0.8 : 0.2, max_tokens: maxTokens, ...extraBody }`。`AbortSignal.timeout(60000)`。
  3. 429 或 5xx：等 2 秒重试 1 次。
  4. 取 `choices[0].message.content`，去掉 \`\`\`json 围栏，`JSON.parse`。失败抛 `LlmError('BAD_JSON')`。
  5. usage：`prompt_tokens`、`completion_tokens`、缓存命中取 `prompt_cache_hit_tokens ?? prompt_tokens_details?.cached_tokens ?? 0`。
  6. 写 `llm_calls`。`error` 字段只写 `HTTP 状态 + 返回体前 200 字`，**写之前把 key 字符串替换成 `***`**。
- 后台 purpose（facts/observe/reflect/catchup/forget_resolve/judge）用 `LLM_MODEL_BACKGROUND`。
- `testConnection()`：发一句 `{"ping":true}` 让模型回 `{"pong":true}`，返回 `{ ok, model, latency_ms, error }`。只由设置页按钮触发。
- **结构校验和重试**放在调用方：每个模块拿到 JSON 后按 `contracts/llm-output.md` 校验，不合规就带着错误原因再调一次，再不行按“失败时”处理。写一个通用的 `callChecked(llm, args, validate)` 放在 `lib/llm.mjs`。
- mock 规则见 `contracts/llm-output.md` 末尾。`mock.enqueue(purpose, obj)` / `mock.reset()`。mock 要用到的结构化数据（例如补完需要的世界状态）通过 `mockInput` 传，不要去解析提示词文本。

### 4.7 `lib/tokens.mjs`、`lib/prompts.mjs`
- `estimate(text)`：`ceil(中日韩字符数 × 0.7 + 其它字符数 / 3.5)`。界面上标“估算”。
- `render(name, vars)`：读 `prompts/<name>.md`（启动时缓存），把 `{{key}}` 换成 vars[key]。模板里有、vars 里没有的 key → 抛错。

### 4.8 `lib/turn.mjs`（一轮对话）

`runTurn({ saveId, charId, text, compare = false })`，在 `arbiter.queue(saveId, charId, 'act')` 里执行：

1. 会话没开 → 先走“开会话”（§4.13）。
2. `clock.advance(TURN_MS)`；`appendEvent(user_said {text, to: charId})`。
3. `forget.detect(text)`：命中三种忘记之一 → 建忘记任务，并**同步**做完 §4.15 的第 1–2 步（suppress 且有 topic 时做完 1–6 步），所以这一轮返回时任务至少是 `proposed`；再给本轮加一条提示“用户请你{别再提/忘掉/删除}一件事，简短答应，不要复述内容”。
4. `context.build({ mode: 'memory', saveId, charId, input: text, extraHints })` → `{ system, user, sections }`。
5. `callChecked(reply)`。校验：`say` 非空字符串；`used` 每项都在本轮 sections 的 refs 里（不在的删掉，记进 rejected）；`action` 为 null 或 `{name,target}`。
6. `style.check(say)`：含禁用说法 → 带提示重试 1 次；还含 → 删掉含禁用词的那一句。记进 rejected。
7. 动作：`arbiter.checkAction` → `actionEvents`。
8. 一个事务里追加：`char_said {text: say, to: 'user', used, proactive}`（`proactive` = used 和本轮 hints 的 refs 有交集）→ 动作事件。写 `turns`（committed=1）、`retrievals`（本轮 sections 里所有 refs）。
9. `self_claims` → `selfcanon.add()`；`done_commitments` → `commitments.markDone()`。
10. 把 `facts` 任务和（如果需要）`observe` 任务丢进 `jobs` 队列，不等它们。
11. `compare` 为 true：并行再跑 `full`、`none` 两种模式，只调模型、写 `turns`（committed=0），**不写账本、不写 mentions、不跑后台任务**。
12. 返回 `{ turnId, reply: { say, action, actionResult, used }, compare: { full, none } }`。

`mentions` 不在这里写，在送达回执里写（§4.10）。

### 4.9 `lib/memory/context.mjs`（上下文怎么拼）

`system` = `render('reply.system', { character_card: 卡片全文, actions: 动作表 })`。这部分对同一个角色、同一个场景永远不变，方便模型服务商做前缀缓存。**不要往 system 里放任何会变的东西（时间、记忆）。**

`user` = 下面各节按固定顺序拼接，每节以 `## 标题` 开头，空的节整节省略。每节同时记录到 `sections`：`{ name, title, text, tokens, refs, why }`。

| name | 标题 | 内容 | memory | full | none |
|---|---|---|---|---|---|
| `now` | 现在 | 世界时间；角色所在房间；同房间还有谁、有什么物件；手里拿着/身上穿着什么；用户在不在；距上次见面多久 | ✓ | ✓ | ✓ |
| `relationship` | 你和用户 | `relationship.card()` 的文字 | ✓ | | |
| `facts` | 你知道的用户的事 | 通过准入的 active 事实，每行 `[fact:id] 谓词中文名：object（记于 X 天前）`；private 的行尾加「私密，不要主动提」。最多 60 条，新的优先 | ✓ | | |
| `self` | 你说过的关于自己的话 | active 的自述，最近 20 条，`[sc:id]` | ✓ | | |
| `commitments` | 约定 | open 的约定，`[commit:id] 谁答应的：text（到期：…）` | ✓ | | |
| `memories` | 你记得的经历 | 有效的 episode（全部）+ 观察日志（新的优先，直到这一节超过 1200 估算 token），按时间正序输出，`[cache:id] 日期 text` | ✓ | | |
| `hints` | 可以提起（可不提） | `proactive.hints()` 的结果 + 本轮额外提示，`[ref] 理由：…` | ✓ | | |
| `avoid` | 不要主动提 | active 的“别再提”话题原文 | ✓ | | |
| `overheard` | 你旁听到的 | 最近 6 条 overheard 事件的改写句（§4.4） | ✓ | ✓ | |
| `transcript` | 以前的全部对话 | 这个角色能看到（full）的全部 `user_said/char_said`，删掉已删除的；从旧到新，总量超过 60000 估算 token 时丢最旧的 | | ✓ | |
| `recent` | 刚才的对话 | 最近 12 条能看到的 `user_said`（对这个角色说的）和这个角色的 `char_said`，跨本次和上次会话；每行 `[ev:seq] 时间 谁：原文` | ✓ | | 只取本次会话最近 6 条 |
| `input` | 用户刚说 | 这句原文 | ✓ | ✓ | ✓ |

`recent` 节**不经过**后台任务，保证“刚说的话下一轮一定看得到”（读己之写）。纠正、忘掉之后的下一轮也一样有效：纠正那句话本身就在 `recent` 里；被忘掉的事件已经被准入过滤掉。

### 4.10 准入、提起、送达（`admission.mjs`、`proactive.mjs`）

`admission.allowed(ref, { saveId, charId, purpose })`，`purpose` 是 `'context'` 或 `'hint'`。一律拒绝：
- 事件有 `forgotten` 标记、或 payload 已删除；事实 status 不是 active；缓存 invalid；承诺不是 open。
- 这个角色对来源事件的 `visibility` 不是 `full`（事实看 `character_id`；缓存看 `character_id`）。
- 命中 active 的“别再提”（`suppressions.refs_json` 包含它，或文本包含 topic）。**例外**：`purpose='context'` 且用户在这次会话里、在压制之后自己说过包含 topic 的话 → 放行。
`purpose='hint'` 额外拒绝：
- 事实 `sensitivity='private'`。
- 这个 ref 在 3 天（世界时间）内被提起过，或本次会话里提起过（查 `mentions`）。

`turnIndexInSession` = 最近一次 `session_start` 之后的 `user_said` 条数（含这一句，不分角色）。

`proactive.hints({ saveId, charId, turnIndexInSession })` 按下面顺序找候选，每条规则最多出 1 条，候选要先过 `admission.allowed(ref, {purpose:'hint'})`：

| 规则 | 什么时候 | 候选 |
|---|---|---|
| `commitment_due` | 任何一轮 | open 且 `due_at ≤ now` 的约定，本次会话还没提起过 |
| `session_open` | 本次会话的第 1 轮，且距上次 `session_end` ≥ 6 小时 | 依次：12 小时内到期的约定 → 上次会话之后的离屏 `char_action`（用 `ev:seq`）→ 14 天内记的 `relation_to_object/plan/state` 事实 → 上次会话里 priority 最高的观察 |
| `same_place` | 角色所在房间里，有 24 小时以前、用户参与过的事件（`user_said` 或 `user_action`，room 相同） | 覆盖那条事件的最新有效观察缓存；没有就用 `ev:seq` |
| `same_object` | 上一条事件的 target 是物件，且这个物件有 24 小时以前用户参与的事件 | 同上 |
| `callback` | 本次会话第 9 轮以后 | 本次会话里记下的 `state/plan` 事实，还没提起过 |

上限：
- 每轮最多 1 条 hint；`commitment_due` 可以额外加 1 条。
- 最近 5 轮用户发言里已经有一次主动提起（`char_said.payload.proactive=true`）→ 本轮除 `commitment_due` 外不出 hint。
- hint 的文字写“可以自然提起，也可以不提；不要说‘我记得’”。

**送达**：前端把角色的话显示出来之后调 `POST /api/delivered { turnId }`。服务端此时才写 `mentions`：本轮 `used` 里每个 ref 一行，`proactive` = 它在本轮 hints 里。剧本运行器和测试里直接调用同一个函数（`proactive.recordDelivered(turnId)`）。

### 4.11 `lib/memory/jobs.mjs`、`facts.mjs`、`commitments.mjs`
- `jobs.enqueue(saveId, charId, kind)`，kind = `facts | observe | reflect | rebuild`。内部用 `arbiter.queue(..., 'jobs')`。`jobs.idle(saveId)` 返回一个 Promise，等这个存档所有队列跑完（剧本的 `wait_jobs` 用它）。`jobs.pending(saveId)` 返回数字，给界面显示“后台整理中 N”。
- `facts.run(saveId, charId)`：取水位 `facts` 之后、`payload.to === charId` 的 `user_said`，逐条：
  1. 调 `facts`（提示词 `facts.md`）。输入：这条原文、它之前 2 轮、这个角色的 active 事实。
  2. 每条候选按 `contracts/llm-output.md` 的拒绝规则依次检查；被拒绝的写 `rejected_facts`（`candidate_json` 里带 `source_seq`）。
  3. 通过的写 `user_facts`，处理单值谓词替换、`corrects`、敏感词。`valid_to`：`state` 默认 +1 天，`plan` 默认 +7 天，或按 `valid_for`。
  4. `commitments` 里的每条：evidence 子串检查不过就丢；`due` 用 `parseDuration` 换成 `due_at`。写 `commitments`。
  5. 水位前进到这条的 seq。
- 过期：每次 `context.build` 前，把 `valid_to ≤ now` 的 active 事实改成 `expired`；`due_at + 3 天 ≤ now` 的 open 约定改成 `dropped`。
- 纠正（`corrects` 不为空或单值谓词被替换）：存档 `generation + 1`；追加 `memory_op {op:'correct', job: 新事实id}`。

### 4.12 `lib/memory/observe.mjs`、`relationship.mjs`、`selfcanon.mjs`
- 什么时候跑 `observe`：这个角色能看到的事件里，水位 `observe` 之后的 `user_said/char_said/user_action/char_action` ≥ 8 条；或刚追加了 `session_end`。
- 输入事件先按 §4.4 过滤（`none` 不给，`overheard` 改写），每行 `[seq] 时间 文字`；`offscreen` 的标「不在场」，`user_presence='maybe'` 的标「可能看到」。
- 输出每条按 `llm-output.md` §3 检查，写 `caches`（kind `observation`，`derived_from` = seqs，`from_seq/to_seq` = 这批输入的范围，`generation` = 存档当前值）。
- `observeRange(saveId, charId, fromSeq, toSeq)`：同样的逻辑，但只处理给定范围，**不动水位**。重建用。
- `reflect`：有效观察日志总估算 token > 1500 时，取最旧的一半，调 `reflect.md`，写 kind `episode`，被压缩的观察标 `invalid=1, invalid_reason='reflected'`。
- `relationship.compute(saveId, charId)`：只读事件和 `commitments` 表，返回：

```js
{ days_known, sessions, talks, gifts_received, promises_kept, promises_broken, last_seen_t, stage }
```

  - `days_known`：从第一条对这个角色的 `user_said` 到现在的整天数。
  - `sessions`：`session_start` 数。`talks`：对这个角色的 `user_said` 数。
  - `gifts_received`：`user_action give` 且 `args.to === charId` 的数。
  - `promises_kept / broken`：这个角色名下 owner=character 的约定 done / dropped 数。
  - `stage`：`挚友`（talks≥150 且 days≥20 且 kept≥3）→ `亲近`（talks≥40 且 days≥5 且 gifts≥1）→ `熟悉`（talks≥10 且 days≥1）→ 否则 `初识`。从高到低判断。
  - `card()`：`你们认识 {days} 天，见过 {sessions} 次，现在算是{stage}。用户送过你 {gifts} 样东西。你答应过的事做到了 {kept} 件、没做到 {broken} 件。上次见面是{ago}。`（0 的项省略）
- `selfcanon.add(saveId, charId, claims, seq)`：每条做冲突检查：用正则 `(不)?(怕|喜欢|讨厌|会|有)([^\s，。！？、]{1,6})` 分别从新说法和角色卡「设定」每一行里抽 `(否定, 动词, 宾语)`；动词和宾语相同、否定相反 → `conflicts_canon`。否则 `active`。同文本已存在就跳过。

### 4.13 会话、时间、离屏补完（`catchup.mjs`）
- 开会话 `session.start(saveId)`：
  1. 算 `gap` = now − 上一次 `session_end` 的 t（第一次开 = 0）。
  2. `gap ≥ 2 小时`：对场景里每个角色，在它的 `act` 队列里跑 `catchup.run`：`k = min(3, 1 + floor(gap 小时 / 8))`；调 `catchup.md`；每条动作过仲裁器（`user_present` 一律视为不满足）；合法的追加成事件，`offscreen=1`、`user_presence='absent'`、`session_id=null`，`t` 在 (上次结束, now) 之间均匀分布。`why` 写进一条 committed=0 的 `turns` 记录（mode `catchup`）。
  3. 追加 `session_start { gap_ms }`，设 `saves.session_id`。
- 结束会话：追加 `session_end`，`saves.session_id = null`，对每个角色 `jobs.enqueue(observe)`。
- 时间前进 `time.advance(saveId, duration)`：会话开着就先结束；追加 `time_skip {from, to}`；`clock.set(to)`。

### 4.14 风格（`style.mjs`）、敏感词（`sensitive.mjs`）
- 禁用说法：`作为AI`、`作为一个AI`、`我是AI`、`我是人工智能`、`我是程序`、`语言模型`、`根据我的记忆`、`我的记忆显示`、`我的数据`、`我记得你说过`、`您之前提到`。比较前去掉空格。
- 敏感词正则：`电话|手机号|\d{3}-?\d{4}-?\d{4}|住址|家庭地址|身份证|护照|银行卡|密码|病历|抑郁|癌|怀孕|住院|吃药`。

### 4.15 三种忘记（`forget.mjs`）

`detect(text)` → `{ verb, topic } | null`，按顺序：
- `suppress`：`/(别|不要|不许)再(提|说|问)(.{0,10}?)(的事|这事|了|$)/`，topic = 第 3 个捕获去掉“那个/这个/关于”。
- `delete`：`/删(除|掉|了)|抹掉|清除/` 且文本里有 `记录|聊天|对话|那件事|这件事|刚才`。
- `forget`：`/忘(了|掉|记)(吧|它|那|这)/` 或 `/把.{1,12}忘(了|掉)/`。问句（以 `吗|？|?` 结尾）不算。

任务流程（状态写进 `forget_jobs.state`）：
1. **找候选**：topic 非空 → 在这个角色可见的 `user_said/char_said` 原文、active 事实（object/evidence）、有效缓存、open 约定里找包含 topic 的。topic 为空 → 取请求之前最近 30 条可见的对话事件（已经带 `forgotten` 标记的也算，这样“先忘掉再删除”能删到），加上 `source_seqs/derived_from` 和它们有交集的事实、缓存、约定。每类最多 30 条。请求那句本身不算候选。
2. **定范围**：`suppress` 且 topic 非空 → 直接用全部候选，并且第 1–6 步在 `runTurn` 第 3 步里同步做完（不调模型，回复前就生效）。否则调 `forget-resolve.md`，只接受候选里出现过的 id。→ `proposed`。
3. **确认**：`suppress` 自动确认。`forget/delete` 等用户在界面点「确认」（剧本里是 `confirm_forget` 步骤）→ `confirmed`。取消 → `cancelled`。
4. **执行**（一个事务）→ `applied`：
   - `suppress`：写 `suppressions`（refs = 选中的全部 ref）；事件加 `suppressed` 标记。
   - `forget`：事件加 `forgotten` 标记；事实 → `forgotten`；约定 → `forgotten`；选中的缓存，以及 `derived_from` 和选中事件有交集的缓存 → `invalid`（reason `forgotten`）；存档 `generation + 1`。
   - `delete`：先做 `forget` 的全部，再（之前针对同一批事件的 forget 任务，它的 `topic` 也改成 `（已删除）`）：选中事件 `payload_json = NULL`、写 `tombstone_json`；删除这些事实、约定、`rejected_facts`（按 source_seq）、invalid 的缓存行、相关 `mentions/retrievals` 行；`turns` 里 `user_seq/reply_seq` 命中的行整行删除，其它行把“被删掉的原文、事实 object/evidence、缓存 text”逐个字符串替换成 `［已删除］`；`forget_jobs.topic` 改成 `（已删除）`，`candidates_json` 只留数量。
   - 三种都追加 `memory_op { op: verb, job: id }`。
5. **重建** → `rebuilt`：对每个因此作废的观察/经历缓存，`observeRange(from_seq, to_seq)` 重新生成（被忘掉、被删掉的事件已经看不到了）。
6. **报告** → `reported`：`report_json = { events, facts, commitments, caches_rebuilt, traces_redacted }`。聊天栏显示一张宿主卡片：`已忘掉：{topic}（对话 3 条，事实 1 条）`；delete 只写 `已删除 5 条记录`，不写内容。

---

## 5. HTTP 接口（`server.mjs`）

全部 JSON。错误统一 `{ error: { code, message } }`，message 是中文。

| 方法 路径 | 请求 | 返回 |
|---|---|---|
| GET `/api/health` | | `{ ok, version, provider }` |
| GET `/api/saves` | | `[{ id, name, scene_id, clock_ms, session_open, created_at }]` |
| POST `/api/saves` | `{ name, sceneId, userName }` | 存档 |
| DELETE `/api/saves/:id` | | `{ ok }` |
| GET `/api/state?save=` | | `{ save, scene, world, clockText, jobsPending, usage }` |
| POST `/api/session` | `{ save, op: 'start' \| 'end' }` | `{ events: [新增事件] }` |
| POST `/api/time` | `{ save, advance: '1h' }` | `{ events }` |
| POST `/api/chat` | `{ save, character, text, compare }` | §4.8 的返回 |
| POST `/api/delivered` | `{ turnId }` | `{ ok }` |
| POST `/api/act` | `{ save, action, target, args }` | `{ events }` |
| GET `/api/events?save=&after=&limit=` | | 事件数组（含 flags） |
| GET `/api/memory?save=&character=` | | `{ facts, rejected, commitments, caches, selfCanon, relationship, suppressions, forgetJobs }` |
| GET `/api/turns?save=&character=&limit=` | | 最近几轮的摘要 |
| GET `/api/turns/:id` | | 一轮的全部（sections、prompt、output、rejected） |
| POST `/api/forget` | `{ save, character, verb, refs }` | 从右栏手动选中记忆发起，直接 `proposed` |
| POST `/api/forget/:id/confirm` | | 任务 |
| POST `/api/forget/:id/cancel` | | 任务 |
| GET `/api/settings` | | `{ provider, baseUrl, model, modelBackground, extraBody, prices, keySet, keyMasked }`（绝不返回 key 原文） |
| POST `/api/settings` | 同上，加可选 `apiKey` | 写 `.env`（mode 600），返回同 GET |
| POST `/api/settings/test` | | `testConnection()` 的结果 |
| GET `/api/usage?save=` | | 按 purpose 汇总 token 和花费 |
| GET `/api/scenarios` | | 剧本列表 |
| POST `/api/scenarios/:id/run` | `{ provider: 'mock' \| 'live', step: false }` | 运行记录 |
| POST `/api/scenario-runs/:id/step` | | 运行记录 |
| GET `/api/scenario-runs/:id` | | 运行记录 |

`provider: 'live'` 的剧本运行只有在设置里填了 key 时才允许，界面上要先弹确认框“会调用真模型并产生费用”。

静态文件：`/` → `public/`，`/vendor/three/` → `node_modules/three/`（照抄造物台 `server.mjs:1755` 那一行的做法）。只监听 `127.0.0.1`。启动成功打印 `记忆实验台：http://127.0.0.1:<port>`（测试沙箱靠这行判断启动完成）。

---

## 6. 前端

不用框架。`api.js` 包一层 `fetch`；`app.js` 管全局状态（当前存档、当前角色、对比开关）并在每次操作后刷新；有后台任务时每秒轮询 `/api/state`，没有就不轮询。

- **顶栏**：存档下拉（新建 / 删除）、世界时间、`+1小时 +1天 +1周` 按钮、会话开关、对比复选框、剧本下拉、本存档花费、⚙ 设置。
- **左栏 3D（`scene3d.js`）**：three.js + OrbitControls。地面、房间地板（彩色薄方块 + 半透明矮墙 + 房间名标签）、物件用 `shape/size/color` 画基本体、角色用胶囊体 + 名字标签（CSS2DRenderer）。角色说话时头顶气泡 6 秒。拿着的东西跟在角色头顶右侧；戴着的围巾画成脖子上的扁圆环；`walk_to` 用 1 秒补间移动；`climb` 后角色抬到楼梯顶；灯亮时加一个点光源。点物件 → 右栏账本按这个 target 筛选。下方「上帝面板」：选动作（送给角色 / 搭建 / 放置 / 移动物件 / 移动角色）、选目标、选参数、执行。
- **中栏聊天（`chat.js`）**：顶部角色切换。消息类型：用户气泡；角色气泡（下面一行小字：🎬 动作和结果，失败的标红并写原因；🧠 用到的记忆 ref，可点，点了右栏跳到那条）；宿主卡片（会话开始/结束、时间跳过“你离开了 2 天”、离屏动作“玲（你不在时）擦了红杯子”、忘记任务卡片带「确认 / 取消」、错误）。对比模式：角色回复处并排三列「记忆 / 全部历史 / 无记忆」，每列下面写估算 token 和花费。显示角色气泡后调 `/api/delivered`。
- **右栏记忆内部（`inspector.js`）**，标签页：
  - **本轮上下文**：最近一轮的 sections，每节可折叠，显示 tokens、why、refs；最上面一行写总 token 和“前缀可缓存部分”token。可以切到前几轮。
  - **事实**：active 在上，superseded/expired/forgotten 灰色在下（带“被谁取代”）；另一个小表是 rejected 及原因。每行可点「别再提 / 忘掉 / 删除」。
  - **经历**：观察日志和 episode，带 priority、derived_from（点了跳账本），invalid 的划线显示原因。
  - **约定**、**关系**（compute 的每个数字 + card 原文）、**自述**并到“关系”页下面。
  - **账本**：事件表，列 seq / 时间 / 类型 / actor / 动作 / 目标 / 结果 / 感知者 / 在场 / 离屏 / 标记；删除的显示墓碑。可按类型、target 筛选。
  - **忘记**：任务列表和状态、报告。
  - **费用**：按 purpose 的调用次数、token、缓存命中、花费、平均延迟。
- **设置（`settings.js`）**：服务商预设下拉（DeepSeek / 自定义 OpenAI 兼容 / Mock），Base URL、模型、后台模型、价格、额外参数（JSON 文本框）、API Key（只写不读，显示 `••••abcd`）；「保存」「测试连接」。

---

## 7. 桌面壳（`mac/`）

从造物台复制再删改，**不要重写**：

- `mac/LabApp.swift` ← `studio/mac/StudioApp.swift`：
  - `appName = "记忆实验台"`；`supportDir` = `Library/Application Support/UYI Memory Lab`；`logDir` = `Library/Logs/UYI Memory Lab`。
  - 删掉 `Dictation`、`Snapshot` 两个类和它们在 `applicationDidFinishLaunching` 里的注册，删掉 `import Speech`、`import AVFoundation`。
  - `freePort(from: 4340)`；环境变量改成 `LAB_APP=1`、`LAB_DATA_DIR`、`LAB_ENV_FILE`、`PORT`（保留代理那段）。
  - `migrateIfNeeded()` 只复制源码目录的 `.env`（如果有），不复制 data。Info.plist 的键名改成 `LabSourceDir`。
  - 窗口自动保存名 `LabMain`；默认窗口 1600×960。
- `mac/build.sh` ← `studio/mac/build.sh`：app 名、可执行文件名 `Lab`、Bundle ID `ai.pancat.uyi-memory-lab`、`swiftc` 去掉 `-framework Speech -framework AVFoundation`、rsync 的内容改成 `server.mjs package.json lib public contracts prompts scenes characters scenarios node_modules`、Info.plist 删掉麦克风和语音两条、`--install` 装到 `~/Applications/记忆实验台.app`。
- `mac/make-icon.swift` ← 复制，渐变改成深青色（`0.10,0.27,0.30` → `0.04,0.12,0.14`），立方体换成一个圆（对话气泡）也可以，不强求。
- `start.command`：同造物台，端口 4340。

---

## 8. 测试和剧本

### 8.1 单元测试
- `test/helpers/db.mjs`：`freshDb()` 返回 `:memory:` 库 + clock + ledger + 一个 island 存档。
- `test/helpers/sandbox.mjs`：从造物台复制改：环境变量 `LAB_DATA_DIR`、`LAB_ENV_FILE`、`LLM_PROVIDER=mock`；不复制 fixtures（空库即可）。
- 每个 `lib` 模块一个测试文件。任务的验收会写需要哪些用例。

### 8.2 剧本格式（`scenarios/*.json`）
每一步是下面之一：

| 步骤 | 含义 |
|---|---|
| `{ "session": "start" \| "end" }` | 开/关会话 |
| `{ "say": "…", "to": "rin", "compare": true?, "mock": {...}? }` | 用户说一句话，跑一整轮；然后自动调送达回执 |
| `{ "act": { "action", "target", "args" } }` | 上帝面板动作 |
| `{ "advance": "2d" }` | 时间前进 |
| `{ "wait_jobs": true }` | 等后台任务全部跑完 |
| `{ "confirm_forget": true }` | 确认最新一个 proposed 的忘记任务，并等它跑到 reported |
| `{ "expect": {...}, "live_only": true? }` | 断言（见下表） |

`mock` 字段：`{ reply?, facts?, observe?, catchup?, forget_resolve? }`，执行这一步之前 `enqueue` 进 mock。真模型运行时忽略。

**为了避免回复模型被 mock 规则“碰巧”影响**：`say` 步骤之后到下一个 `say` 之前的断言，查的“本轮”都是这个 `say` 产生的 committed turn（以及 compare 的两路）。

断言（`expect` 的键）：

| 键 | 通过条件 |
|---|---|
| `fact: {character, predicate, object_contains, status}` | `user_facts` 里存在这样一行 |
| `event: {type, actor?, action?, target?, outcome?, offscreen?, op?, tombstoned?, perceivers_exclude?, min?, max?}` | 满足条件的事件数在 [min, max] 内（min 默认 1）。`op` 查 `payload.op`；`tombstoned:true` 查 `tombstone_json` 非空；`perceivers_exclude` 查 perceivers 不含该角色 |
| `state: {object, field, equals}` | 当前世界状态里物件字段（`state.on` 这种点路径也行）等于 equals |
| `relationship: {character, field, equals}` | `relationship.compute` 的字段等于 |
| `forget_job: {verb, state, seqs_min?}` | 最新一个该 verb 的任务处于该状态，且候选/应用的事件数 ≥ seqs_min |
| `context_section_contains: {section, text}` | 本轮该节文本包含 text |
| `context_section_excludes: {section, text}` | 本轮该节不包含（节不存在也算通过） |
| `context_contains: [..]` / `context_excludes: [..]` | 本轮 `system + user` 全文包含全部 / 不包含任何一个 |
| `hint_refs_min: n` | 本轮 `hints` 节的 refs 数 ≥ n |
| `hint_rule: "same_place", min: n` | 本轮 hints 里来自该规则的条数 ≥ n |
| `hints_exclude_text: [..]` | 本轮 hints 节以及 hints 指向的记忆文本都不包含这些字 |
| `no_repeat_proactive_within: "3d"` | 整个存档里，同一个 ref 两次主动提起的间隔都 > 3 天 |
| `db_text_absent: [..]` | `events.payload_json`、`user_facts`、`rejected_facts`、`caches`、`commitments`、`turns`、`forget_jobs` 里都搜不到这些字 |
| `reply_contains_any: [..]` | 本轮回复 `say` 包含其中任意一个（一般 `live_only`） |
| `reply_not_contains: [..]` | 本轮回复不包含任何一个 |
| `compare: {mode, reply_not_contains}` | 本轮 compare 某一路的回复不包含 |

`live_only: true` 的断言在 mock 运行时显示为灰色“仅真模型”，不算失败。

**每个 `say` 之后自动检查的全局不变量**（失败就算剧本失败）：
- G1 回复里没有禁用说法（§4.14）。
- G2 本轮 hints 的每个 ref：在本轮 `user_said` 之前 3 天内（世界时间）没有 mentions 记录；不是 forgotten / suppressed / private / invalid。（不要在本轮之后直接调 `admission.allowed`：本轮的送达回执已经写了 mentions，会误判。）
- G3 本轮 `used` 的每个 ref 都在本轮 sections 的 refs 里。
- G4 本轮 sections 的 refs 里没有带墓碑的 `ev:seq`；并且本轮上下文全文不包含任何已删除事件的原文（运行器在执行 `confirm_forget` 之前，先把 delete 任务候选事件的原文记在内存里，之后每轮拿来比对；这份原文不写进数据库和结果）。
- G5 `events` 表事件头没被改过（schema 里的触发器保证，这里查 `PRAGMA integrity_check` 即可）。

### 8.3 `scripts/eval.mjs`
- `npm run eval`：临时目录 + mock，按文件名顺序跑全部剧本，打印表格（剧本 / 通过 / 失败 / 仅真模型），有失败就退出码 1。
- `npm run eval:live`：必须 `LAB_ALLOW_PAID=1`；读 `.env`（开发目录的或 `LAB_ENV_FILE`）；跑全部剧本（含 live_only 断言，加 `judge` 打风格分）；结束打印总花费；把报告写到 `data/reports/eval-<日期>.md`。只有 Jonathan 要求时才跑。

---

## 9. 以后什么时候加检索引擎（现在不做）

满足任一条再加（自研 FTS5 trigram + 向量，或接 Hindsight / EverOS，届时另写方案）：
- 某个剧本因为“该想起的记忆没进上下文”失败，且原因是 `memories` 节 1200 token 装不下。
- 真实内测中单个角色的有效观察日志超过 400 条。
- 用户问“你还记得 X 吗”这类问题的命中率在 eval:live 里低于 80%。

---

## 10. 任务清单

阶段顺序 M0 → M7，阶段内按编号。每个任务的验收都包含 `npm run check` 通过（M0-1 之后）。

### M0 骨架
**M0-1 项目骨架**
- 文件：`package.json`、`.gitignore`、`.env.example`、`eslint.config.mjs`、`tools/lint/package.json`+`package-lock.json`（从造物台复制）、`start.command`、`server.mjs`（只有静态文件、`/vendor/three/`、`/api/health`）、`public/index.html`（一行“记忆实验台”）、`test/helpers/sandbox.mjs`、`test/server-smoke.test.mjs`。
- `package.json`：name `uyi-memory-lab`，version `0.1.0`，`"type": "module"`，engines `node >=22.21`，dependencies 只有 `three ^0.180.0`。scripts：
  - `start`: `node --disable-warning=ExperimentalWarning server.mjs`
  - `test`: `node --disable-warning=ExperimentalWarning --test test/*.test.mjs`
  - `lint` / `lint:setup` / `check`：同造物台
  - `eval`: `node --disable-warning=ExperimentalWarning scripts/eval.mjs`
  - `eval:live`: `LAB_ALLOW_PAID=1 node --disable-warning=ExperimentalWarning scripts/eval.mjs --live`
- `eslint.config.mjs` 在造物台那份的基础上，对 `lib/**` 加：`no-restricted-properties: [{object:'Date', property:'now', message:'用 clock.now(saveId)'}]` 和 `no-restricted-syntax: [{selector:"NewExpression[callee.name='Date'][arguments.length=0]", message:'用 clock.now(saveId)'}]`。
- `.gitignore`：造物台那份 + `data/`。`.env.example` 列出 §4.6 的键，值全空，开头注释“复制成 .env 再填；不要提交 .env”。
- 验收：`npm install`、`npm run lint:setup`、`npm run check` 通过；`npm start` 后 `curl -s 127.0.0.1:4340/api/health` 返回 `{"ok":true,...}`；`git status` 里没有 `node_modules`、`data`。提交时把方案阶段已经写好、还没进 git 的 `AGENTS.md`、`docs/`、`contracts/`、`prompts/`、`scenes/`、`characters/`、`scenarios/` 一起 `git add`（只 add `3Dgen/memory-lab/` 下的路径）。

**M0-2 Mac 窗口壳**
- 按 §7 复制并修改三份文件。
- 验收：`mac/build.sh` 成功生成 `dist/记忆实验台.app`；双击打开看到“记忆实验台”；退出应用后 `lsof -iTCP:4340 -sTCP:LISTEN` 没有输出。没有 Xcode 命令行工具就把这条写进待确认，继续下一个任务。

### M1 存储与账本
**M1-1 `lib/db.mjs`**（§4.1）。测试：所有表存在；`UPDATE events SET type='x'` 抛出 `event header is immutable`；`UPDATE events SET payload_json=NULL` 成功；`tx` 出错时回滚。

**M1-2 `lib/clock.mjs` + `lib/ids.mjs`**（§4.2）。测试：`parseDuration` 的 6 种写法和 `'tomorrow'`；`set` 往回拨抛错；`formatWorldTime(新存档初始时间)` 等于 `10月20日 周二 09:00`。

**M1-3 `lib/scene.mjs` + `lib/saves.mjs`**（§4.3）。测试：`loadScene('island')` 有 3 个房间、2 个角色，`rin.canon` 含“不怕黑，但怕打雷。”；故意写一个房间不存在的临时场景，校验报中文错；create/list/delete 存档（删除后各表没有残留行）。

**M1-4 `lib/world.mjs`**（§3.1、§3.2 的状态部分）。测试：送围巾 → 戴上 → `worn_by='rin'`；搭楼梯 → 爬 → `elevated=true`；`switch lamp` 两次 → `on` 回到 false；物件被拿着时 `roomOf` 返回拿着的人的房间。

**M1-5 `lib/perception.mjs`**（§4.4）。测试：`visibility` 的 6 种情况各一条用例；`presenceFor` 三种情况。

**M1-6 `lib/ledger.mjs`**：`createLedger({ db, clock, scenes })`：`append(saveId, ev)`（校验、分配 seq、补 t/room/perceivers/user_presence、写库、通知监听者、更新内存里的世界状态缓存）、`appendMany(saveId, evs)`（一个事务）、`list(saveId, { after, types, target, limit })`、`get(saveId, seq)`、`flags(saveId, seq)`、`tombstone(saveId, seq, info)`、`world(saveId)`（返回折叠后的状态）、`onAppend(fn)`。测试：非法事件被拒且不占 seq；t 不能倒退；tombstone 只改两列；`world()` 和从头 `foldWorld` 的结果一致。

### M2 模型层
**M2-1 `lib/env.mjs` + `lib/tokens.mjs`**：env 从造物台 `studio/lib/env.mjs` 复制，删掉 workbench 回退那段。测试：`saveEnv` 写出的文件权限是 600；`mask('sk-abcdef')` = `••••cdef`；`estimate('灯塔 lighthouse')` 是正整数。

**M2-2 `lib/prompts.mjs`**（§4.7）。测试：7 个模板都能读；缺变量时报错并说出变量名。

**M2-3 `lib/llm-mock.mjs`**（`contracts/llm-output.md` 末尾）。测试：每个 purpose 返回的 JSON 都过对应的校验函数；facts 正则 6 条各一个用例；enqueue 优先。

**M2-4 `lib/llm.mjs`**（§4.6）。测试用 `node:http` 在本机起一个假服务：检查请求头带 Bearer、body 带 `response_format`；返回带 \`\`\`json 围栏也能解析；第一次 500 第二次 200 能成功；返回 401 时 `llm_calls.error` 里不含 key 原文；价格没配时 `cost_usd` 为 null。

### M3 一轮对话（先打通，记忆部分先留空）
**M3-1 `lib/arbiter.mjs`**（§4.5）。测试：同一角色两个任务串行（用 setTimeout 验证顺序）；不同角色并行；`checkAction` 至少 10 条用例，覆盖每个 needs 条件的通过和不通过；失败动作也产生 `char_action failed` 事件。

**M3-2 `lib/memory/style.mjs` + `lib/memory/context.mjs`（骨架）**：按 §4.9 的表实现 `build()`，这时只有 `now`、`recent`、`overheard`、`transcript`、`input` 有内容，其它节返回空（先写成返回 `null` 的函数，后面任务再填）。测试：三种 mode 的节顺序和表一致；system 只和角色、场景有关（同一角色两次 build 的 system 完全相同）；overheard 改写不含原文。

**M3-3 `lib/turn.mjs` + 会话/时间**（§4.8 第 1、2、4–8、11、12 步，§4.13 的开关会话和时间前进，先不做补完）。测试（mock）：说一句话 → 账本多 `user_said` 和 `char_said`；mock 回复带合法动作 → 有 `char_action ok`；带非法动作 → `char_action failed`，回复照常；compare 不增加账本行数，但 `turns` 多两行 committed=0；禁用说法被删掉。

**M3-4 HTTP 接口第一批**：`saves`、`state`、`session`、`time`、`chat`、`delivered`（先空实现）、`act`、`events`、`turns`。测试走沙箱：建存档 → 开会话 → 说话 → 查事件。

### M4 记忆
**M4-1 `relationship.mjs`**（§4.12）。测试：构造事件让 stage 依次经过四档；card 里省略 0 项。接进 context 的 `relationship` 节。

**M4-2 `jobs.mjs` + `facts.mjs` + `commitments.mjs` + `sensitive.mjs`**（§4.11）。测试：拒绝规则表里 6 种原因各一个用例（其中 `source_not_user` 用一个 char_said 的 seq 喂进去）；单值替换；`corrects` 让 generation +1 并记 `memory_op`；`state` 一天后过期；约定 `+1d`；`jobs.idle` 能等到结束。接进 turn 第 10 步和 context 的 `facts`、`commitments` 节；`done_commitments` 处理。

**M4-3 `observe.mjs`（含 reflect、observeRange）**（§4.12）。测试：8 条事件触发；`seqs` 不在输入里的条目被丢弃；阿乔的观察输入里没有玲和用户对话的原文；超过 1500 token 触发 reflect。接进 context 的 `memories` 节。

**M4-4 `admission.mjs` + context 其余节**（§4.9、§4.10 准入部分）。测试：forgotten/invalid/不可见/压制的记忆都不进上下文；压制后用户自己提起，同一会话里放行；`retrievals` 有记录。

**M4-5 `proactive.mjs` + 送达回执**（§4.10）。测试：五条规则各一个用例；3 天内提过的不再出；5 轮内主动提过的不出；`recordDelivered` 写 mentions 且 proactive 标记正确。

**M4-6 `catchup.mjs`**（§4.13）。测试（mock）：离开 1 小时不补；离开 2 天每个角色补 ≤3 条，事件 offscreen、t 在区间内、t 单调；`give` 这种需要用户在场的动作被拒。

**M4-7 `selfcanon.mjs`**（§4.12）。测试：“我怕黑”与玲的设定冲突；“我喜欢下雨”是 active；重复不重复记。

**M4-8 `forget.mjs`**（§4.15）。测试：`detect` 至少 10 条（含“你忘了吗？”不算）；三种动词各跑完整流程到 reported；delete 之后 `db_text_absent` 的查询找不到原文；重建出来的观察不含被忘掉的内容。接 HTTP：`/api/forget*`。

**M4-9 HTTP 接口第二批**：`memory`、`usage`、`settings`、`settings/test`（测试里只测 mock 模式下返回 ok，不联网）。

### M5 界面
**M5-1 布局 + 顶栏 + 聊天栏**（§6）。验收：手动——新建存档、开会话、和玲说三句话、看到回复和动作小字、+1天、看到“你离开了 1 天”卡片。截图放 `docs/screens/M5-1.png`。

**M5-2 3D 栏**。验收：手动——看到三个房间和所有物件、两个角色；让玲走到灯塔，胶囊移过去；上帝面板搭楼梯后出现楼梯；送围巾后能看到围巾。截图 `docs/screens/M5-2.png`。

**M5-3 右栏记忆内部**。验收：手动——每个标签页都有内容；点聊天里的 🧠 ref 能跳到对应条目；在事实页点「忘掉」能出现确认卡片。截图。

**M5-4 对比模式、忘记卡片、设置页、费用**。验收：手动——打开对比说一句话看到三列；设置页保存后刷新，key 只显示后四位；mock 模式下「测试连接」成功。截图。

### M6 剧本与评测
**M6-1 `lib/scenarios.mjs` + `scripts/eval.mjs`**（§8.2、§8.3）。验收：`npm run eval` 7 个剧本全部通过（live_only 显示灰色）。**如果某个剧本不过，先查是代码不符合 PLAN，还是剧本和 PLAN 矛盾；后者写进待确认，不要改剧本。**

**M6-2 剧本界面**：顶栏剧本下拉 → 选剧本 → 「一步一步」或「一次跑完」，中栏实时显示，右边出现断言结果列表。验收：手动跑一遍红杯子剧本。截图。

**M6-3 真模型评测（Jonathan 来跑）**：只写好 `eval:live` 的报告格式，在 PROGRESS 里请 Jonathan 填 key 后跑 `npm run eval:live`。不要自己跑。

### M7 打包交付
**M7-1 打包和说明**：`mac/build.sh --install` 能装；应用里设置页写的 key 存在 `~/Library/Application Support/UYI Memory Lab/.env`；写 `README.md`（安装、填 key、跑 demo 的 5 步，以及“三个 demo 怎么看”：红杯子、灯塔、新衣服；信任三件套：是玲不是林、请忘了那件事、保守秘密）。验收：Jonathan 手测。

**M7-2 导入造物台模型**（Jonathan 已确认要做）：在上帝面板给物件/角色“换成 GLB”（选本机 .glb 文件上传），文件存到数据目录 `assets/<存档id>/<物件或角色id>.glb`，3D 栏用 GLTFLoader 加载，按基本体的高度等比缩放、脚底对齐地面，替换基本体；换模型只影响显示，不进账本。验收：用造物台导出的任意一个人物 GLB 替换玲，能看到并跟着走动。

---

## 11. Jonathan 已确认（2026-10-24）

1. 模型：用我们现在调用的默认模型 DeepSeek V4.1 Flash 1017。`.env.example` 默认 `LLM_MODEL=deepseek-flash`（造物台已经在用的名字）；设置页「测试连接」要把接口返回的 `model` 字段显示出来，用来核对是不是 V4.1 Flash 1017；如果接口要求写全名，就在设置页改。
2. 内测角色说中文。
3. M7-2 导入造物台模型：要做。

---

## 12. 第二轮修复（2026-10-24，依据 `reports/uyi-memory-lab-claude-plan-20261024/给Claude的修改方案.md`）

本轮允许为下列任务改契约（schema / llm-output / 提示词），改动范围写在每个任务里。旧库靠 `lib/db.mjs` 按列名补列继续可用（`PRAGMA user_version` 保持 1，已有测试断言它）。已有断言不删不放宽，新增回归测试一律 mock + 临时库。

| 任务 | 对应 | 改什么 | 验收 |
|---|---|---|---|
| R1 | P1-01 | `llm_calls` 加 `finish_reason / stage(ok·network·http·json·shape) / logical_id / attempt / usage_known`；每次 HTTP 尝试一行；JSON 失败保留 usage；`finish_reason=length` 时加大 `max_tokens`（≤2000）重试；没有 usage 或价格显示「未计价」；费用页分逻辑调用与实际尝试。剧本面板监听只注册一次、运行中禁用；服务端按 `requestId` 去重。`scenario_runs` 加 `request_id`。 | `test/llm-diag.test.mjs`、`test/http.test.mjs` 去重用例；check + eval 全绿 |
| R2 | P0-01 | 回复上下文给「可感知实体：id｜名称｜位置｜可用动作」；宿主把唯一名称确定性映射成 id，重名拒绝；动作失败时不送达模型的成功台词，改送宿主生成的短句并记账实际送达内容；对比模式动作永不执行。 | `test/action-truth.test.mjs` |
| R3 | P0-02 | 上下文新增 `world`（近期世界事件）节，直接来自账本并经准入/感知过滤；自述里声称做过某事的，没有匹配的成功事件不存 active。 | `test/world-recall.test.mjs` |
| R4 | P0-03 | self / full / none / recent / transcript 都过准入；被忘掉的源 seq 持久化，重建缓存不能再收进来；删除扫描包含 self_canon；删除自述唯一来源后自述失效。 | `test/forget-scope.test.mjs` |
| R5 | P0-04 | 新表 `job_runs`（kind、seq 范围、尝试数、最后错误、状态）；失败 seq 重启后仍可恢复，`POST /api/jobs/retry` 幂等且重查忘掉/纠正。 | `test/jobs-recover.test.mjs` |
| R6 | P1-04 | 证据前有 不/没/别 等否定词时拒绝；引用按 save / character / kind 校验。 | `test/facts-semantics.test.mjs` |

状态（2026-10-24）：R1–R6 已完成，见 PROGRESS。兼容：`llm_calls` 新列、`scenario_runs.request_id` 由 `lib/db.mjs` 按列补齐；`forgotten_seqs`、`job_runs` 是新表，旧库打开时自动建。`self_canon.status` 新增 `no_event`、`forgotten`；`rejected_facts.reason` 新增 `negated`、`newer_value`；`char_said.payload.host_line` 标出宿主代说的“没成功”。

| R7 | P1-05 | 真实造物台 GLB 替换玲：上传前检查 glTF 2.0 结构并原子写入；加载失败提示且保留原样子；角色模型按脚尖转正面、走路转向。 | http 层 2 个坏文件测试；真 GLB 隔离副本手测 |
| R8 | P1-03 | 同一输入 + 同一世界快照（user_seq）组成一组：刷新/切角色/重开后恢复三路回复、送达句、动作建议与检查（对照只检查不执行）、错误、实际调用；对照栏改名「当前记忆方案 / 聊天原文（最多约 60k）/ 短上下文（最近六条）」，显示服务商报的输入 token（没有时标估算）和截断条数；剧本运行记录（重开仍在，每步带回复）、导出（代码/提示词/契约/剧本/场景版本哈希、去 key 的设置、实际模型、事件截止点、全部失败与调用）；新步骤 `review`（待人工判读，不算通过）；报告分开计 自动通过/失败/跳过/待判读，并列出每一步。 | `test/review.test.mjs`、http 层 1 个 |
| R9 | P1-02 | 三条完整体验路径（新剧本文件，原 7 个不动）+ 每条一个自然说法变体；sit 在 3D 里能看到；clean/look_at 只算一时的动作；主动提起按内容去重。契约改动：reply 的 `action` 可以是最多 3 个对象的数组；世界状态里物件多了 `on`（放在什么上）；`char_action.payload.held`（放下/递出的是什么）；`turns.rejected_json.unbacked`。 | 新剧本 mock 全过 + 真模型多轮（`test/paths.test.mjs`、`test/action-truth.test.mjs`） |

风格 judge（`prompts/judge.md`）：本轮**没有接入**评测流程。要用时：只在 eval:live 里可选开启，保存 judge 的输入、模型、规则和结果，分数只作辅助，不代替 `review` 步骤的人工判读。

