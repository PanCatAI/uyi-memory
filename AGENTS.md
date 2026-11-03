# UYI 记忆插件（uyi-memory）· 给执行模型的规则

这是 UYI 3D 角色的记忆系统，做成给 UYI 桌面端集成的插件：Node 模块（`index.mjs`）+ 本机 HTTP 服务（`server/http.mjs`）。
内核来自记忆实验台（memory-lab）；设计和历史在 `docs/design/`，接入说明在 `docs/INTEGRATION.md`。

## 公开接口

- 桌面端只用 `index.mjs` 导出的方法和 `/v1` HTTP 接口。改它们的参数或返回值要同时改 `docs/INTEGRATION.md`、`test/plugin.test.mjs`，并在 PR 里写清楚是否破坏兼容。
- 破坏兼容的改动要把 `API_VERSION` 加 1，HTTP 路径换成 `/v2`，旧的保留一个版本。
- `lib/` 是内核，不对外承诺稳定。

## 技术栈（不要换）

- Node ≥ 22.21，纯 ESM（`.mjs`），HTTP 服务手写路由，不用 Express。
- 数据库只用 Node 自带的 `node:sqlite`（`DatabaseSync`）。不要装 better-sqlite3、Prisma、ORM。
- 调模型只用 `fetch` 调 OpenAI 兼容的 `/chat/completions`。不要装 openai、langchain、任何记忆框架。
- 没有运行时依赖，保持这样。
- 测试用 `node --test`。lint 装在 `tools/lint`。

## 契约文件（改之前先问）

这些文件是设计定下来的，代码要服从它们，不要为了让代码好写去改它们：

- `contracts/schema.sql`：数据库表。
- `contracts/events.mjs`：事件类型和校验。
- `contracts/llm-output.md`：模型每种调用必须返回的 JSON。
- `prompts/*.md`：提示词模板。
- `scenes/*.json`、`characters/*.md`、`scenarios/*.json`：样例场景、角色卡、测试剧本。
- 改契约前在 PR 里说明原因，等 Jonathan 同意。

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

- 不要把任何 API Key 写进代码、测试、文档、日志、提交或 HTTP 返回值。Key 只从桌面端传进来的 env 或 `.env` 读，要显示时只给 `mask()` 后的值。
- 不要在测试和开发里调付费接口。测试一律 `LLM_PROVIDER=mock`。真接口只在 `testConnection()` 和 Jonathan 手动跑的 `npm run eval:live`（需要 `LAB_ALLOW_PAID=1`）里调。
- HTTP 服务只听 `127.0.0.1`，不要改成 `0.0.0.0`。
- 不要一次重构多个模块；不要改任务没提到的文件；不要删测试、跳过测试或放宽断言。
- 不要把 `node_modules`、`data/`、`.env`、`dist/` 加进 git。

## 常用命令

```
npm test             # node --test，全部用 mock 模型和临时目录
npm run lint:setup   # 第一次跑 lint 前装一次
npm run check        # lint + test，每次交付前必须通过
npm run eval         # 用 mock 模型跑 scenarios/ 下所有剧本
npm run eval:live    # 用真模型跑剧本（只有 Jonathan 要求时跑，会花钱）
npm start            # 本机 HTTP 服务 http://127.0.0.1:4350
```

## Git

- 从 `main` 开分支，提 PR，不直接推 `main`。
- 提交信息：`<任务ID或范围> <一句话>`，例如 `facts: reject evidence not in source`。
- 不改写别人的历史。
