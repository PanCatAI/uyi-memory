# 记忆实验台进度

NEXT: 第二轮修复已完成（PLAN §12）；剩余见「R 未做」；M0-2（Jonathan 在 Mac 上：`npm ci`、`npm run lint:setup`、`mac/build.sh --install`，然后按 README 手测）

规则：一次只做 NEXT 指向的一个任务。做完跑验收，把任务标 `[x]` 并写一句结果，把 NEXT 改成下一个，然后停下。

## M0 骨架
- [x] M0-1 项目骨架：package/脚本/lint 配置/.env.example 就位，`npm run check` 通过
- [ ] M0-2 Mac 窗口壳

## M1 存储与账本
- [x] M1-1 lib/db.mjs：node:sqlite + 嵌套事务
- [x] M1-2 lib/clock.mjs + lib/ids.mjs：注入时钟，世界从 10月20日 周二 09:00 开始
- [x] M1-3 lib/scene.mjs + lib/saves.mjs：场景/角色卡加载与校验，存档增删
- [x] M1-4 lib/world.mjs：世界状态由事件纯折叠得到
- [x] M1-5 lib/perception.mjs：按房间感知，隔墙只知道“说了几句话”
- [x] M1-6 lib/ledger.mjs：只由宿主写，事件头有触发器保护

## M2 模型层
- [x] M2-1 lib/env.mjs + lib/tokens.mjs：.env 读写（600 权限）+ token 估算
- [x] M2-2 lib/prompts.mjs：模板缺变量直接报错
- [x] M2-3 lib/llm-mock.mjs：按契约的 mock 规则
- [x] M2-4 lib/llm.mjs：OpenAI 兼容 fetch，429/5xx 重试一次，调用记账、Key 打码

## M3 一轮对话
- [x] M3-1 lib/arbiter.mjs：动作合法性检查，失败也记账
- [x] M3-2 style + context 骨架：系统提示固定可缓存，变化部分分节
- [x] M3-3 lib/turn.mjs + 会话/时间：一轮对话 + 会话/时间推进
- [x] M3-4 HTTP 接口第一批：存档/会话/聊天/账本接口

## M4 记忆
- [x] M4-1 relationship：关系卡纯计算
- [x] M4-2 jobs + facts + commitments + sensitive：事实 6 条拒绝规则、单值取代、纠正升代
- [x] M4-3 observe + reflect：8 条事件写观察，超 1500 token 压成经历
- [x] M4-4 admission + context 其余节：别再提/忘掉过滤进上下文
- [x] M4-5 proactive + 送达回执：5 条规则、冷却、送达回执才算提起
- [x] M4-6 catchup：离开 ≥2 小时补 1–3 个离屏动作
- [x] M4-7 selfcanon：和角色卡冲突的自述标出来
- [x] M4-8 forget：提议→确认→执行→重建→报告；删除后全库搜不到原文
- [x] M4-9 HTTP 接口第二批：记忆/轮次/忘记/设置/费用/剧本接口

## M5 界面
- [x] M5-1 布局 + 顶栏 + 聊天栏：三栏布局、顶栏、聊天栏（刷新后从账本恢复对话）
- [x] M5-2 3D 栏：基本体场景、角色走动、气泡、点选过滤账本
- [x] M5-3 右栏记忆内部：8 个页签：本轮上下文/事实/经历/约定/关系/账本/忘记/费用
- [x] M5-4 对比、忘记卡片、设置、费用：对比三栏、忘记确认卡、设置（测试连接显示实际模型）、费用；Chromium 里点过一遍无报错。Mac 窗口里待 Jonathan 手测

## M6 剧本与评测
- [x] M6-1 scenarios + eval（7 个剧本 mock 全过）：7 个剧本 mock 全过，G1–G5 不变量每轮检查
- [x] M6-2 剧本界面：剧本面板：假/真模型、整跑、单步、打开存档
- [x] M6-3 eval:live 报告格式（Jonathan 来跑）：`npm run eval:live` 写 data/reports/eval-*.md（未跑，等 Jonathan）

## M7 打包交付
- [x] M7-1 打包 + README：README 写好；`mac/build.sh --install` 待 Jonathan 在 Mac 上跑
- [x] M7-2 导入造物台模型（Jonathan 已确认要做）：上帝面板选角色/物件换 .glb，存 data/assets/<存档>/，只影响显示；用 three 导出的 GLB 在 Chromium 里验证过。造物台人物 GLB 待 Jonathan 手测

## R 第二轮修复（PLAN §12）
- [x] R1 P1-01 调用诊断与单次运行：每次尝试一行（stage/finish_reason/logical_id/attempt/usage_known），JSON 失败保留 usage，截断时加大 max_tokens（≤2000），未计价不显示 0；剧本面板监听只注册一次、运行中禁用，服务端按 requestId 去重。新增 12 个测试（83 个全过），eval 7/7。真模型：发现 observe 截断是思考模型把 max_tokens 全花在推理上（正文 0 字），见待确认。
- [x] R2 P0-01 动作与台词一致：「现在」节给实体表 id｜名称｜位置｜现在能做的动作；宿主唯一名称→id，重名拒绝；动作没做成时不送达模型原句，送达「我想…，可是没成功：原因」并记账（原句存 rejected.withheld）；对照动作不执行。新增 8 个测试。真模型：走到灯塔/戴围巾/爬楼梯全部和台词一致，回复 1 次尝试、1.1–2.8 秒。
- [x] R3 P0-02 真实经历进记忆：新增 world 节（账本直出最近 12 件动作/变化，带成功/失败和用户在场/离屏，过准入和感知）；声称做过某事的自述没有对应成功事件时存 no_event。新增 2 个测试（observe 全程故障注入）。真模型：隔天能说清离屏捡贝壳、坐长椅，没感知到的搭楼梯不乱说。
- [x] R4 P0-03 遗忘统一生效：新表 forgotten_seqs（按角色记被忘经历的来源，含同一来回的回复）；self/full/none/recent/transcript/overheard/观察重建全部走准入；晚到的观察/压缩结果写入前复查；删除扫描含 self_canon，删除/忘掉唯一来源的自述随之删除/失效；删除一条经历会连同它的原始来回一起删。新增 8 个测试（含重启后不复活）。真模型：忘掉「学做桂花糕」→ 真模型重建后不再出现，追问时说不知道。
- [x] R5 P0-04 后台失败可恢复：新表 job_runs（kind、seq 范围、尝试数、最后错误、状态）；抽事实失败次数持久化，3 次后跳过但可补跑；`GET /api/jobs`、`POST /api/jobs/retry` 幂等，补跑前复查忘掉/删除，旧句不覆盖更新的单值纠正（newer_value）；费用页列出后台任务和补跑按钮。新增 5 个测试。真模型：本地注入 503 让两句抽取失败 → 重启 → 补跑成功抽出 名字/工作/喜欢 各一次，再补跑无事发生。
- [x] R6 P1-04 否定与引用作用域：证据前紧挨 不/没/别 等、或正向谓词的证据自身否定动词时拒收（negated），宾语自己带否定的（plan:不去灯塔）保留；忘记的 refs 校验 存档/角色/类型/存在，apply 只改本存档本角色。新增 4 个测试（含冻结的陷阱集）。真模型：不喜欢香菜→dislikes，没有养猫→state，没有误记成 likes/owns；live 里发现的误拒已修并入陷阱集。

- [x] R7 P1-05 真实造物台 GLB：用造物台「岚 · 探索者 · 动作」（3Dgen/mocap-local-2026-10-21/preview/lan.glb 的只读副本，Tripo 骨架）在应用数据的隔离副本里替换玲：高 1.6 米、脚踩地面；新增按脚尖朝向自动转正面、走路时转向行走方向；能跟着真模型的 walk_to 走到海滩；重启后模型还在、对话接得上；阿乔的记忆不变；账本和记忆里没有「换了人设/外观」。上传前检查 GLB 结构（版本、长度、JSON、二进制段、数据引用、顶点格式），先写临时文件再改名，坏文件给中文原因、不覆盖原模型；浏览器里加载失败时弹提示并保留原样子。新增 2 个接口测试，已重打包安装（源码与安装包 62 个文件哈希一致）。
- [x] R8 P1-03 回看与评测口径：turn group（同一输入同一世界快照）重载后恢复三路回复/动作与检查/错误/实际调用；对照栏改名并显示实际输入 token 和截断；剧本运行记录重开仍在、每步带回复、可导出（版本哈希、去 key 设置、实际模型、事件截止点、失败）；`review` 步骤待人工判读；报告分开计数并列出每一步。风格 judge 没接，PLAN 里写明。新增 5 个测试。
- [x] R9 P1-02 三条完整体验路径：新增 6 个剧本（path-lighthouse / path-scarf / path-red-cup 各一条 + 自然说法变体），原 7 个不动；一轮最多 3 个连续动作（先走过去再放下），逐步检查，遇到做不成的就停；已经是这样的（再放一次、再戴一次）算没事可做，不算失败；物件记住放在什么上（「红杯子｜小屋，放在衣柜上」），事件写成「把红杯子放到了衣柜上」；台词说做完了（戴上了/一直戴着/放在衣柜上/爬到一半…）却没做，带宿主提示重问一次；坐下在 3D 里能看到（坐到座位上、矮一截、名字带「坐着」）；擦/看/挥手标成一时的动作；主动提起按内容去重，回到老地方优先提真发生过的事；「别再提我奶奶」去掉人称再匹配；动作类型不对时说人话。新增 13 个测试（134 个全过），mock 13/13；真模型 6 条路径跑了 6 轮（全部留档），最后一次全量 eval:live 13 个过 8 个。
- R 未做（不在这次范围）：骨骼动画（GLB 里带 idle/walk/run 动作，现在只显示静止 A 姿势）；忘记确认卡的自然语言预览（P0-03 的 UI 部分）；一轮只能做一个动作（灯塔剧本真模型因此来不及点灯）。

## 待确认
- （已解决：Jonathan 2026-10-24 在设置里加了额外参数）（R1 发现）当前模型 `deepseek-flash` 默认开思考：observe 调用 600/1200/2000 token 全是 reasoning_tokens、正文为空，所以经历一直写不出来。实测加 `LLM_EXTRA_BODY={"thinking":{"type":"disabled"}}` 后 236 token 正常出 JSON。要不要在设置里加上（至少后台用途）？这是 Jonathan 的配置，没有改。
- （暂无。PLAN §11 的三条 Jonathan 已在 2026-10-24 回答）

## 记录
- 2026-10-24 方案、契约、提示词、场景、角色卡、7 个剧本写好（Claude 高推理档）。
- 2026-10-24 Claude 一口气做完 M0-1 到 M7-2 的代码：`npm run check` 71 个测试全过、lint 干净，`npm run eval` 7 个剧本 mock 全过。没在 Mac 上跑过的：M0-2 窗口壳打包、M7-1 安装、真模型（eval:live 和测试连接）。
- 2026-10-24 第二轮修复 R1–R6（Claude）：`npm run check` 110 个测试全过（原 71 个未删未改断言），`npm run eval` 7/7。`npm run eval:live`（关思考后）5/7 通过，85 次逻辑调用 = 85 次实际尝试、0 失败，报告 `data/reports/eval-2026-10-24-11-12.md`；上次 3/7、118 次。没过的：灯塔（一轮一个动作，3 句内没走到点灯；没有谎称点了灯）、trust-forget（真模型没把“跟前任吵架”抽成 state 事实）。定向真模型记录在 `reports/uyi-memory-lab-fixes-20261024/live/`。


## 2.0（PLAN-2.0.md，Jonathan 2026-10-24 开工）

NEXT-2.0: D-gate（代码和真模型验收都完成；等 Jonathan：C 关的 Mac 检查、3 条 review 判读、D7 结果页、连续 3 天每天 15 分钟试玩并写一句感受）

规则同上：一次一个任务。2.0 的过关只看 S1、S2 两个剧本；旧的 13 个剧本当回归，继续要求全过。

### B 把人写活
- [x] B1 角色卡 2.0 契约和解析器：contracts/card.md + lib/card.mjs（16 节 + 元信息，作息覆盖 24 小时校验，错误带行号），scene.mjs 改用它；岚卡 characters/lan.md 照附录 A 写入（B2 的一部分提前做，B1 测试要用）。新增 13 个测试，旧卡 canon 与改动前逐字一致。
- [x] B2 岚的卡和方块营地场景：scenes/camp.json（造物台 id，4 个区域：篝火边/物资角/小路是 poly、同属 open 组，帐篷是带墙的 box）；scene.mjs 加 roomBox/inRoom/sameArea，validateScene 认 poly/exit_to/leads_to；感知、user_present、perceivable、上下文「用户在附近」按组判断，same_room 仍按区域；新动作 tend_fire/enter/leave/draw_map（新条件 sitting、inside，args.with 校验）；开局 worn_by、user_room；turn.mjs 与 scene3d 支持多边形并按地面大小取景。test/camp.test.mjs 5 组；152 测试全过，13 个旧剧本全绿。
- [x] B3 回复上下文用上新卡：2.0 卡按固定顺序渲染进系统提示（lib/card.mjs cardSystemText，岚约 684 token，上限 1400 超了报错不截断；旧卡原文不变）；新 lib/memory/lore.mjs 关键词选过往（刚说 ×2、最近 4 句 ×1、按关系阶段放行、最多 3 条、300 token）；新节 lore / mood / reminder，relationship 末行加成长弧；full、none 加 mood、reminder 不加 lore。turn 先把合法 mood 存进 output（B4 补 thought 和提示词）。test/context-card.test.mjs 4 组；156 测试全过，13 剧本全绿。
- [x] B4 先想后说：回复 JSON 加 thought（最前、截 40 字）和 mood（须是卡里情绪名，否则默认情绪）；thought 只存新列 turns.thought（schema + 迁移），右栏灰色「内心」，不进账本/事实/观察/自述/output_json/后续上下文；系统提示列出本卡情绪名。test/thought.test.mjs 3 组（5 轮 + 等后台后 THOUGHT_MARK_7 只在 turns.thought；旧格式照常）。
- [x] B5 设定页：新表 card_versions（版本 0 = 文件，保存/恢复都追加）、turns.card_version；lib/cards.mjs（B1 解析 + 1400 token 上限，设定变了重判自述冲突）；lab.scene 按存档套用最新版本；接口 GET/PUT …/characters/:char/card、GET …/card/versions、POST …/card/restore（坏卡 400 带行号）；右栏第 9 个页签「设定」每节一个框、错误标在对应框下、旧版本只读可恢复；运行记录导出带每张卡的版本和哈希。http 测试 + test/cards.test.mjs；Chromium 点一遍无页面错误（截图 data/reports/b5-settings*.png）。161 测试全过。
- [x] B6 一键起草：prompts/card-draft.md（附录 A 格式 + 场景 id 和动作清单）、lib/cards.mjs draftCard（后台模型，过 B1 解析，失败带错误重试一次，再失败把原文和错误交回）、POST /api/cards/draft、设定页「一键起草」只填框不保存。mock 测试：草稿可解析；先坏后好正好 2 次调用；两次都坏返回原文 + 行号错误；不改版本。**待真模型**：岚 brief +「急性子的女绘图员，师父失踪了」起草样例存 data/reports/card-draft-sample.md（API Key 在 Mac 应用目录里，和 B7/B8 的真模型步骤一起在 Mac 上跑）。
- [x] B7 剧本 S1「铜羽短剑」（mock 部分）：scenarios/s1-sword.json 按第 7 节写；新断言 lore_in_context / lore_not_in_context / thought_not_stored / mood_is，新步骤 pending（第 10 步 set_relationship_floor 和 lore_harbor 断言标「待 D5」）；advance 支持「18:00」（推进到下一个 18:00）；eval 单独列「待后续任务」。mock：断言通过 12、失败 0、仅真模型 3、待人工判读 2、待后续 2；13 个旧剧本全绿。**待真模型**跑一次。
- [x] B8 盲评工具：scripts/card-ab.mjs + test/fixtures/card-ab-inputs.json（附录 C 六类各 5 句）+ npm run card-ab / card-ab:live。旧卡 = thinCard（设定 + 说话方式一段 + 禁止，存成该存档的卡版本），每句两个全新存档、同一状态（营地 18:00 会话开着）。页面随机左右、选择存浏览器、选完才显示新卡胜场、一键导出 JSON。mock 生成 + Chromium 点完 30 题、导出、刷新后保留均通过。**待真模型 + Jonathan 判（过关线 ≥18/30）**。
- [x] B9 漂移检测：scripts/drift.mjs + prompts/ooc-judge.md + test/fixtures/drift-inputs.json（100 句，任务型 30）+ npm run drift / drift:live；设置新增「裁判模型」LLM_MODEL_JUDGE（须与对话模型不同，留空跳过打分）。每 20 轮一个窗口统计口头习惯率、平均句长、绝不说命中、裁判分；不达标自动加一行提醒再跑一次并列出两次结果。mock 跑通。**待真模型**。另加 npm run draft-sample:live 补 B6 的真模型样例。

### C 住进营地
- [x] C1 从造物台导入场景和人物：lib/studio-import.mjs（fetchState / catalog / buildScene 纯映射 / importStudio）+ GET /api/studio/catalog、POST /api/saves/:id/import-studio + 顶栏「从造物台导入」（默认新建营地存档，当前是营地存档时可导入到当前）+ 设置里「造物台端口」STUDIO_PORT（默认 4320；测试用 LAB_STUDIO_URL）。存档专属场景 data/saves/<存档>/scene.json（lab.sceneFile，按文件 mtime 缓存，删存档一并删），文件在 data/assets/<存档>/studio/，GET /api/assets/<存档>/studio/<文件> 取。新事件 scene_imported；同一份布局再导入不写文件、不记事件。测试 test/studio-import.test.mjs 7 组（映射表逐条、filler 不进世界、导入两次相同、动作库 SHA256 不符拒绝、第三张长凳新物件、HTTP 全流程只发 GET、造物台没开 400「请先打开造物台」）；172 测试全过，14 剧本全绿。**待 Jonathan**：打开造物台后点一次导入（约 81MB、16 个文件），截图存 data/reports/。
  - 造物台 URL 规则（asset-forge/server.mjs）：`GET /api/state` → `{assets, models, animations, …}`；模型 `GET /files/models/<models[].file>`；动作库 `GET /files/anims/<animations[].file>`（animations 自带 sha256，下载后核对）；场景布局在 `assets[].layout`（`envModelId`、`items`、`updatedAt`），规格在 `assets[].layoutSpec`（zones/paths/objects）。
  - 选的做法：区域——篝火边 = walkable 多边形在物资角北沿（z=-1）和小路起点（z=2.55）处切开；物资角沿用 B2 固定多边形；帐篷 = 规格里 enter 物件的占地；小路 = entry-path 点的包围盒左右各加 0.6 米。坐点朝向 = 物件本地 ±x/±z 中最朝篝火的那个（实测三张凳得到 70°/290°/180°，和规格一致）。interaction:pickup → portable（提灯）。人物 = 名字以角色名开头的造物台人物资产（岚 · 探索者），对话框可选。动作库只取 seedKey 以 UAL 开头的 GLB。另外的人物摆件（银羽）跳过。**偏离**：filler 的 6 个模型也下载了（只进 scene.studio.decor 显示，不进世界状态），否则 C3 没法「营地显示完整」。
- [x] C2 再导入时写成「你搭的」事件：已导入过的存档再导入时，存档 scene.json 的 objects 保留第一次导入（起始世界），和当前世界状态比，新增 / 撤走 / 挪动 >0.3 米的造物台物件各写一条 world_edit {op, object, by:'creator', from?, to?}（actor user，拿在手里或戴着的不动；add 带整个物件定义，world.mjs 折叠时建出来）。当时感知：会话开着且同一片空地才在 perceivers 里；没看到的，等岚和它同处一片区域时算「发现」（perception.discovered，准入、world 节、hints 都认），world 节写「篝火边多了原木长凳，之前没有（你不在的时候出现的）」；在带墙的帐篷里不知道。新主动规则 new_thing：同区域、从没提过（mentions 不限时间）的 world_edit add。测试 4 组（第三张长凳 → 一条 add、world 节含长凳、hints 有 new_thing、送达后 7 轮不再出现；会话关着时导入→之后看到才知道；帐篷里不知道；挪 0.5 米算 move、0.1 米不算、删掉的算 remove、同布局再导入无变化）。176 测试全过，14 剧本全绿。
- [x] C3 3D 栏换成真场景和带动画的岚：public/vendor/forge/（retarget.js、foot-grounding.js、splice.js 复制自 asset-forge 7ef1af2，文件头已注明）；新 public/character-rig.js（按状态名播片段，第一次用时 retargetClip 烘焙，inPlace + 着地，0.3 秒淡入淡出，缺片段退 Idle_Loop 并提示一次「缺少片段 X」到控制台、提示条和账本页顶部）；scenes/clips.json 按附录 B（UAL 里没有 Wave，挥手备选加了 Interact）；GET /api/clips。scene3d：有 scene.studio 的存档载入环境 mesh、物件模型（按布局的 rot/scale 原样摆）、filler 摆件、黄昏灯光（造物台 dusk 预设）、篝火/提灯点光源；岚用造物台模型（左手朝 +x 定朝向，身高 1.2–2.2 米保持原尺寸），站着 Idle_Loop、说话 Idle_Talking_Loop / Sitting_Talking_Loop、坐下 Sitting_Enter → Sitting_Idle_Loop 并朝凳子朝向、拿着的东西挂右手骨骼。顺手修了切存档后旧标签留在页面上的老问题。验证：Mac 上只读下载了造物台 16 个真文件（81MB，放在 3Dgen/memory-lab-studio-cache/），容器里用假造物台提供这些文件跑真导入 → Chromium 截图营地完整、岚站在篝火西侧播 Idle_Loop、脚着地，切到小岛存档仍是方块（截图在项目文件 memory-lab/reports/c3-*.png）。软件渲染下 1–2 帧/秒，不代表真机；**待 Jonathan** 在 Mac Air 上看帧率（≥30）。
- [x] C4 走路、坐下、进帐篷在 3D 里看得到：新 lib/nav.mjs（可走 = 有 group 的区域并集减去物件占地外扩 0.25 米；占地来自造物台 collision box/trunk，导入时按物件旋转算成相对 4 角存在 footprint，trunk 取 0.4 米见方；节点 = 障碍角、区域角；采样 5 厘米判通行，路的首尾 0.3 米可在区域外；A* 最短折线；找不到路直线走、ok:false 并在服务端日志打一行 [nav]）。站位点 = 物件占地外 0.6 米、四个方向里能走且离起点最近的那个；帐篷没有碰撞占地，用它通向的帐篷区域当大小，门口取最靠篝火的一边（-0.2, -0.5）。arbiter.actionEvents 给导入营地里 walk_to/sit/pick_up/put_down/tend_fire/enter/clean/switch 的 char_action 带 payload.path，leave 带门口一点；world 折叠时角色停在路的终点。前端 scene3d.play(events)：按顺序 1.2 米/秒沿路走（Walk_Loop、转向前进方向），sit 转到凳子朝向后 Sitting_Enter → Sitting_Idle_Loop，enter 走到门口后隐藏、leave 在门口出现，pick_up/tend_fire/wave 播对应片段，一轮最多 3 个依次播，播完再套最终世界状态。再导入时 scene.json 的物件保留位置和状态、更新模型和占地。服务器加了只在 LAB_DEV_MOCK=1 时出现的 POST /api/dev/mock（浏览器测试排队假模型回复）。test/nav.test.mjs 5 组（帐篷口到东边长凳绕开篝火和木箱、不可达直线、sit/enter/leave 路径与终点、旧场景无路径）。Chromium：对岚说「去长凳上坐会儿吧」（假模型回 sit log-bench-2）→ 走过去、坐到东边长凳朝篝火（截图 memory-lab/reports/c4-walk.png、c4-sit.png）。181 测试全过，14 剧本全绿。
- [x] C5 环境信号进对话：新 lib/environment.mjs（只对场景标了 outdoor 的生效，camp.json 已标；旧小岛不变）。天色按世界时间（清晨 05–08 / 白天 08–17 / 黄昏 17–19 / 夜里 19–05）；天气 = 存档 id + 世界日（05:00 换日）的 FNV 哈希取 晴/阴/小雨/起雾，同存档同一天永远一样；宿主在会话开始（离屏补完之后）和每轮开头调 environment.tick：当天还没记就写一条 weather {kind, day}，点着的篝火离上次 tend_fire（导入时就点着的，从存档第一条事件算）满 3 小时写 fire_out（lit=false）。**选的做法**：一次推进跨过好几天时只记当天的天气，不补写中间每天；事件时间取 tick 时的「现在」（账本时间只能往前）。now 节加「天色 / 天气 / 篝火：烧着|灭了」三行；新主动规则 fire_out_night（夜里、岚看到灭了的那堆火，最低优先级）。/api/state 带 env；3D 按天色切 4 套灯光（白天/黄昏/夜里 = 造物台 default/dusk/night，清晨自配），起雾/阴/小雨加雾、阴雨减日光；**雨线粒子没做**（规格写可选）。旧导入存档要再导入一次才带 outdoor。test/environment.test.mjs 3 组（天色与换日、天气确定性；每天一条 weather 且 now 节三行；tend_fire 后 2 小时不灭、到夜里一条 fire_out、灭了的火成为 hints）。184 测试全过，14 剧本全绿。夜里截图 memory-lab/reports/c5-night.png。
- [x] C6 剧本 S2 第 1–2 段跑在导入的营地里：剧本新步骤 import_studio: n / studio_edit: n（实验台没有 savesDir 时建临时目录、用 lib/studio-fixture.mjs 的假造物台，不连真造物台）；新断言 room_of、path_ok（上一轮之后带路径的 char_action 全程不穿障碍）、commitment（角色、状态、文本、到期、归属）。scenarios/s2-cup.json：第 1 段导入→18:00 送杯子→母亲的事实→岚拿着杯子→周四守夜的约定→坐到 log-bench-1（path_ok + room_of）；第 2 段造物台加长凳 log-bench-3 再导入→world_edit add→第二天 18:00 问「今天营地有什么变化吗？」→world 节含 长凳、hint_rule new_thing、真模型判读、thought_not_stored。**选的做法**：S1 第一步也改成 import_studio（跑在导入营地里）；到期支持「周四」「周四 18:00」（下一个周四，不含今天，默认 09:00），prompts/facts.md 与 contracts/llm-output.md 同步；new_thing 提到主动规则最高优先级（不然新长凳被别的提示挤掉）；nav 导出 pathClear。186 测试全过，15 剧本全绿（s1 12 条、s2 10 条断言）。真模型（deepseek-flash，Mac）：第一次 S1 差 self 节（她讲了短剑来历但 self_claims 空）、S2 差「妈」的事实（断言多限了谓词，计划里不限）；改了 reply 提示（讲出口的过往也填 self_claims、写成能单独看懂的一句）、facts 提示（东西的意义 → relation_to_object）、S2 断言按计划不限谓词；第二次 S1 15 条、S2 11 条全过，0 失败，报告 data/reports/eval-2026-10-25-01-28.md。待判读：游泳那句「问这个干嘛。……不会。你也别提了」（回避、没提港口）；再问短剑补了「铜色布条、师父缠的」新细节，不矛盾。
- [x] C7 缓存命中率：llm.mjs 读 usage 里的 prompt_cache_hit_tokens（DeepSeek），没有再读 prompt_tokens_details.cached_tokens，都没有记「没报」。**选的做法**：cached_tokens 列原来是 NOT NULL DEFAULT 0，没去重建表，加了一列 cache_reported（1 = 服务商报了）表示 null；假模型一律算没报。/api/usage 按用途多给 cache_reported、cache_input（报了的那些调用的输入 token）；费用页列「输入 token / 其中命中缓存 / 命中率」，没报显示「服务商没报」，部分没报写「N 次没报」；eval:live 汇总行带命中率。新测试：DeepSeek / OpenAI 两种字段和没字段三种写库；test/cache.test.mjs 同一存档连续 10 轮系统提示 sha256 相同、卡版本不变，服务商没报缓存字段时 cache_reported=0；mock 的 usage 行 cache_reported=0。188 测试全过，15 剧本全绿。真模型（deepseek-flash，S1+S2 一次）：输入 45,707 token 其中命中 19,840（约 43%）。费用页截图 memory-lab/reports/c7-cost.png（假数据灌库看排版）。
- [x] D1 作息驱动的生活循环：新 lib/memory/life.mjs，不调模型。时段实例的 key =「时段开始那天@开始时间」（22:00–05:30 算开始那天）；每个时段最多做一次（账本里有同 slot 的 routine 动作就跳过），按卡里的步骤在世界副本上逐步试，非外观动作做不成就换下一个候选（候选 = 原样、去掉 args.with），都不行就这次不做；写入的 char_action 带 payload.routine=true 和 slot。**选的做法**：人在帐篷里而时段在外面，先补一步 leave；已经在帐篷里而时段以 enter 帐篷结尾，算没事做；「用户刚说过话」在推进时钟之前判断（这次 tick 之前 2 分钟世界时间内有 user_said 就不开始作息动作，时间照走）；回来补完从上次会话结束算起、不设 2 小时下限，取最后 6 个跨过的时段，每件放在时段开始后 10 分钟（夹在离开和现在之间、保持先后）；没有作息的 1.0 卡照旧走 catchup。session.tick 走第一个角色的 act 队列；POST /api/saves/:id/tick；页面会话中每 45 秒真实时间调一次，作息动作和天气/灭火写进聊天，3D 播放路径；/api/state 带 life（在做什么、是否睡着），顶栏显示「岚在帐篷里睡了」；now 节加一行作息（睡着时写「在帐篷里睡觉…外面的话只隐约听见」）。events.mjs 的 char_action.payload 加 routine/slot。test/life.test.mjs 6 组（时段计算；06:00→22:00 依次 生火→坐长凳画图(with cup)→物资角→小路→篝火边→进帐篷、不调模型、睡着；用户刚说话不做作息动作；杯子不在同区域时不带 with；离开两天回来 ≤6 件、离屏、有序、两次一样；小岛照旧 catchup）+ http 1 组。environment 测试里「推进到 20:00」改成 21:00：她 17:40 按作息又添了柴，火要 20:40 才灭（断言没改）。196 测试全过，15 剧本全绿。
- [x] D2 空闲时的内心想法和主动开口：新 prompts/idle.md、lib/memory/idle.mjs（**选的做法**：逻辑放在新模块，没塞进 proactive.mjs；proactive 只被复用来算 hints）。session.tick 在作息之后对每个角色跑一次：会话开着、用户同区域、她没在帐篷里睡、真实时间 60 秒没有 user_said/session_start（内存里记，服务重启后视为已安静）、本存档最近一小时 idle 调用 <20 次，才调后台模型（用途 idle）。送出条件：urge ≥ 0.6、这次会话空闲开口次数 < 阶段预算（relationship.mjs 新常量 IDLE_BUDGET 初识 1/熟悉 2/亲近 3/挚友 4，D5 再并进完整对照表）、离上次空闲开口（不分会话）≥5 分钟世界时间、带的动作做得成。开口记成 char_said（payload idle: true，used = [ref]，ref 必须是这次 hints 里的），每次都存一行 turns（mode idle，thought 只在这里），开口的 committed=1，页面显示气泡后照旧调 /api/delivered 写 mentions。关系页新「空闲时的想法」：说了/没说、没说的原因、想说的劲。contracts/llm-output.md 加第 9 节。**顺带改了 D1**：用户刚说过话时 tick 原来连时间也不走，会话里只要停在 2 分钟内就永远卡住；改成时间照走、只是不开始作息动作。scripts/idle-try.mjs：营地 18:00 说一句后 7 次 tick（模拟 45 秒一次），打印每次想法。test/idle.test.mjs 3 组（不满 1 分钟不调；0.4 不开口、0.8 开口、想法两次都存、回执后 mentions 有记录且算主动、关系页能看到；5 分钟间隔和阶段预算；每小时 20 次上限、没会话不调、tick 里会调）。199 测试全过，15 剧本全绿。真模型（deepseek-flash，idle-try --live，营地 18:00 说一句后不说话 5 分钟、6 次 idle 调用、输入 16,553 / 输出 385 token）：开口 1 次，18:10 劲 0.6「雾上来了。你今天走到哪儿？多远？」（接着她的「先说好，多远」口头习惯）；之后 5 次劲 0.6–0.7 都被初识预算 1 次挡住，想法是「雾这么重，他回来得倒早……路要是没记清」一类。想法里把用户叫「他」，idle 提示加了一句「想到用户就用『你』，不要猜男女」。
- [x] D3 睡前日记：新 lib/memory/diary.mjs、prompts/diary.md。世界时间过了某天 23:00，就在角色的 jobs 队列里写那天的日记（job_runs kind diary，range = yyyymmdd；水位记在 watermarks.diary）：输入 = 前一天 23:00 到当天 23:00 她感知到、过准入的事件 + 当天的观察日志，不给 thought；refs 必须都在输入里，否则带错误重试一次，再错记失败、可补跑。存成 caches kind diary，caches 补列 day、intention。**选的做法**：只给有作息的角色写（1.0 小岛不写，旧剧本的调用数不变）；那天什么都没发生就不写；一次推进很多天最多补 14 篇；检查点在会话开始、每轮开头、每次 tick（时钟动过的地方）。第二天（05:00 换日）now 节加「今天想：…」，空闲想法输入带上；life 回来补作息时，和意图沾边（「做什么」里有意图里的实字，比如 画）的时段不会被「最多 6 件」挤掉——一个时段只有一串动作，所以「优先」只落在补完的取舍上。忘记：日记 refs 里的事件被忘掉/删除 → 那篇作废（删除时连原文删掉）并按剩下的事重写，不再走 observeRange；剧本 db_text_absent 也搜 caches.intention。经历页新「日记」小节。contracts/llm-output.md 第 10 节。test/diary.test.mjs 3 组（23:00 后一篇、refs 合法、无内心、第二天有今天想、不重复写；refs 不合法重试后记失败、补跑能写；删除被引用的事件后日记重写、数据库搜不到原文）+ life 里意图匹配一条。202 测试全过，15 剧本全绿。
- [x] D4 周小结和分层检索：prompts/digest.md，周小结写在 lib/memory/diary.mjs 里（和日记共用日期和水位工具；水位 watermarks.week）。跨过世界周日 23:30，在日记之后（同一个 jobs 队列，先写周日的日记）用周一到周日的日记写一份（≤300 字），refs 只能是这周的日记，caches kind week，补列 refs 存引用的日记，derived_from = 这些日记引用的事件。memories 节：有周小结时按关键词（用户刚说的话 + 最近 4 句的汉字两字组）选 1 份，再在那周的日记 / 经历 / 观察里下钻最多 3 条，再补周小结之后的新观察，预算仍是 1200 token。**选的做法**：周小结都不沾边时照 1.0（不硬塞一份）；补新观察是为了不丢掉还没被总结的这几天。忘记级联：事件 → 日记 → 周小结，forget.apply 先重写日记再重写周小结，都不走 observeRange。经历页加「周小结」小节。contracts 第 11 节。diary.test.mjs 补 2 组（8 天 1 份周小结、refs 都是那周日记、按「小溪」选中它并下钻到日记、第一天没有周小结时照旧；删除链底的事件后日记和周小结都重建、原文搜不到）。204 测试全过，15 剧本全绿。
- [x] D5 关系阶段真正改变行为：relationship.mjs 新常量 STAGE_TABLE（称呼 / 空闲开口预算 1-2-3-4 / 主动提起冷却 ×1.5-1.0-0.8-0.7 / 秘密），IDLE_BUDGET 改由它算。阶段规则沿用 1.0（满足的最高一档），saves 补列 relationship_floor（只给测试存档，剧本步骤 set_relationship_floor，界面不暴露），实际阶段 = max(挣到的, 下限)。阶段和上一条 relationship_stage 不同就写一条 {from, to}（target = 角色；每轮 user_said 之后、会话开始时检查）；observe 跳过它，eventText 有中文。主动提起的冷却 = round(5 × 倍数) 个用户回合：初识 8、熟悉 5、亲近 4、挚友 4。秘密：阶段不到时不进任何上下文（三种模式都查过）；到了之后放进 lore 节，写「（这是你的秘密，被问到才说；卡里的备注）」，ref = secret:N。**选的做法**：秘密按卡里各自的「揭示」阶段放行（岚的是挚友），没走 admission（它不是账本里的东西，lore 节就是唯一入口）；称呼写进关系卡末尾一句（初识叫「你」，熟悉偶尔叫名字，亲近起叫名字，名字取 call_me 再取 name）。关系页：下一阶段还差什么（再对话 N 次 / 再过 N 天 / 再收 N 件礼物 / 再做到 N 个约定）、阶段变化历史。S1 第 33、35 步不再是「待 D5」：set_relationship_floor 亲近 → lore_harbor 在上下文。environment 测试找「灭了的火」提示的循环从 7 轮放到 10 轮（初识冷却变 8 轮，断言没改）。test/relationship.test.mjs 3 组（初识时秘密不在三种模式的全文里、挚友下限后在 lore 节且写出阶段事件只写一次；预算和冷却表、称呼、下一阶段差距；正常挣到熟悉写一条事件）。207 测试全过，15 剧本全绿（s1 现在 13 条）。
- [x] D6 来源标签：user_facts 补列 known_how。抽事实的证据是 user_said → told；别的来源、她完整感知到 → seen，否则 inferred。**选的做法**：1.0 只从用户的话抽事实，没有 seen 的来源，所以加了一个不调模型的「看见的事实」：账本里她完整感知到的 user_action（送东西 / 搭 / 放 / 挪）和造物台 world_edit add，记成 relation_to_object「用户把潮青陶杯给了岚」这类，证据写事件本身（ledger.onAppend 里做，同样内容不重复记；忘记/删除照 source_seqs 生效）。上下文：事实后面写（你说的 / 我看见的 / 我猜的，记于…）；经历、日记、周小结按来源事件写（你说的 / 我看见的），句子里有「可能 / 大概 / 好像 / 猜…」的写（我猜的）；world 节里别人做的、她看见的事件末尾加「｜我看见的」，她区域里最后一次变动没看见的东西只写结果「潮青陶杯现在在物资角（不知道谁挪的）」，那条事件不进上下文。系统提示加第 5 条：按标签说「你跟我说过……」「我看见……」「我猜……」，「不知道谁挪的」别说成看见了，拿不准就问。test/known-how.test.mjs 3 组（told / seen 和标签；在帐篷里没看见挪杯子：没有 seen、事件不进 world、只写现在在哪，亲眼看见时有 seen 且不再写不知道谁挪的；系统提示有这条）。210 测试全过，15 剧本全绿。
- [x] D7 三路平行长期对照：saves 补列 reply_mode（memory / full / none，NULL = memory），turn.mjs 按存档的 mode 拼真正送达的上下文并按这个 mode 记 committed 那一轮（hints 只在 memory；单句「对比」保留，对照的是另外两种）；turn groups / actionResult 改看 committed 而不是 mode === 'memory'。scenario_runs 补列 arm、arm_group，新表 arm_reviews（结果页判读）。scenarios.startArms：同一剧本建三个存档、各设 reply_mode，**选的做法**：三路一个接一个跑，不并行（假模型的排队回答按用途共用，不按存档分，并行会串到别的一路）；同一 requestId 只跑一次。接口 POST /api/scenarios/:id/arms、GET /api/arms、GET /api/arms/:group、PUT /api/arms/:group/notes/:step。新 public/arms.html + arms.js：每个 say 一行三列，review 步骤一个判读框（离开输入框就存），每路显示断言通过/失败和花费、存档链接（/?save=）。剧本面板每行加「三路平行跑」和「三路对照结果」入口。test/arms.test.mjs 2 组（S1 三路：三个存档、各自 mode、账本互不影响、hints 只在 memory、结果页三列齐、判读能存；同一 requestId 只一组）。截图 reports/d7-arms.png（假模型）。212 测试全过，15 剧本全绿。真模型三路 S1、S2 待跑。
- [x] D8 模拟用户玩多天：新 lib/simulate.mjs、scripts/simulate.mjs、prompts/sim-user.md，purpose sim_user（后台模型，温度 0.8），npm run simulate -- --persona=爱改口 --days=5 [--seed=n]，simulate:live。三种人设（话多 / 冷淡 / 爱改口）。**选的做法**：用户自己的信息（名字 / 老家 / 工作 / 爱喝的，每项 4 个互不重字的值）和什么时候说、什么时候改由脚本定（种子可重放），模型只负责把这一轮的事说成一句话；爱改口每天在中间随机一轮改一项已经说过的。模拟用户只看到这次会话的对话、时间、她在哪 / 拿着什么、用户在场时她的动作。每天：推进到 18:00 → 开会话 → 6–12 轮（每轮后 35% 停一分半：tick，可能自己开口）→ 结束。上帝面板 0–2 次（送松子 / 野花，或挪杯子 / 提灯 / 背包）。每轮判 G1–G5（scenarios 里的不变量抽成 turnProblems 共用）；旧值复现 = 改口那一轮之后她的话里出现旧值、且那一轮用户自己没说它。花费上限 LAB_SIM_MAX_USD（默认 2，到了就停并写进报告；未计价的调用数也写）。报告 data/reports/sim-<人设>-<时间>.md：指标表、每天全部对话、G 失败、旧值复现。合约 §12。test/simulate.test.mjs 4 组（mock 2 天：每天改口、G 0、复现 0、报告齐；回复里带旧值算复现、改口那一轮的回答不算；花费上限会停；种子可重放）。216 测试全过。真模型爱改口 5 天待跑。
- [x] D9 S2 第 3 段 + 试玩记录：s2-cup.json 补第 3 段（第二天作息里画过图、第一天的日记、日记引用都在当天且还在；问杯子：妈留下的事实是「你说的」、递杯子是「我看见的」；安静 2 分钟开口 1 次，再 2 分钟初识预算用完不开口；周四约定到期进 hints；忘掉杯子的事 → hints 不含「妈」、重建后的日记不含「妈」、日记引用仍合法；内心不入库）。剧本新步骤 tick: n、idle_real: "2m"（假的真实时钟，每 45 秒一次 tick；说话后归零），mock 可以给一个数组排队；新断言 diary_exists（day 可写第几天）、diary_refs_ok、diary_not_contains、known_how、idle_said，event 加 routine / idle 过滤，context_section_contains 可用 any。**选的做法**：计划里「world 节里杯子带我看见的 / 不知道谁挪的」在这个剧本里不成立（杯子一直在她手里，world 节不写），改成断言 facts 节同时有「你说的」和「我看见的」。新表 playtest_notes(save_id, day, text, created_at)，POST /api/saves/:id/playtest-notes，结束会话时 prompt「今天感觉怎样？」（空就跳过），「关系」页底部「试玩记录」。**另外两处修正（D7 真模型三路暴露的）**：① 动作被世界拒绝时，带着原因让模型重选一次（只在被拒时多一次调用；记在 rejected.retried_action），还拒才给宿主那句；宿主那句里去掉动作定义的括号说明；相关 8 处测试改成「模型坚持」排两次。② 事件文本补上营地动作（tend_fire / enter / leave / draw_map），不再有「岚tend_fire石圈篝火」这类 id 进提示和日记。218 测试全过，15 剧本全绿（S2 自动断言 24 过）。
- [x] D 真模型验收（deepseek-flash，Mac 上跑，价格没配所以未计价）：eval --live S1 16 过 0 失败、S2 27 过 0 失败（第 3 段全部 live_only 都过），待判读 3 条（S1 第 21、32 步，S2 第 35 步），报告 data/reports/eval-2026-10-25-03-55.md；缓存命中率 50%。D7 三路 S1 / S2 各一次（arms-2026-10-25-02-02.md）。D8 爱改口 5 天：46 轮，她主动开口 9 次（每天 1.8），G1–G5 失败 0，旧值复现 0（改过 5 次：名字、老家两次、爱喝的两次），报告 sim-爱改口-2026-10-25-03-59.md。模拟里看到两处，已修：draw_map 带了目标（坐着的长凳）被拒，宿主那句只剩半个括号 → 不要目标的动作直接忽略目标；去掉说明时按最外层括号去。第 4 天她说「掀被子我可不动手」、第 5 天自己开口说「起不来我掀被子」→ Jonathan 说要管，见下一条。
- [x] 自相矛盾（Jonathan：要管）：新 prompts/self-check.md、purpose self_check（合约 §13）、selfCanon.check / supersede。回复的 self_claims 也收她表明的态度和对用户立的规矩；有自述时查一次和以前的 active 自述是否说反：说反 → 带着两句话重说一次；还反 → 送达但标 self_conflict，算 G6（剧本、模拟每轮都判），这条自述存 conflicts_self 不进上下文；明说改主意 → 旧的那条 superseded。空闲开口：提示里加「你说过的关于自己的话」，输出加 self_claims，说反了就不开口。模拟报告加「拦下的自相矛盾」一列和对话里的标注。「关系」页自述状态都有中文标签。test/self-consistency.test.mjs 5 组。223 测试全过，15 剧本全绿。
- [ ] C6 剧本 S2 第 1–2 段
- [ ] C7 缓存命中率

### D 自己过日子
- [ ] D1 作息驱动的生活循环
- [ ] D2 空闲时的内心想法和主动开口
- [ ] D3 睡前日记
- [ ] D4 周小结和分层检索
- [ ] D5 关系阶段真正改变行为
- [ ] D6 来源标签
- [ ] D7 三路平行长期对照
- [ ] D8 模拟用户
- [ ] D9 S2 第 3 段 + 三天试玩记录
