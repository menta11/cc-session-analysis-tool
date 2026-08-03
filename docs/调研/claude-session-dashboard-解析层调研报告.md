# Claude Session Dashboard 解析层调研报告（聚焦 Task / Tool / Subagent 解析 + 链接去重）

> 调研对象：`claude-session-dashboard-main.zip`（源仓库 `github.com/dlupiak/claude-session-dashboard`）
> 本报告**只讲解析层**（scanner / parser / linking / dedup），刻意裁掉 UI、成本、活跃检测、stats-cache 这些与本项目无关的部分。
> 关联文档：[[ClaudeScope-调研报告]] · [[ccspan-调研报告]] · [[ClaudeScope+ccspan结合-调研报告]]
> 调研日期：2026-07-30
> 价值定位：**核心解析层不对路（摘要/频次导向，不算耗时、不做逐 call 细节、不做 task 归因），但其 subagent 链接 + token 防双算两块细节比另两家做得细，值得作为结合方案「发现/链接」与「去重」章节的补充素材。**

---

## 0. 一句话定位

CSD 的解析层是**"会话摘要 + 频次统计"**导向，为 Web 看板服务：擅长回答"这个会话总共花了多少 token、用了哪些模型、工具调了几次"，**不擅长回答"每次调用花了多久、具体做了什么、归到哪个任务"**。本项目要的恰恰是后者，所以 CSD 的 parser **不能当蓝本**，但有两个正确性细节值得搬。

### 按本项目三个目标的完成度

| 目标 | CSD 解析出了什么 | 有「时间」？ | 有「具体消耗点」？ |
|---|---|:---:|:---:|
| **Tool** | `toolFrequency{name:次数}`、每 turn 的 `toolCalls{name,id,input}` | ❌ 不配对 tool_use↔tool_result、不读 `turn_duration` | ❌ 顶层 `toolUseResult` 只取 agent 字段，Bash/Edit/Grep 结构化结果不读 |
| **Subagent** | Task/Agent 调度 + agentId 链到子文件 + 子文件 tokens/工具次数/model/skills | △ 只有 `totalDurationMs` 汇总，无算力时长；agent 内工具"均匀撒点"非真实时刻 | △ 聚合级（Bash×5），无逐 call；**只展开一层、不递归** |
| **Task** | TaskCreate/Update → `{subject, status, ts}` | ❌ 零时间归因 | ❌ 零消耗点（task 与工具/agent 完全不关联） |

→ Tool 耗时找 **ClaudeScope**；Subagent 递归树/算力时长找 **ccspan**；Task 归因**三家都没做**（ccspan 的 prompt-cascade 最接近，需自己改造）。CSD 只在「**subagent 链接**」和「**token 去重**」上提供补充价值。

---

## 1. 解析层整体结构（裁剪后）

```
~/.claude/projects/<dir>/
  ├── <sessionId>.jsonl            ──┐
  └── <sessionId>/                 │
      └── subagents/
          └── agent-<agentId>.jsonl ──┘  subagent-discovery.ts 扫描

数据流：
  project-scanner.ts ─→ session-scanner.ts ─→ session-parser.ts
   (发现项目/会话文件)    (summaryCache)        parseSummary()  头15+尾15 行
                                              parseDetail()   全量流式
                                              parseOutputTokens() 轻量计数
                                                              │
   active-detector.ts (mtime<2min + lock 目录)                │
                                                              ▼
                          agentId 多来源 ──→ subagent-discovery ──→ parseSubagentDetail()
                          (4 个兜底)        (Map<agentId,file>)     (skills/tokens/tools)
                                                              │
                                                              ▼
                                              mergeSubagentData()  ★防双算
```

---

## 2. 发现层（scanner / discovery）—— subagent 还原的地基

### 2.1 subagent 文件发现（`subagent-discovery.ts`，44 行，可直接借鉴）

```ts
const AGENT_FILE_PATTERN = /^agent-(.+)\.jsonl$/
// 候选目录：sessionDir/subagents/ 优先，回退 sessionDir/agents/
const candidateDirs = [join(sessionDir,'subagents'), join(sessionDir,'agents')]
// → 返回 Map<agentId, 绝对路径>；同名 agentId 取 subagents/ 优先
```

**要点（对结合方案有用）**：
- `sessionDir = <projects>/<projectDir>/<sessionId>`，即 `<project>/<session>/subagents/`——**正好踩中本机真实布局**（结合报告 §6 指出 ccspan 文档写的是浅一层，CSD 这里路径是对的）。
- agentId 直接来自**文件名**（`agent-<id>.jsonl`），无需启发式匹配，与 ccspan/结合方案的结论一致。
- 回退 `agents/` 目录：兼容不同版本目录命名。

### 2.2 会话级摘要缓存（`session-scanner.ts`）

- `summaryCache: Map<sessionId, {mtimeMs, summary}>`，按文件 mtime 失效——**扫 100+ 会话不重复解析**。
- 路径解码 `decodeProjectDirName()`：`-Users-foo-x` → `/Users/foo/x`，并能识别 Windows 盘符（`/C/Users` → `C:/Users`）。
- ⚠️ 摘要用"头 15 + 尾 15 行"（`HEAD_LINES/TAIL_LINES=15`），是为**列表页性能**优化的；本项目做耗时分析需要**全量解析**，这层缓存可借鉴但摘要策略不适用。

---

## 3. ★ Subagent 链接机制（最值钱，4 个 agentId 兜底来源）

CSD 把"主会话里的 Task/Agent 调度"和"子 transcript 文件"用 `agentId` 缝合。它的 `agentIdByToolUseId` 从**四个来源**累积，按 `toolUseId` 索引，这是它比 ccspan 单一来源更全的地方：

| # | 来源 | 触发场景 | 代码位置 |
|---|------|---------|---------|
| 1 | **progress 消息** `data.agentId`，按 `parentToolUseID` 挂到 Task/Agent 的 tool_use_id | 前台同步 agent（旧版本 ≤2.1.63 有 progress） | `session-parser.ts:198-201` |
| 2 | **tool_result 文本正则** `agentId:\s*([\w-]+)` | **后台异步 agent（不发 progress，唯一来源）** | `:436-441` |
| 3 | **顶层 `toolUseResult.agentId`** | 结构化结果 | `:448-450` |
| 4 | **TaskOutput 的 `toolUseResult.task.task_id`**（有 `retrieval_status` 时） | 异步 agent 完成回查 | `:453-455` |

> **关键事实（结合报告 §6 印证）**：后台异步 agent 不发 progress 消息，只能靠来源 2（tool_result 文本里那段 `agentId: xxxxx (internal ID...)`）。CSD 用正则兜住了它。本项目还原 async 子 agent 时**必须抄这一招**。

链接后流程（`session-parser.ts:507-539`）：
```
对每个 agent dispatch:
  agentId = agentIdByToolUseId[toolUseId]   // 4 来源兜底
  file    = subagentFileMap[agentId]         // 文件名直对应
  detail  = parseSubagentDetail(file)        // 抽 skills/tokens/tools/model
  mergeSubagentData(agent, detail, progressTokens, totalTokens, tokensByModel)
```

---

## 4. ★ Token 去重与防双算（第二值钱）

### 4.1 requestId 去重（单键）

CSD 用 `seenRequestIds` 在 **assistant 消息**和 **progress 消息**两处都去重：同一个 API 调用会在 JSONL 多行重复，按 `requestId` 只计一次（`:181-182`、`:210-212`、`:354-356`）。
> ⚠️ 结合报告 §6 实测本机**无 requestId**，ccspan 用 `(message.id, requestId)` 双键、退化成 `message.id` 单键。**本项目应采用 ccspan 的双键方案**（更稳），CSD 的单 requestId 方案在本机数据上会失效。

### 4.2 主/子 token 防双算（`mergeSubagentData`，:843-904）—— 真正的硬骨头

问题：旧版本里子 agent 的 token **既**出现在主会话的 progress 消息里（已被累加进 `totalTokens`/`tokensByModel`），**又**会出现在子 transcript 里——直接相加会翻倍。

CSD 的解法（抄）：
```
若子文件有 tokens 且 progress 之前已计入:
  1. 从 totalTokens 减掉 progressTokens          ← 先抵消
  2. 从 tokensByModel[progressModel] 减掉         ← 同模型键精确抵消
  3. 再把子文件 detail.tokens 加进 totalTokens     ← 换成更准的子文件值
  4. 加进 tokensByModel[detail.model]
若子文件无 tokens：保留 progressTokens（用旧版本数据兜底）
```
> 这是"用子文件更准的值替换主会话 progress 的近似值"的精细逻辑。本项目做跨主+子聚合时**必抄**，否则 token 必双算或留近似值。注意：`progressModel` 必须用当初累加 progress 时的同一个 model 键，否则第 2 步抵消错位。

### 4.3 孤儿子 agent（orphan）处理（:542-586）—— 容错

`subagents/` 里有些文件**匹配不到任何主会话 Task/Agent 调度**（workflow 派生、链接丢失等）。CSD 不丢弃：
- 仍 `parseSubagentDetail`；
- 若有意义活动（有 token/skill/工具），push 一个 `subagentType:'unknown'` 的合成 agent；
- token/工具并入会话级合计。

> 结合报告 §7 列了这个风险（async agent 链接不稳定）。CSD 的 orphan 兜底是"什么都不丢"的实现范本，本项目递归建树时应照此处理未匹配节点。

---

## 5. Task 解析（CSD 只提取、不归因——本项目需自建）

CSD 对 Task（TaskCreate/TaskUpdate 待办系统）的处理**只到元数据**：
- TaskCreate input → `{subject, description, activeForm, status:'pending', timestamp}`（`:316-328`）
- TaskUpdate input → 更新对应 task 的 status（`:331-338`）
- **回填 taskId**：靠 tool_result 文本正则 `Task #(\S+) created successfully`，把 `pendingTaskByToolUseId[toolUseId]` 的 task 绑上真实 ID（`:421-429`）

**致命缺口（本项目要自己补）**：
- Task **没有开始/结束/时长**——只有一个创建时间戳。
- Task **与"为它执行的工具/agent"完全无关联**——`tasks[]` 是独立数组，不引用任何 `turns/tools/agents`。

> 要做"Task 的消耗时间 + 消耗点"，必须自己建归因：以 task 的创建→完成时间窗（或创建→下一个 task 创建）为区间，把其间发生的 tool_calls / agent dispatch 挂到 task 上。**三家都没做这件事**，是本项目的差异化机会，CSD 在此**零帮助**（只能借鉴它提取 task 元数据 + 回填 ID 的那点正则）。

---

## 6. Tool 解析（CSD 弱——耗时要找 ClaudeScope）

- `toolFrequency: Record<工具名, 次数>`：仅计数（`:283`）。
- 每 turn `toolCalls[]`：只有 `{toolName, toolUseId, input}`（`:278-283`），**无 tsEnd、无 result、无耗时**。
- 顶层 `toolUseResult`：**只**挖 agent 字段（`totalTokens/totalToolUseCount/totalDurationMs/agentId`），**不**读 Bash stdout/Edit diff/Grep 命中（`:444-464`）——与 ClaudeScope 同一盲区。

> 单次工具真实耗时 = tool_use（assistant 行）↔ tool_result（user 行）按 `toolUseId` 配对，算 `ts_end - ts_start`。**这正是 ClaudeScope 的核心能力**，CSD 完全没做。本项目此维度直接以 ClaudeScope 为蓝本。

---

## 7. 版本兼容与"交互/任务会话"区分（可借鉴的小细节）

### 7.1 Task → Agent 工具名变迁
`AGENT_DISPATCH_TOOL_NAMES = new Set(['Task','Agent'])`（`:20`）：
- ≤2.1.63：用 `Task` 工具派发，progress 消息带 agent 数据；
- ≥2.1.68：改用 `Agent` 工具，**不发 progress**，子 transcript 是唯一 token/tool 来源。

**CSD 同时支持两种**：既从 progress 累计（旧），又读子文件（新），靠 §4.2 的 merge 防双算——**版本无关**。本项目解析应同样兼容两种来源。

### 7.2 区分"交互会话" vs "任务/子 agent 会话"
子 agent transcript 文件**本身就是会话**。CSD 用一个信号区分（`:51-57`、`:142-148`）：
```ts
if (raw.type === 'queue-operation') isInteractive = false
```
> 配合"是否位于 `subagents/` 目录"，可可靠区分主会话与子 agent 会话，避免把子 agent 当成独立主会话重复计入。本项目扫描层值得加这个 flag。

### 7.3 上下文窗口快照（可选，token 维度的"消耗点"）
`buildContextWindowData`（`:782-807`）按 assistant turn 记 `contextSize = input + cacheRead + cacheCreation` 的增长序列，并算 `usagePercent` / autocompact buffer(16.5%)。
> 这是 **token 维度**的消耗点视图（非时间维度）。若本项目要"上下文膨胀"分析可借鉴，但与"耗时"无关，按需取舍。

---

## 8. 对 ClaudeScope×ccspan 结合方案的补充（映射到 §9 模块）

| 结合方案模块（§9.3） | CSD 可补充的点 | 抄 or 不抄 |
|---|---|---|
| `discovery/agentIndex.ts` | 4 来源 agentId 兜底（§3）；`<project>/<session>/subagents/` 正确路径 + `agents/` 回退（§2.1） | ✅ **抄**——比 ccspan 单一来源全，尤其 async agent 的 tool_result 文本正则 |
| `aggregate/dedup.ts` | 主/子 token 防双算的「先减 progress 再加子文件」逻辑（§4.2）；orphan 节点不丢弃（§4.3） | ✅ **抄**——跨主+子聚合的正确性硬骨头 |
| `aggregate/dedup.ts` | requestId 单键去重 | ❌ **不抄**——本机无 requestId，用 ccspan 的 `(message.id, requestId)` 双键更稳 |
| `parser/`（Turn/工具配对/耗时） | 无 | ❌ CSD 不做耗时，**以 ClaudeScope 为蓝本** |
| `aggregate/durations.ts`（三时长） | 无 | ❌ CSD 无 turn_duration，**以 ccspan 为蓝本** |
| `aggregate/cascade.ts`（task/prompt 归因） | 仅 task 元数据提取 + `Task #X created` 回填正则（§5） | △ **只借正则**，归因逻辑自建 |
| 子 agent 递归（孙 agent） | 无（CSD 只一层） | ❌ **以 ccspan 递归树为蓝本** |

---

## 9. 值得搬 vs 不要搬（总表）

### ✅ 值得搬到本项目解析层
1. **agentId 4 来源链接**（progress `data.agentId` / tool_result 文本正则 / `toolUseResult.agentId` / `task.task_id`）——尤其 async agent 的文本正则兜底，ccspan 没有。
2. **主/子 token 防双算**（`mergeSubagentData` 的 subtract-then-add）+ **orphan 节点兜底**——跨主+子聚合的正确性保险。
3. **subagents/ + agents/ 双目录发现**与文件名即 agentId 的直对应。
4. **Task 元数据提取 + `Task #X created` 回填**（task 归因的起点正则）。
5. **版本无关设计**：同时吃 progress（旧）与子文件（新）。
6. **`queue-operation` 标记**区分交互/子 agent 会话。

### ❌ 不要搬
1. 单 `requestId` 去重（本机无 requestId → 用 ccspan 双键）。
2. 头/尾摘要解析（为列表页优化，耗时分析需全量）。
3. Tool 耗时（CSD 没做 → ClaudeScope）。
4. 三时长 / turn_duration（CSD 没有 → ccspan）。
5. 子 agent 递归树（CSD 只一层 → ccspan）。
6. 结构化 `toolUseResult`（CSD 同 ClaudeScope 盲区 → 本项目需自建按工具名特化抽取）。

---

## 10. 结论

> **CSD 的解析层对本项目主目标（Task/Tool/Subagent 的耗时 + 消耗点）基本不对路**——它是摘要/频次导向的统计 parser，不算耗时、不做��� call 细节、不做 task 归因。耗时找 ClaudeScope、递归与算力时长找 ccspan、task 归因自建。
>
> **它的补充价值集中在两处**：① **subagent 链接的多来源兜底**（尤其 async agent 的 tool_result 文本正则）；② **跨主/子 token 的防双算与 orphan 兜底**。这两块比 ccspan 做得更细，建议作为结合方案「发现/链接」与「去重」章节的实现参考，其余不必花时间。
