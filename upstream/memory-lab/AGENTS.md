# 记忆实验台（memory-lab）· 给执行模型的规则

这是一个本机桌面应用，用来测 UYI 3D 角色的记忆系统：左边看 3D 场景，中间和角色聊天，右边看记忆内部。
它和造物台（`3Dgen/studio`）是同一种做法：Node 本地服务 + 网页前端 + Mac 窗口壳。

## 每次开工先做这三步

1. 读 `docs/PROGRESS.md`，找到 `NEXT:` 那一行。
2. 在 `docs/PLAN.md` 里找到这个任务，只做这一个任务。
3. 做完跑这个任务写的「验收」命令。全部通过后更新 `PROGRESS.md`：把任务标成 `[x]`，写一句结果，把 `NEXT:` 改成下一个任务。然后停下。

遇到 PLAN 没写清楚的地方不要猜。在 `PROGRESS.md` 的 `## 待确认` 下面写一条问题，跳到下一个不依赖它的任务。

## 技术栈（不要换）

- Node ≥ 22.21，纯 ESM（`.mjs`），`server.mjs` 手写路由，不用 Express。
- 数据库只用 Node 自带的 `node:sqlite`（`DatabaseSync`）。不要装 better-sqlite3、Prisma、ORM。
- 前端是原生 JS + three.js 0.180，没有打包工具，没有 React。three 从 `/vendor/three/` 提供，用 importmap。
- 调模型只用 `fetch` 调 OpenAI 兼容的 `/chat/completions`。不要装 openai、langchain、任何记忆框架。
- 测试用 `node --test`。lint 装在 `tools/lint`，和造物台一样。
- Mac 窗口壳是 Swift + WKWebView（`mac/LabApp.swift`），从造物台的 `studio/mac/StudioApp.swift` 删改而来。

## 契约文件（改之前必须先在 `## 待确认` 里问）

这些文件是设计定下来的，代码要服从它们，不要为了让代码好写去改它们：

- `contracts/schema.sql`：数据库表。
- `contracts/events.mjs`：事件类型和校验。
- `contracts/llm-output.md`：模型每种调用必须返回的 JSON。
- `prompts/*.md`：提示词模板。
- `scenes/*.json`、`characters/*.md`、`scenarios/*.json`：样例场景、角色卡、测试剧本。

可以加新的剧本和场景。已有剧本里的断言不要放宽。

## 记忆系统的硬规则（写代码时每条都要守）

1. **世界账本只由宿主写。** 只有 `lib/ledger.mjs` 的 `appendEvent()` 能往 `events` 表插数据。模型的输出永远不直接写进账本；模型说的话由宿主记成 `char_said`，模型要做的动作先经过 `lib/arbiter.mjs` 检查，合法才由宿主执行并记账。
2. **事件头不可改。** `events` 表只允许 UPDATE `payload_json` 和 `tombstone_json` 两列（删除记录时）。其它列一律不改。
3. **用户事实只能来自用户自己说的话或宿主记录的结果。** 来源是 `char_said` 的候选事实一律拒绝。每条事实的 `evidence` 必须是来源原文的一个子串，否则拒绝。
4. **模型写的叙述都是缓存。** 观察日志、经历摘要、关系卡以外的所有模型生成文字都存在 `caches` 表，带 `derived_from`。来源被纠正或忘掉时，缓存作废并重建。
5. **关系卡是确定性计算。** `lib/relationship.mjs` 只读事件做折叠，不调模型。
6. **时间只从注入的时钟拿。** `lib/` 下面不许出现 `Date.now()` 或不带参数的 `new Date()`，统一用 `clock.now(saveId)`。lint 会检查。
7. **每个角色同一时间只跑一件事。** 回复、离屏补完、主动提起都要经过 `lib/arbiter.mjs` 的角色队列。

## 绝对不要

- 不要把任何 API Key 写进代码、测试、文档、日志、提交或返回给浏览器的 JSON。Key 只从 `.env` 读（应用里是 `~/Library/Application Support/UYI Memory Lab/.env`）。返回给浏览器时只给 `mask()` 后的值。
- 不要在测试和开发里调付费接口。测试一律 `LLM_PROVIDER=mock`。只有两处可以调真接口：设置页的「测试连接」按钮，和 Jonathan 手动跑的 `npm run eval:live`（需要 `LAB_ALLOW_PAID=1`）。
- 不要读写造物台的任何目录，不要连 4320、4321 端口。本应用用 4340 起的端口。
- 不要一次重构多个模块；不要改任务没提到的文件；不要删测试、跳过测试或放宽断言。
- 不要把 `node_modules`、`data/`、`.env`、`dist/` 加进 git。

## 常用命令

```
npm start            # 开发：http://127.0.0.1:4340
npm test             # node --test，全部用 mock 模型和临时目录
npm run lint:setup   # 第一次跑 lint 前装一次
npm run check        # lint + test，每个任务交付前必须通过
npm run eval         # 用 mock 模型跑 scenarios/ 下所有剧本
npm run eval:live    # 用真模型跑剧本（只有 Jonathan 要求时跑，会花钱）
mac/build.sh         # 打包 dist/记忆实验台.app；--install 装到 ~/Applications
```

## Git

- 仓库根目录在 `LLM_BrainMesh`，里面有很多别人的改动。只 `git add` 你这次改的 `3Dgen/memory-lab/...` 路径，不要 `git add -A`、`git add .`。
- 提交信息：`<任务ID> <一句话>`，例如 `M1-3 ledger appendEvent with validation`。
- 不 push，不改写历史，不切换别人的分支。
