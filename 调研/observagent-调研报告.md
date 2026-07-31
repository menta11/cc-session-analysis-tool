# ObservAgent 调研报告

> 仓库：`observagent-main.zip`（npm 包 `@darshannere/observagent` v2.4.4）
> 临时解压目录：`调研/observagent-temp/observagent-main`
> 定位：**Local-first 的 Claude Code 实时可观测性面板**——靠 Claude Code hooks + JSONL 监听，把会话进行中的工具调用、智能体层级、成本、健康实时摊到一个网页仪表盘上。
> 调研日期：2026-07-30
> 关注维度：**工具调用** 与 **智能体层级**（成本/健康仅作背景，不深入）
> 关联文档：[[ccspan-调研报告]] · [[ClaudeScope-调研报告]] · [[claude-session-dashboard-解析层调研报告]]

---

## ★ 调研结论速览（TL;DR）

1. **OBA 的价值锚点 = "实时 + 侵入式 hook 采集"，二者一体不可分。** 它为实时，主动牺牲了事后解析的深度（工具只存白名单摘要、不读结构化结果、子 agent 明细浅）。
2. **技术路线分野**：OBA 走的是 **hook 实时浅采集**；ccspan / ClaudeScope / CSD 走的是 **JSONL 事后深度解析**。两条路。
3. **对本项目（事后分析导向）的关键结论：去掉"实时"，OBA 在工具调用维度几乎归零、智能体层级只剩子文件 token——且后者正是 ccspan/CSD 做得更细的地方。** OBA 的工具调用与智能体能力整个长在 hook 上，不解析 JSONL 的 tool_use/tool_result。
4. **唯一仍可借鉴的（理念层面）**：① fire-and-forget hook 的工程范式（500ms 超时 / exit 0 / 隐私白名单摘要）——但不用 hook 就无处施展；② 隐私白名单摘要的设计原则（展示工具调用时不泄露文件内容/密钥）。

---

## 一、一句话定位

> **ObservAgent 把 Claude Code 变成一个可实时调试的系统。无 wrapper、无 SDK、无云，只做"可见性"。**

解决 Claude Code 重度用户痛点：会话变贵且不透明——"这次 $3 是为什么？""哪个工具慢？""智能体为什么静默失败？" Claude 写 JSONL 但无法实时消费。OBA 通过 **hooks 机制** + **JSONL 文件监听**，零代码改动地把这些数据变成实时仪表盘。

---

## 二、最根本的区别：实时 vs 事后（理解 OBA 的关键）

这是 OBA 与 ccspan/ClaudeScope/CSD 最本质的分野，决定了工具调用、智能体两个维度的所有差异：

| | 数据来源 | 模式 | 侵入性 |
|---|---|---|---|
| **OBA** | Claude Code **hooks**（PreToolUse/PostToolUse/SubagentStart/Stop）+ JSONL 监听 | **实时 push**（SSE 推送） | **侵入式**（要装 hook + Python） |
| ccspan / ClaudeScope / CSD | 读 `~/.claude/projects/*.jsonl` | **事后 pull**（CSD 有 3 秒 mtime 轮询，仍非事件推送） | 零侵入只读 |

- OBA = **会话进行中**主动推事件，能实时看见"谁在跑、谁卡了"。
- 三家 = **读文件**，擅长把历史挖深、挖细、做归因和统计。

> 后文两个核心维度（§九对比、§十一适用性）都建立在这个分野之上。

---

## 三、技术栈

| 层 | 技术 |
|---|---|
| 后端 | Node.js 18+ / Fastify 5（`server.js`，单进程，绑定 `127.0.0.1`） |
| 实时推送 | `fastify-sse-v2`（Server-Sent Events） |
| 存储 | SQLite（`better-sqlite3`，**WAL 模式** + `synchronous=NORMAL`） |
| Hook 中继 | Python 3 **纯标准库**（`relay.py`，无需 pip 安装） |
| 前端 | React 18 + TypeScript + Vite + Zustand + React Router + Tailwind v4（深色主题） |
| 图表/虚拟化 | Recharts + TanStack Virtual（ToolLog 长列表）+ shadcn/ui |
| CLI | Commander（`observagent init/start/doctor`） |

---

## 四、整体架构与数据流

```
┌──────────────────────────────────────────────────────────┐
│  Claude Code 进程                                         │
│  PreToolUse ──► relay.py ──► POST /ingest ──► WriteQueue ─┤──► events 表（工具调用）
│  PostToolUse ─► relay.py ──► POST /ingest ──► WriteQueue ─┤
│  SubagentStart► relay.py ──► POST /ingest ───────────────┤──► agent_nodes 表（智能体层级）
│  SubagentStop─► relay.py ──► POST /ingest ───────────────┤
└──────────────────────────────────────────────────────────┘

~/.claude/projects/**/*.jsonl ──► jsonlWatcher ──► api_calls 表
                                                 ──► session_cost 表（成本/token）

SSE /events ◄──── sseClients.broadcast() ◄──── ingest + jsonlWatcher
浏览器 ◄──── GET /api/* (REST) ◄──── SQLite 直读（不走队列）
```

**两条采集链路互补**：
1. **Hooks 链路（实时工具/智能体事件）**：`relay.py` 每个 hook 事件读 stdin → POST `/ingest`。**工具调用、单次耗时、错误、智能体生命周期全来自这里。**
2. **JSONL 链路（成本/token）**：`jsonlWatcher` 用 `fs.watch` + 300ms 防抖监听 `~/.claude/projects/**/*.jsonl`，解析后 upsert 到 `session_cost` / `api_calls`。

> ⚠️ 关键：**工具调用/智能体层级 = hooks；成本/token = JSONL**。两者通过 `session_id`/`agent_id` 关联。这正是"去掉 hooks 实时采集，工具调用与智能体层级就垮"的根源。

---

## 五、核心组件详解

### 1. `hooks/relay.py` —— Hook 中继（fire-and-forget）

整个系统最精巧也最"克制"的部分。设计约束极严：

- **绝不写 stdout/stderr**（否则污染 Claude Code UI）
- **永远 exit 0**（非零退出码可能阻塞或改变工具行为）
- **500ms 硬超时**（保护 Claude 会话，服务端挂死也不拖累）
- **无重试、无缓冲**，纯 fire-and-forget
- **纯 Python stdlib**，无需 `pip install`

**隐私安全设计（重点）**：relay.py 只转发**元数据**，**绝不转发 `tool_input` / `tool_response` 原文**（可能含文件内容、命令、密钥）：
- **派生 `tool_summary`**：白名单提取非敏感字段——Bash 的 `command`、Read/Write/Edit 的 `file_path`、Grep/Glob 的 `pattern`、WebFetch 的 `url`、Task 的 `description`+`subagent_type`。`content`/`new_str`/`old_str` 一律不碰，字段截断 200 字符。
- **派生 `exit_status`**：PostToolUse 对 Bash，**stderr 非空 ⇒ 1**；其他工具无法可靠判断返回 None。只转发 0/1/None 布尔结果，**不转发 stderr 内容**。
- **派生 `agent_id`**：优先 `payload.agent_id`，否则从 `transcript_path` 正则 `agent-([A-Za-z0-9]+)\.jsonl$` 提取。

### 2. `routes/ingest.js` —— 事件接收 + 配对 + 智能体管理

- **先返回 202，再入库**：`reply.code(202).send()` 在任何 DB 写入前执行（`setImmediate` 保证响应 flush），hook 延迟恒定 < 1ms。
- **Pre/Post 配对算延迟**：内存 `Map<tool_call_id, {startTs}>`，PostToolUse 到达时 `duration_ms = now - startTs`。5 分钟 TTL 清理未配对项。
- **智能体生命周期**：
  - `SubagentStart` → upsert `agent_nodes`（state=active），广播 `agent_spawn`；
  - `SubagentStop` → state=completed；
  - **合成 session 根节点**：无子智能体的 solo 会话，首次 PreToolUse 自动建 `agent_type='session'` 根节点。
- **初始 prompt**：Task 工具 PreToolUse 暂存 `description`，等 SubagentStart 认领，存入 `agent_nodes.initial_prompt`。
- **僵尸智能体清理**：每 60 秒把 `last_activity_ts` 超 10 分钟的 active 节点标 `stale`；服务重启时残留 active → `interrupted`。

### 3. `lib/jsonlWatcher.js` —— JSONL 成本监听

- 自动发现 `~/.claude/projects/**/*.jsonl`（含 `<session>/subagents/agent-<hex>.jsonl`）。
- `fs.watch` + 300ms 防抖重解析；递归目录 watch 捕获新文件（200ms 延迟）。
- **项目名提取**：优先 walk-up 找 `.git` 根目录 basename，否则用 cwd basename，带缓存。
- **只扫一层 subagents/，不递归孙 agent**；只从子文件抽 usage/cost，**不解析子 agent 的工具调用**。

### 4. `lib/costEngine.js` —— 纯计算模块（无副作用）

- **定价表**：内置 claude-sonnet/opus/haiku 4-x 等模型单价；模型匹配支持剥离 `YYYYMMDD` 后缀；未知 Claude 模型 fallback sonnet-4-6，非 Claude 返回 null。
- **去重规则**：Claude Code JSONL 对同一 message id 发多条 assistant 记录（流式 chunk），按 **message id 去重保留最后一条**。
- **cache write 归一化**：同时处理旧的 `cache_creation_input_tokens`（flat）和新的 `ephemeral_{5m,1h}` 明细，差额补到 5m。
- **上下文填充率**：分母 `contextWindow - 40000`（autocompact buffer），分子只算 input + cacheRead。

### 5. `lib/writeQueue.js` —— 单写者队列

FIFO 串行化所有 `INSERT INTO events`，`setImmediate` 让出事件循环，规避 `SQLITE_BUSY`。读（`GET /api/*`）绕过队列直读 DB（WAL 保证读写并发）。

---

## 六、数据库设计（5 张表）

```
events            工具事件流水（来自 hooks）：tool_name, hook_type, session_id, agent_id,
                  tool_call_id, timestamp, duration_ms, exit_status, tool_summary
session_cost      会话级成本聚合（PK: session_id + agent_id，来自 JSONL）
agent_nodes       智能体层级（来自 hooks）：agent_id, parent_session_id, agent_type,
                  state(active/completed/interrupted/stale), spawned_at, initial_prompt,
                  transcript_path
api_calls         每次 API 调用 token 明细（PK: session_id + timestamp_ms，来自 JSONL）
observagent_config KV 配置：budget/ctx阈值、context_window_tokens、full_tool_input_enabled
```

> 注意表来源标注：**events / agent_nodes 的数据只来自 hooks；session_cost / api_calls 来自 JSONL**。这是判断"去掉 hooks 会丢什么"的直接依据。

---

## 七、前端功能（React SPA）

两个页面：`/live`、`/history`，Zustand 全局 store。

### Live Dashboard（三栏，深色终端风）

| 区域 | 内容 |
|---|---|
| **左栏 AgentTree** | 会话+子智能体树，可折叠；显示每节点 token/成本、**当前正在执行的工具**；时间过滤条；活跃智能体数量徽标。点击会话/智能体即过滤事件流。 |
| **中栏（Tab 切换）** | **Log**（工具调用流水：时间戳、工具类型圆点、**延迟**、命令/路径摘要、token 数，TanStack Virtual 虚拟化）/ **Timeline**（甘特瀑布图）/ **Insights**（Cost/Activity/Health 三 Tab） |
| **右栏** | CostPanel（总成本、今日、上下文填充、token 明细、预算阈值）+ HealthPanel（连接状态、错误率、调用数、uptime、hook 安装状态、停滞智能体徽标） |

### History Page（`/history`）

- 按 **git 仓/项目名分组**；每会话显示成本、模型、最后事件时间、活跃/错误标记。
- 筛选：快捷按钮（15m/1h/24h/all）+ 日期范围。
- **一键 Replay**（`/live?replay=<id>` 只读回放）/ **导出 JSONL/CSV**。

---

## 八、CLI 与 API

```bash
npm install -g @darshannere/observagent
observagent init     # 拷贝 relay.py 到 ~/.claude/observagent/，幂等注入 4 个 hook 到 ~/.claude/settings.json
observagent start    # 启动服务（4999），打开浏览器
observagent doctor   # 健康检查（服务/hook/JSONL），支持 --fix
```

| Endpoint | 方法 | 作用 |
|---|---|---|
| `/ingest` | POST | 接收 hook 事件（202 先返回） |
| `/events` | GET | SSE 实时流 |
| `/api/agents` · `/api/agents/:id/detail` · `/api/agents/:id/context` | GET | 智能体树 / 详情（prompt、context 读 transcript 最近 50 轮、calls、tokens） |
| `/api/events` | GET | 工具事件（可按 session_id） |
| `/api/cost` · `/api/sessions` · `/api/sessions/:id/export` | GET | 成本汇总 / 会话历史（多维筛选）/ 导出 |
| `/api/insights/*` | GET | activity / tokens-over-time / error-rate / stalled-agents / latency-by-tool / cost-daily / cost-by-agent（共 7 个） |

---

## 九、★ 与同类工具对比（聚焦：工具调用 + 智能体层级）

> 对比对象：ccspan（事后 CLI，三时长 + prompt-cascade）、ClaudeScope（单会话 Gradio，Turn 重建 + 工具配对）、CSD（Web 看板，摘要/频次导向，subagent 链接 + token 去重）。

### 9.1 工具调用维度

| 维度 | OBA | ClaudeScope | ccspan | CSD |
|---|---|---|---|---|
| 数据来源 | **hooks 实时** | JSONL `tool_use`↔`tool_result` 配对 | JSONL 聚合 | JSONL 计数 |
| 实时流水 | ✅ **唯一** | ❌ 事后 | ❌ 事后 | ❌ 事后 |
| 单次真实耗时 | ✅ Pre/Post hook 配对 | ✅ `tool_use`↔`tool_result` 配对（招牌） | ❌ 子 agent 丢弃；主线程只聚合 | ❌ 无 |
| 错误/成败 | △ 仅 Bash 可靠（stderr） | ✅ tool_result 文本 | △ | ✅ 标错误 |
| 命令/文件摘要 | ✅ 白名单摘要 | ✅ 完整 tool_result 文本 | △ 主线程有 | ✅ input 字段 |
| 结构化结果（diff/命中/stdout） | ❌ | ❌（顶层 `toolUseResult` 盲区） | ❌ | ❌ |
| **去掉实时后** | **几乎归零** | 不受影响 | 不受影响 | 不受影响 |

**OBA 工具调用亮点**：① 唯一实时工具流水；② Pre/Post 配对算耗时，事件当下就算好（不必事后缝两行 JSONL）。
**OBA 工具调用短板**：① **内容颗粒度浅**——白名单摘要，无 tool_input/tool_response 原文，事后无法重看某次 Edit 改了啥（`full_tool_input_enabled` 只打印控制台不入库）；② **事后回溯弱**——events 表只有 hook 期间数据；③ exit_status 仅 Bash 可靠；④ 结构化 `toolUseResult` 同样盲区。

### 9.2 智能体层级维度

| 维度 | OBA | ccspan | CSD | ClaudeScope |
|---|---|---|---|---|
| 来源 | SubagentStart/Stop hooks + 子文件 | 递归读子 transcript + `promptId` 归因 | 4 来源 agentId 兜底链接 | **死代码（空白）** |
| 实时树 | ✅ **唯一** | ❌ 事后 | ❌ 事后 | ❌ |
| 状态机 / 僵尸检测 | ✅ active/completed/interrupted/stale | △ 有耗时/token | △ | — |
| 初始 prompt | ✅ Task 的 description | ✅ `promptId` 归因（招牌） | △ | — |
| 子 agent 工具明细 | ❌ 白名单摘要 | ❌ 丢弃 | △ 聚合级、均匀撒点 | — |
| token 防双算 | 绕开（直接读子文件） | ✅ `(message.id, requestId)` | ✅ `mergeSubagentData` | — |
| 递归多层 | 弱（watcher 只扫一层） | ✅ 递归孙 agent | ❌ 只一层 | — |
| **去掉实时后** | **只剩子文件 token** | 不受影响 | 不受影响 | — |

**OBA 智能体亮点**：① 实时智能体树 + 僵尸检测（卡住超 10 分钟标 stale、重启标 interrupted），这种运维向能力三家没有；② 合成根节点让 solo 会话也可见；③ 绕开防双算硬骨头（直接读子文件，不碰主会话 progress 累计）。
**OBA 智能体短板**：① 子 agent 工具明细同样浅；② **事后历史会话智能体树无法重建**（agent_nodes 只来自 hook；JSONL watcher 能事后补子 agent 成本/token，但补不了工具明细与层级关系）；③ 递归不如 ccspan（watcher 只扫一层 subagents/）。

---

## 十、技术亮点与设计权衡（通用工程价值）

> 注：以下亮点多依附于"实时 hook"路线，对本项目（事后分析）多为**理念借鉴**而非可直接复用的功能，详见 §十一。

1. **两条采集链路互补**：hooks 负责实时工具/智能体，JSONL 负责准确成本/token，互不依赖。
2. **202 先返回再写库**：把对 Claude Code 的阻塞从"DB 写完成"解耦到"接收即响应"，hook 延迟恒定。fire-and-forget hook 的关键工程手法。
3. **单写者队列 + WAL**：规避 SQLite `SQLITE_BUSY`，读不走队列、WAL 保证读写并发。
4. **relay.py 极致克制**：纯 stdlib、500ms 超时、永远 exit 0、只发元数据——"侵入式 hook 不能伤害宿主"的最佳实践。
5. **隐私白名单摘要**：明确拒绝捕获 tool_input/tool_response 全文，只派生非敏感摘要（PROJECT.md 把 "Full tool_input capture" 列为安全红线）。**此设计原则对任何展示工具调用的工具都有借鉴价值。**
6. **成本计算细节**：message id 去重、cache write 5m/1h 明细 + flat 兜底、40K autocompact buffer 校准填充率。
7. **僵尸/中断状态机**：启动时残留 active→interrupted，运行期 10 分钟超时→stale，保证 AgentTree 不显示假绿点。

---

## 十一、★ 对本项目的适用性结论（核心）

### 11.1 本项目走的是"事后 JSONL 深度解析"路线

本项目（及 ccspan/ClaudeScope/CSD）目标是**事后**把 Task/Tool/Subagent 的"耗时 + 具体消耗点"挖深——ccspan 的递归树 + 三时长、ClaudeScope 的 tool_use↔tool_result 配对、CSD 的链接去重，都是这条路上的能力。

OBA 走的是**相反的"实时 hook 浅采集"路线**——为实时，主动放弃了事后深度。

### 11.2 去掉"实时"，OBA 几乎无优势

**工具调用维度——几乎归零**：OBA 的工具数据**全部**来自 hooks 喂出的 events 表。不用 hook：① 它根本没有"事后解析 JSONL 的 tool_use/tool_result 重建工具调用"这层代码；② Pre/Post 配对算耗时本身依赖 hook，事后无法复现；③ 命令/文件摘要是 hook 触发时派生的，事后拿不到。其工具调用的"浅"恰恰源于依赖 hook，去掉实时的好处后只剩缺点——而 ClaudeScope 事后配对能拿到完整 tool_result 文本。

**智能体层级维度——只剩子文件 token，且这正是别人做得更细的**：去掉实时后，agent_nodes 树（层级、状态、initial_prompt）全部清空。能事后保留的只有 JSONL watcher 从子 transcript 抽出的子 agent 成本/token——但没有 agent_type、没有层级关系、没有工具明细、不递归。而这一块正是 ccspan（递归树 + promptId 归因）和 CSD（4 来源链接 + 防双算）**做得比它更细**的地方，OBA 无可胜之点。

**两头不靠**：OBA 价值锚点 = 实时 + 侵入式 hook，二者一体。去掉实时，它既没了实时好处，深度又远不如三家事后解析。对本项目功能借鉴价值很低。

### 11.3 仍可借鉴的（仅理念层面）

| 借鉴点 | 性质 | 适用前提 |
|---|---|---|
| **隐私白名单摘要设计原则**（展示工具调用时不泄露文件内容/密钥） | 设计原则 | 任何展示工具调用的工具通用，本项目做"工具调用明细"时应采用同样的边界 |
| **fire-and-forget hook 工程范式**（500ms 超时 / exit 0 / 纯 stdlib / 先 202 再写） | 工程范式 | **本项目不做实时 hook → 无处施展**，仅作了解 |
| **成本计算去重思路**（message id 去重） | 算法思路 | 本项目 token 统计可参考，但应优先采用 ccspan 的 `(message.id, requestId)` 双键方案 |

### 11.4 结论一句话

> **OBA 不适合作为本项目的功能蓝本**。它的工具调用与智能体能力整个建在 hook 实时采集上，与本项目的"事后 JSONL 深度解析"是两条路线。耗时找 ClaudeScope、递归与算力时长找 ccspan、subagent 链接去重找 CSD——这三家已覆盖本项目需求。OBA 唯一值得带走的是"隐私白名单摘要"这个设计原则。

---

*报告基于 v2.4.4 源码静态分析 + 截图确认 + 与 ccspan/ClaudeScope/CSD 三份调研报告交叉对比。*
