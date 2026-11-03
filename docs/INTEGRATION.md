# 在 UYI 桌面端接入记忆插件

这份是给桌面端同事看的：怎么把 `uyi-memory` 接进 UYI，桌面端要在什么时候调什么。

## 1. 选一种接法

| 桌面端是 | 推荐 | 怎么做 |
|---|---|---|
| Electron（主进程 Node ≥ 22.21，Electron 33+） | **Node 模块**，同进程 | `import { createMemory } from '@pancat/uyi-memory'`，见 `examples/electron-main.mjs` |
| Tauri / Unity / 原生 / 别的 | **本机 HTTP 服务**，子进程 | 打包一个 Node 22 运行时，启动 `node bin/uyi-memory.mjs serve --port 0 --data <目录>`，读 stdout 第一行 JSON 拿端口 |

两种接法的方法和参数完全一样，HTTP 接口就是把方法一对一搬到 `/v1/...`（见第 5 节）。

没有第三方依赖：数据库是 Node 自带的 `node:sqlite`，模型调用是 `fetch` 调 OpenAI 兼容接口（默认 DeepSeek）。

安装（私有仓库）：

```
npm install git+ssh://git@github.com/PanCatAI/uyi-memory.git#main
```

## 2. 几个概念

- **空间（space）**：一个场景 + 住在里面的角色 + 一个用户。一个用户的一个房间就是一个空间。所有记忆都按空间隔离，删空间就全删。
- **场景（scene）**：桌面端告诉插件「这里有什么」：房间（区域）、物件、可以送/摆的东西（palette）、角色和角色卡、角色能做的动作。格式见第 3 节，完整例子 `examples/room.scene.json`。
- **账本（ledger）**：发生过的一切，只追加。用户说的话、角色说的话、动作和结果、物件变化。记忆全部从账本推出来。**只有宿主能写账本**：模型说的话由插件记，模型要做的动作先过仲裁器检查，合法才记。
- **世界时钟**：每个空间一个，只能往前走。桌面端传真实时间进来（`syncClock` / `openSession({ now })` / `tick({ now })`）。时区目前固定 Asia/Tokyo（`lib/clock.mjs` 的 `ZONE`）。
- **会话（session）**：用户打开应用 = 开会话，关掉 = 关会话。离开 ≥ 2 小时再回来，角色会补上「你不在的时候」做了什么。

## 3. 场景格式

```jsonc
{
  "id": "my_room",
  "name": "我的房间",
  "rooms": [ { "id": "room", "name": "房间", "box": [-4, -4, 4, 4] } ],   // box = [minX, minZ, maxX, maxZ]（米），或 poly: [[x,z],...]
  "objects": [ { "id": "red_cup", "name": "红杯子", "room": "room", "pos": [1, 0.8, 0], "tags": ["portable"] } ],
  "palette": [ { "id": "new_scarf", "name": "新围巾", "tags": ["portable", "wearable"] } ],   // 用户能送/摆进来的东西
  "characters": [ { "id": "rin", "name": "玲", "room": "room", "pos": [0, 0, 1], "card_text": "# 玲\n\n## 设定（作者写的，永远优先）\n- ..." } ],
  "actions": { "pick_up": { "desc": "拿起同一房间里一个能拿的东西", "target": "object", "needs": ["same_room", "tag:portable", "hands_free"] } }
}
```

- id 只用字母、数字、`_`、`-`。所有 id（房间、物件、palette、角色）不能重复。
- `tags` 决定能做什么：`portable` 能拿、`surface` 能放东西、`sittable` 能坐、`wearable` 能穿戴、`switchable` 能开关、`cleanable` 能擦、`climbable` 能爬。
- 动作的 `target` 是 `room|object|user|none` 的组合；`needs` 是条件：`same_room`、`hands_free`、`holding`、`held_target`、`user_present`、`reachable`、`sitting`、`inside`、`tag:<标签>`。
- 角色卡是 markdown，写法见 `contracts/card.md` 和 `characters/*.md`。「设定」一节永远优先于模型自己编的。
- 物件挪了、新摆了家具、加了角色：整份调 `updateScene(spaceId, scene)`。记忆不受影响。

## 4. 桌面端在什么时候调什么

```
应用启动        createMemory({ dataDir, getEnv })
第一次进房间     createSpace({ name, userName, scene, now: Date.now() })   → 存下 space.id
打开/回到房间    openSession(spaceId, { now: Date.now() })      → events 里可能有「你不在的时候」她做的事，可以播出来
会话开着时       每 30–60 秒 tick(spaceId, { now: Date.now() }) → idle[].say 非空 = 她自己开口说话
用户说话        chat(spaceId, characterId, text)              → { say, action, used, turnId, forgetJob }
  · 显示 say；action 不为空就在 3D 里播（name / target / args，可能是最多 3 个的数组）
  · 显示/播完后调 delivered(turnId)（没送达的话不算「提起过」）
  · forgetJob 不为空 = 用户说了「忘了那件事」，弹确认卡 → confirmForget(job.id) / cancelForget(job.id)
用户在 3D 里做事  userAction(spaceId, { action: 'give'|'place'|'build'|'move_object', target, args })
  · give: args.to = 角色 id；place/build: args.room；move_object: args.room
3D 里别的变化    recordEvent(spaceId, { type: 'object_changed', actor: 'host', target: 'lamp', payload: { field: 'state.on', from: false, to: true } })
  · 能记的类型：user_action、char_action（带 outcome: ok|failed|interrupted）、char_moved、object_changed、object_created、object_removed、weather
  · 格式见 contracts/events.mjs
记忆面板         memory(spaceId, characterId)                   → facts / episodes / commitments / relationship，每条有 ref
  · 用户点「别再提 / 忘掉 / 删除」：proposeForget(spaceId, characterId, { verb: 'suppress'|'forget'|'delete', refs: [ref, ...] }) → confirmForget
  · 想连原话一起删，refs 里把原话的 ev:<seq> 也带上
关掉房间/退出    closeSession(spaceId)；退出前 await close()（等后台整理跑完）
```

几条要守的：

- **每个角色同一时间只跑一件事**：插件内部有队列，桌面端可以并发调，但同一角色的 `chat` 会排队。
- `chat` 大约是一次模型调用的时间（DeepSeek flash 1–3 秒）。抽事实、写观察这些在后台跑，不阻塞。
- 不想花钱：`LLM_PROVIDER=mock`，回复是 `（mock）收到：...`，记忆流程照常走。

## 5. HTTP 接口（`/v1`）

启动：`node bin/uyi-memory.mjs serve [--port 4350] [--data ~/.uyi-memory] [--env <.env>]`

- 只听 `127.0.0.1`。设了环境变量 `UYI_MEMORY_TOKEN` 就要带 `Authorization: Bearer <token>`（桌面端拉子进程时随机生成一个传进去）。
- stdout 第一行：`{"ready":true,"port":4350,"api":1,"version":"0.1.0"}`。`--port 0` 让系统挑空闲端口。
- 出错统一是 `{"error":{"code":"NO_SPACE","message":"没有这个空间：..."}}`，状态码 400/401/404/409/413。
- 改了 `.env` 发 `SIGHUP` 重新读，不用重启。

| 方法 | 路径 | 对应 | body / query |
|---|---|---|---|
| GET | `/v1/health` | — | |
| POST | `/v1/llm/test` | `testConnection()` | |
| GET | `/v1/spaces` | `listSpaces()` | |
| POST | `/v1/spaces` | `createSpace()` | `{ id?, name, userName, scene, features?, now? }` |
| GET | `/v1/spaces/:space` | `getSpace()` | |
| DELETE | `/v1/spaces/:space` | `deleteSpace()` | |
| PUT | `/v1/spaces/:space/scene` | `updateScene()` | `{ scene }` |
| PUT | `/v1/spaces/:space/features` | `setFeatures()` | `{ voice?, world?, ... }` |
| POST | `/v1/spaces/:space/clock` | `syncClock()` | `{ now }` |
| POST | `/v1/spaces/:space/session/open` | `openSession()` | `{ now? }` |
| POST | `/v1/spaces/:space/session/close` | `closeSession()` | |
| POST | `/v1/spaces/:space/tick` | `tick()` | `{ now? }` |
| POST | `/v1/spaces/:space/chat` | `chat()` | `{ character, text }` |
| POST | `/v1/turns/:turn/delivered` | `delivered()` | |
| GET | `/v1/turns/:turn` | `turn()`（调试：这一轮发给模型的每一节上下文） | |
| POST | `/v1/spaces/:space/user-action` | `userAction()` | `{ action, target, args }` |
| POST | `/v1/spaces/:space/events` | `recordEvent()` | 一条事件 |
| GET | `/v1/spaces/:space/events` | `events()` | `?after=&limit=&types=a,b` |
| GET | `/v1/spaces/:space/world` | `world()` | |
| GET | `/v1/spaces/:space/characters/:char/memory` | `memory()` | |
| POST | `/v1/spaces/:space/characters/:char/forget` | `proposeForget()` | `{ verb, refs, topic? }` |
| POST | `/v1/forget/:job/confirm` | `confirmForget()` | |
| POST | `/v1/forget/:job/cancel` | `cancelForget()` | |
| GET | `/v1/usage` | `usage()` | `?space=` |
| GET | `/v1/spaces/:space/job-errors` | `jobErrors()` | |

`examples/http-quickstart.sh` 用 curl 走一遍（假模型）。

## 6. 可选玩法开关（features）

记忆以外，内核里还有实验台做过的「营地」玩法，都在开关后面，**新空间默认全关**：

| 开关 | 是什么 |
|---|---|
| `voice` | 说话监测（口头禅重复、腔调漂移） |
| `world` | 天气、营地的量（柴、水、食物） |
| `director` | 意外和导演 |
| `topics` | 话头 |
| `scout` | 探路和地图 |
| `practices` | 共同活动和打赌 |

`world` 以下几项要场景带对应的规则文件（见 `scenes/camp.*.json` 和 `contracts/world.md`），桌面端场景一般用不上。

## 7. 现在的限制

- 提示词、角色卡、事实抽取规则都是**中文**。日本首发要做日文版提示词（`prompts/*.md`），这是下一步。
- 时区固定 Asia/Tokyo。
- 一个空间一个用户；多个用户共用一个空间还没做。
- 没有账号和云同步：数据全在本机 `dataDir` 的 `memory.sqlite`。要上云时，账本是唯一事实来源，同步账本即可重建其余一切。
- 动作只做了宿主仲裁和记账，没有寻路和动画：`chat` 返回的 `action` 要桌面端自己播。播放失败可以用 `recordEvent` 记一条 `char_action`（`outcome: 'failed'`）。
