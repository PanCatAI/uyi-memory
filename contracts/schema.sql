-- 记忆实验台数据库（node:sqlite）。版本 1 + 补列（旧库由 lib/db.mjs 按列名补齐，user_version 仍为 1）。
-- 时间一律是“世界时间”毫秒（虚拟时钟），列名 t / *_at 都是整数毫秒。
-- JSON 列都以 _json 结尾或注明，存 JSON 文本。
-- 一个 save（存档）= 一个用户 + 一个场景 + 一条时间线。分支 = 复制存档（fork）。

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS saves (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  scene_id      TEXT NOT NULL,              -- scenes/<scene_id>.json
  user_name     TEXT NOT NULL DEFAULT '你',
  forked_from   TEXT,                       -- 被复制的存档 id
  forked_at_seq INTEGER,
  clock_ms      INTEGER NOT NULL,           -- 当前世界时间
  generation    INTEGER NOT NULL DEFAULT 0, -- 每次纠正/忘掉/删除 +1，用来让旧缓存失效
  session_id    TEXT,                       -- 当前打开的会话；NULL = 用户不在
  created_at    INTEGER NOT NULL            -- 真实时间，仅用于列表排序
  -- 2.0 补列 relationship_floor（D5，测试用）；reply_mode（D7）：'memory' | 'full' | 'none'，真正送达的回复用哪种上下文，NULL = memory
  -- 3.0 补列 features_json（E4）：这个存档打开了哪些 3.0 功能，NULL = 全关（旧存档、剧本默认）
);

-- 角色当前位置等“宿主状态”的快照不存表，由 lib/world.mjs 从场景 + 事件折叠出来。

-- ───────── 世界账本：只有 lib/ledger.mjs 能写 ─────────
CREATE TABLE IF NOT EXISTS events (
  save_id        TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,          -- 每个存档从 1 递增
  t              INTEGER NOT NULL,          -- 世界时间
  session_id     TEXT,                      -- 离屏事件为 NULL
  room           TEXT,                      -- 发生的房间
  type           TEXT NOT NULL,             -- 见 contracts/events.mjs
  actor          TEXT NOT NULL,             -- 'user' | 'host' | 角色 id
  action         TEXT,                      -- 动作名（char_action / user_action）
  target         TEXT,                      -- 物件 / 地点 / 角色 id
  outcome        TEXT,                      -- 'ok' | 'failed' | 'interrupted' | NULL
  perceivers     TEXT NOT NULL DEFAULT '[]',-- JSON：当时在同一房间、能感知到的角色 id
  user_presence  TEXT NOT NULL DEFAULT 'present', -- 'present' | 'maybe' | 'absent'
  offscreen      INTEGER NOT NULL DEFAULT 0,      -- 1 = 用户不在时发生（离屏补完）
  payload_json   TEXT,                      -- 可删除的内容（话语原文等）
  tombstone_json TEXT,                      -- 删除后：{"job":..,"verb":..,"at":..}
  PRIMARY KEY (save_id, seq)
);
CREATE INDEX IF NOT EXISTS events_by_type ON events(save_id, type, seq);
CREATE INDEX IF NOT EXISTS events_by_target ON events(save_id, target, seq);

-- 事件头不可改：只允许改 payload_json 和 tombstone_json（AGENTS.md 硬规则 2）。
CREATE TRIGGER IF NOT EXISTS events_header_immutable
BEFORE UPDATE OF save_id, seq, t, session_id, room, type, actor, action, target, outcome, perceivers, user_presence, offscreen ON events
BEGIN
  SELECT RAISE(ABORT, 'event header is immutable');
END;

-- 事件标记：不改事件头也能“忘掉”一条事件。
CREATE TABLE IF NOT EXISTS event_flags (
  save_id TEXT NOT NULL,
  seq     INTEGER NOT NULL,
  flag    TEXT NOT NULL,                    -- 'forgotten'（角色不再知道）| 'suppressed'（别再主动提）
  job_id  TEXT NOT NULL,
  at      INTEGER NOT NULL,
  PRIMARY KEY (save_id, seq, flag),
  FOREIGN KEY (save_id, seq) REFERENCES events(save_id, seq) ON DELETE CASCADE
);

-- 某个角色不许再从这些事件派生任何内容（忘掉/删除一条经历时记下它的来源）。缓存重建、观察、上下文都查这张表，
-- 所以内容不会换一个缓存 id 回来。和 event_flags 不同，它按角色记，不影响别的角色，也不连带同一句话里的事实。
CREATE TABLE IF NOT EXISTS forgotten_seqs (
  save_id      TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  job_id       TEXT NOT NULL,
  at           INTEGER NOT NULL,
  PRIMARY KEY (save_id, character_id, seq)
);

-- ───────── 用户事实（双时间轴） ─────────
CREATE TABLE IF NOT EXISTS user_facts (
  id            TEXT PRIMARY KEY,
  save_id       TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
  character_id  TEXT NOT NULL,              -- 谁知道这条事实（听到的那个角色）
  predicate     TEXT NOT NULL,              -- 见 contracts/llm-output.md 的谓词表
  object        TEXT NOT NULL,              -- 事实内容，短句
  evidence      TEXT NOT NULL,              -- 来源原文里的一个子串
  source_seqs   TEXT NOT NULL,              -- JSON 数组
  valid_from    INTEGER NOT NULL,           -- 世界里从何时为真
  valid_to      INTEGER,                    -- 世界里到何时为止；NULL = 仍然为真
  recorded_at   INTEGER NOT NULL,           -- 系统何时记下
  superseded_by TEXT,                       -- 被哪条新事实取代
  status        TEXT NOT NULL DEFAULT 'active', -- 'active' | 'superseded' | 'expired' | 'forgotten'
  sensitivity   TEXT NOT NULL DEFAULT 'normal', -- 'normal' | 'private'（永不主动提）
  confidence    REAL NOT NULL
  -- 2.0 D6 补列 known_how：'told'（用户说的）| 'seen'（她亲眼看见的世界事件）| 'inferred'（推测）；旧行为 NULL = told
);
CREATE INDEX IF NOT EXISTS facts_by_pred ON user_facts(save_id, character_id, predicate, status);

-- 被规则拒绝的候选事实，留着给右栏“为什么没记”看。
CREATE TABLE IF NOT EXISTS rejected_facts (
  id           TEXT PRIMARY KEY,
  save_id      TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL,
  candidate_json TEXT NOT NULL,
  reason       TEXT NOT NULL,               -- 见 lib/memory/facts.mjs 的 REJECT 常量
  at           INTEGER NOT NULL
);

-- ───────── 承诺 ─────────
CREATE TABLE IF NOT EXISTS commitments (
  id           TEXT PRIMARY KEY,
  save_id      TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL,
  owner        TEXT NOT NULL,               -- 'character' | 'user'：谁答应的
  text         TEXT NOT NULL,               -- “明天陪你去看灯塔”
  due_at       INTEGER,                     -- NULL = 没有时间
  status       TEXT NOT NULL DEFAULT 'open',-- 'open' | 'done' | 'dropped' | 'forgotten'
  source_seqs  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  closed_at    INTEGER,
  closed_seq   INTEGER
);

-- ───────── 角色自我设定（角色自己说过的关于自己的话，要前后一致） ─────────
CREATE TABLE IF NOT EXISTS self_canon (
  id           TEXT PRIMARY KEY,
  save_id      TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL,
  text         TEXT NOT NULL,               -- “我怕打雷”
  source_seqs  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active', -- 'active' | 'conflicts_canon'（与作者设定冲突，不用）| 'forgotten'（唯一来源被忘掉）| 'no_event'（声称做过某事，但账本里没有对应的成功事件，不用）| 'conflicts_self'（和她自己以前说的说反了、重试后还反，不用）| 'superseded'（她明说改主意了，旧的这条不再用）
  created_at   INTEGER NOT NULL
);

-- ───────── 模型写的叙述：全部是缓存 ─────────
CREATE TABLE IF NOT EXISTS caches (
  id            TEXT PRIMARY KEY,
  save_id       TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
  character_id  TEXT NOT NULL,
  kind          TEXT NOT NULL,              -- 'observation' | 'episode' | 'diary' | 'week' | 'keepsake'（2.0 D3/D4 补列 day、intention、refs）
  text          TEXT NOT NULL,
  priority      INTEGER NOT NULL DEFAULT 2, -- 1 高 2 中 3 低（观察日志用）
  derived_from  TEXT NOT NULL,              -- JSON：事件 seq 数组
  fact_ids      TEXT NOT NULL DEFAULT '[]', -- JSON：用到的事实 id
  from_seq      INTEGER NOT NULL,           -- 覆盖的事件范围
  to_seq        INTEGER NOT NULL,
  generation    INTEGER NOT NULL,           -- 生成时存档的 generation
  invalid       INTEGER NOT NULL DEFAULT 0,
  invalid_reason TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS caches_live ON caches(save_id, character_id, kind, invalid);

-- 后台任务的进度水位：某角色某任务已经处理到哪个 seq。
CREATE TABLE IF NOT EXISTS watermarks (
  save_id      TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL,
  job          TEXT NOT NULL,               -- 'facts' | 'observe' | 'self_canon' | 3.0 'world'（character_id 'host'，seq 存世界时间 ms）
  seq          INTEGER NOT NULL,
  PRIMARY KEY (save_id, character_id, job)
);

-- 后台任务的失败与恢复（不随重启丢失）。一行 = 某角色某种任务的一段事件范围；成功的范围不记。
-- status：'failed'（会自动再试）| 'skipped'（连续失败 3 次，水位已越过，等显式补跑）| 'retrying'
--       | 'recovered'（补跑成功）| 'recovered_empty'（补跑成功但没抽到东西）| 'cancelled'（来源已被忘掉/删除，不再补）
CREATE TABLE IF NOT EXISTS job_runs (
  id           TEXT PRIMARY KEY,
  save_id      TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL,
  kind         TEXT NOT NULL,               -- 'facts' | 'observe' | 'reflect' | 'diary' | 'week'（2.0 D3/D4：from_seq = to_seq = 那天/那个周日的 yyyymmdd）
  from_seq     INTEGER NOT NULL,
  to_seq       INTEGER NOT NULL,
  status       TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,                        -- 不许包含 key（来自 llm.mjs 的错误已经打码）
  generation   INTEGER NOT NULL,            -- 最后一次尝试时存档的 generation
  created_at   INTEGER NOT NULL,            -- 真实时间
  updated_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS job_runs_range ON job_runs(save_id, character_id, kind, from_seq, to_seq);

-- ───────── 提起与检索分开记 ─────────
-- memory_ref 格式：'fact:<id>' | 'cache:<id>' | 'commit:<id>' | 'ev:<seq>'
CREATE TABLE IF NOT EXISTS mentions (      -- 角色真的说出口了（last_mentioned）
  save_id      TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL,
  memory_ref   TEXT NOT NULL,
  seq          INTEGER NOT NULL,            -- 那句 char_said 的 seq
  t            INTEGER NOT NULL,
  proactive    INTEGER NOT NULL DEFAULT 0,  -- 1 = 角色主动提起，不是被问到
  session_id   TEXT
);
CREATE INDEX IF NOT EXISTS mentions_by_ref ON mentions(save_id, character_id, memory_ref, t);

CREATE TABLE IF NOT EXISTS retrievals (    -- 放进了上下文（last_retrieved）
  save_id      TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL,
  memory_ref   TEXT NOT NULL,
  turn_id      TEXT NOT NULL,
  t            INTEGER NOT NULL
);

-- ───────── 三种忘记 ─────────
CREATE TABLE IF NOT EXISTS suppressions (  -- “别再提”
  id           TEXT PRIMARY KEY,
  save_id      TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL,
  topic        TEXT NOT NULL,               -- 用户说的话题，原文
  refs_json    TEXT NOT NULL,               -- 命中的 memory_ref 数组
  source_seq   INTEGER NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS forget_jobs (
  id           TEXT PRIMARY KEY,
  save_id      TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL,
  verb         TEXT NOT NULL,               -- 'suppress'（别再提）| 'forget'（忘掉）| 'delete'（删除记录）
  request_seq  INTEGER NOT NULL,            -- 用户提出请求的那句 user_said
  topic        TEXT NOT NULL,
  state        TEXT NOT NULL,               -- 'proposed' → 'confirmed' → 'applied' → 'rebuilt' → 'reported' | 'cancelled'
  candidates_json TEXT NOT NULL DEFAULT '{}', -- {"seqs":[],"fact_ids":[],"cache_ids":[],"commit_ids":[]}
  applied_json TEXT,                        -- 实际处理的同结构
  report_json  TEXT,                        -- {"events":n,"facts":n,"caches_rebuilt":n,"traces_redacted":n}
  created_at   INTEGER NOT NULL,
  finished_at  INTEGER
);

-- ───────── 调试与成本 ─────────
-- 每一轮回复的完整上下文，给右栏「本轮上下文」看。删除记录时要把命中的原文抹掉。
CREATE TABLE IF NOT EXISTS turns (
  id            TEXT PRIMARY KEY,
  save_id       TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
  character_id  TEXT NOT NULL,
  mode          TEXT NOT NULL,              -- 'memory' | 'full' | 'none'
  committed     INTEGER NOT NULL,           -- 1 = 这条回复进了账本；对比模式的另外两路是 0
  user_seq      INTEGER,
  reply_seq     INTEGER,
  sections_json TEXT NOT NULL,              -- [{name, tokens, refs:[...], why}]
  prompt_json   TEXT NOT NULL,              -- 发给模型的 messages
  output_json   TEXT,                       -- 模型原样返回（解析后）
  rejected_json TEXT,                       -- 被仲裁器拦下的动作、被过滤的句子
  generation    INTEGER NOT NULL,
  t             INTEGER NOT NULL,
  thought       TEXT,                       -- 2.0：回复的「内心」，只在这里，不进账本和任何后续上下文
  card_version  INTEGER                     -- 2.0：这一轮用的角色卡版本（0 = 文件）
  -- 3.0 补列 intent（E2：这句的意图）、topic（G1：这轮给的话头 id）
);

-- 2.0 B5：设定页保存的角色卡版本。版本 0 是 characters/*.md 文件本身，不入表；保存和恢复都追加新行。
CREATE TABLE IF NOT EXISTS card_versions (
  save_id    TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
  char_id    TEXT NOT NULL,
  version    INTEGER NOT NULL,
  text       TEXT NOT NULL,
  note       TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (save_id, char_id, version)
);

CREATE TABLE IF NOT EXISTS llm_calls (
  id            TEXT PRIMARY KEY,
  save_id       TEXT,
  purpose       TEXT NOT NULL,              -- 'reply' | 'facts' | 'observe' | 'reflect' | 'catchup' | 'forget_resolve' | 'self_canon' | 'judge' | 'card_draft' | 'ooc_judge' | 'test'
  provider      TEXT NOT NULL,              -- 'openai_compat' | 'mock'
  model         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL,                       -- NULL = 没配价格
  latency_ms    INTEGER NOT NULL,
  ok            INTEGER NOT NULL,
  error         TEXT,                       -- 不许包含 key
  real_at       INTEGER NOT NULL,           -- 真实时间
  -- 补列：每一行是一次实际尝试（每个 HTTP 请求 / 每次 mock 回答）。
  finish_reason TEXT,                       -- 服务商返回的 finish_reason（'stop' | 'length' | …）；没拿到响应为 NULL
  stage         TEXT,                       -- 'ok' | 'network' | 'http' | 'json' | 'shape'：失败在哪一步；旧行为 NULL
  logical_id    TEXT,                       -- 同一次逻辑调用（含重试）的所有尝试共用
  attempt       INTEGER,                    -- 逻辑调用里的第几次尝试，从 1 开始
  usage_known   INTEGER                     -- 1 = token 来自服务商；0 = 没拿到或是估算（mock），不计价；旧行为 NULL
);

-- ───────── 剧本运行 ─────────
CREATE TABLE IF NOT EXISTS scenario_runs (
  id           TEXT PRIMARY KEY,
  scenario_id  TEXT NOT NULL,
  save_id      TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL,
  step         INTEGER NOT NULL DEFAULT 0,  -- 下一步的下标
  state        TEXT NOT NULL,               -- 'running' | 'paused' | 'passed' | 'failed' | 'error'
  results_json TEXT NOT NULL DEFAULT '[]',  -- [{step, kind, ok, detail}]
  real_at      INTEGER NOT NULL,
  request_id   TEXT                         -- 补列：客户端的运行请求 id，同一个 id 只跑一次（唯一索引在 lib/db.mjs）
  -- 2.0 D7 补列 arm（'memory' | 'full' | 'none'，三路平行跑的这一路）和 arm_group（同一次三路跑的三条共用）
);

-- 2.0 D9：试玩记录。会话结束时问一句「今天感觉怎样？」（可以不写），「关系」页底部列出。
CREATE TABLE IF NOT EXISTS playtest_notes (
  save_id    TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
  day        TEXT NOT NULL,                 -- 世界日期 YYYY-MM-DD（东京）
  text       TEXT NOT NULL,
  created_at INTEGER NOT NULL               -- 真实时间
);
CREATE INDEX IF NOT EXISTS playtest_by_save ON playtest_notes(save_id, created_at);

-- 2.0 D7：三路平行跑结果页上，每个 say / review 步骤的人工判读（一组一条）。
CREATE TABLE IF NOT EXISTS arm_reviews (
  arm_group  TEXT NOT NULL,
  step       INTEGER NOT NULL,              -- 剧本步骤下标
  text       TEXT NOT NULL,
  updated_at INTEGER NOT NULL,              -- 真实时间
  PRIMARY KEY (arm_group, step)
);

-- 3.0 F4：导演每次检查一个意外的结果（右栏「世界」页看）。decision：start | budget | gap | rest | cooldown | roll | when | active
-- | auto_fix | debug。t 是世界时间。
CREATE TABLE IF NOT EXISTS director_log (
  save_id  TEXT NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
  t        INTEGER NOT NULL,
  incident TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS director_log_by_save ON director_log(save_id, t);
