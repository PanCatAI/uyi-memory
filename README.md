# UYI 记忆插件（uyi-memory）

UYI 3D 角色的记忆系统，做成给 UYI 桌面端集成的插件。角色会记得用户说过的事、一起在房间里做过的事、自己不在用户身边时做过的事，在合适的时候自然地提起；用户可以查看、纠正、让她忘掉。

来自「记忆实验台」（memory-lab）：实验台里跑通、测过的记忆内核原样搬过来，去掉了实验台专用的 3D 网页、Mac 窗口壳和对比实验脚本，加了一层稳定的插件接口。

## 能做什么

- **记住用户**：从用户自己说的话和 3D 里真实发生的事里抽事实（证据必须是原文子串，模型自己说的不算），改口会更新，不会记两份。
- **共同经历**：对话和动作写成观察日志，攒多了压成经历，回到相关的物件或地方时会被想起。
- **你不在的时候**：离开 ≥ 2 小时回来，角色补上离屏做过的 1–3 件事。
- **主动提起，有节制**：5 条规则 + 冷却，只有真送达的回复才算「提起过」。
- **约定**：「明天陪我…」记成约定，到期会记得。
- **忘记**：「别再提 / 忘掉 / 删除」三档，从事实、经历、摘要一路传播；删除后全库搜不到原文。
- **秘密不外传**：每个角色只知道自己看到、听到的；隔墙只知道「说了几句话」。
- **关系**：熟悉度、亲近、信任由事件确定性计算，不靠模型。

## 怎么接

两种方式，接口完全一样：

- **Node 模块**（Electron 主进程）：`createMemory({ dataDir, getEnv })`，见 `examples/electron-main.mjs`。
- **本机 HTTP 服务**（Tauri / Unity / 原生）：`node bin/uyi-memory.mjs serve`，见 `examples/http-quickstart.sh`。

接入步骤、场景格式、每个时机调什么、HTTP 接口表：**[docs/INTEGRATION.md](docs/INTEGRATION.md)**。

```js
import { createMemory } from '@pancat/uyi-memory';
const mem = await createMemory({ dataDir, getEnv: () => ({ LLM_PROVIDER: 'openai_compat', LLM_API_KEY: key }) });
const space = mem.createSpace({ name: '我的房间', userName: '小林', scene });
await mem.openSession(space.id, { now: Date.now() });
const r = await mem.chat(space.id, 'rin', '这个红杯子是我奶奶留下的，帮我好好收着');
// 显示 r.say，3D 里播 r.action，然后：
mem.delivered(r.turnId);
```

## 开发

需要 Node 22.21 或更新（用到自带的 `node:sqlite`）。没有运行时依赖。

```
npm test             # 全部用假模型和临时目录，不花钱
npm run lint:setup   # 第一次跑 lint 前装一次
npm run check        # lint + test
npm run eval         # 假模型跑 scenarios/ 下全部剧本
npm run eval:live    # 真模型跑剧本（会花钱，要 .env 里有 Key）
npm start            # 本机 HTTP 服务，默认 http://127.0.0.1:4350，数据在 ~/.uyi-memory
```

模型设置见 `.env.example`（默认 DeepSeek，OpenAI 兼容接口都行）。

## 目录

```
index.mjs            插件公开接口（桌面端只用这里的）
server/http.mjs      本机 HTTP 服务（/v1）
bin/uyi-memory.mjs   启动 HTTP 服务的命令
lib/                 记忆内核（账本、仲裁、上下文、事实、观察、忘记…）
lib/memory/          记忆各模块
contracts/           数据库表、事件类型、模型输出格式（改之前先讨论）
prompts/             提示词模板
characters/ scenes/  样例角色卡和场景（测试和剧本用）
scenarios/           回归剧本（npm run eval）
examples/            接入示例
docs/INTEGRATION.md  接入说明
docs/design/         设计方案和评审记录（PLAN 1.0–4.0）
```

## 规则

给 AI 执行模型（Claude / Codex）的规则在 `AGENTS.md`。记忆系统的 7 条硬规则（账本只由宿主写、事实只能来自用户等）任何改动都要守。
