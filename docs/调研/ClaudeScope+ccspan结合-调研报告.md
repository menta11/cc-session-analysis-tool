# ClaudeScope × ccspan 结合调研报告

> 目的：评估将 **ClaudeScope**（结构化解析内核）与 **ccspan**（子 agent 发现 / 归因 / 时长外壳）结合后带来的优势
> 关联文档：[[ClaudeScope-调研报告]] · [[ccspan-调研报告]]
> 调研日期：2026-07-30
> 验证基础：本机 141 个真实会话 + 1,211 个子 agent transcript 实测

---

## 1. 背景与动机

两个工具恰好是镜像互补关系：

| 工具 | 擅长 | 自陈缺口 |
|------|------|---------|
| **ClaudeScope** | 单会话**逐事件**深度解析（Turn 树、工具配对算耗时、Plotly 可视化） | 子 agent、成本、跨会话、结构化工具结果 |
| **ccspan** | **跨会话**聚合、子 agent 发现与递归树、三时长模型、prompt-cascade 归因、成本可插拔 | 子 agent"**做了什么**"（§6.4 原话："数据其实都在，只差一层没展开"） |

**核心洞察**：ccspan 留下的最大空白——"子 agent 做了什么 + 每步耗时"——**正好是 ClaudeScope 解析器的天然产出**。把 ClaudeScope 的解析逻辑套用到 ccspan 发现的每个子 agent transcript 上，空白就被填上。1+1 > 2。

---

## 2. 能力互补矩阵

| 能力维度 | ClaudeScope | ccspan | 结合后 |
|---------|:---:|:---:|:---:|
| 结构化解析（Turn / 工具配对 / 逐 Call 细节） | ✅ 强 | ❌ 只折 token | ✅ **用 C** |
| 子 agent **发现 + 链接 + 递归树** | ❌（死代码） | ✅ 已验证 | ✅ **用 cc** |
| 子 agent **"做了什么"展开** | ❌ 没做 | ❌ 主动丢弃 | ✅ **C 解析器填空** |
| 顶层 `toolUseResult` 结构化结果 | ❌ 没读 | 部分 | ✅ **新工具独占红利** |
| 三时长模型（wall / active / compute） | ❌ | ✅ | ✅ **用 cc** |
| prompt-cascade 归因 | ❌ | ✅ | ✅ **用 cc** |
| 成本估算 | ❌ | ✅（可插拔） | ✅ **用 cc** |
| 跨会话 / 项目级聚合 | ❌ | ✅ | ✅ **用 cc** |
| 富交互可视化（Gradio/Plotly） | ✅ | ❌（TUI） | ✅ **用 C** |
| 全局去重 + per-event cwd 归因 | ❌ | ✅ | ✅ **用 cc** |

---

## 3. ★ 结合后的核心优势

### 优势 1：子 agent 深度还原（链接 + 递归 + 逐 Call 细节）
- **链接已验证**：父文件 `toolUseResult.agentId`（442 个）→ 子文件 `agent-<id>.jsonl`（1,211 个），文件名直接对应。
- **递归可行**：子 agent transcript 与主会话是**同一种 JSONL 格式** → ClaudeScope 的 `parse_jsonl` 可递归套用，孙 agent 也能展开。
- **细节补全**：ccspan 只折 token（且 async agent 的 `toolStats` 为 null），结合后每个子 agent 都能展示"Bash×5 · Read×3 + 每步耗时 + 命令/文件/结论"——这正是 ccspan §6.4 自陈没做的部分。

### 优势 2：顶层 `toolUseResult` 结构化红利（两边都没用好）
本机 11,298 次 `toolUseResult` 直接给出结构化结果，结合后独占：
- **Bash** → `stdout / stderr / interrupted`（不用再从文本抠 exit code）
- **Edit** → `oldString / newString / filePath / structuredPatch`（**现成 diff，文件变更追踪零成本**）
- **Grep/Glob** → `numFiles / filenames / totalMatches`
- **Agent** → `agentId / agentType / totalDurationMs / totalTokens / totalToolUseCount`
- **TodoWrite / AskUserQuestion / Workflow** 等也都有结构化字段

→ 把上一份报告里"文件变更/命令详情"两项从"需文本解析 ⭐⭐"降级为"结构化直读 ⭐"。

### 优势 3：Prompt-cascade 归因（用户 prompt → 触发了什么的故事树）
ccspan 用 prompt 把一天切成段，每段下挂它 spawn 的工具/子 agent（递归）。结合 ClaudeScope 的逐 Call 细节后，可拼出完整链路：

```
用户 prompt "重构 X"
├─ Bash ×3（ccspan 只给计数，结合后给每条命令 + 结果）
├─ Agent:developer "Wave 1"  → 子 Session（ccspan 只给耗时/token，结合后给完整步骤树）
│   └─ Edit file_a (structuredPatch) ...
└─ Agent:reviewer "Review"   → 子 Session ...
```

### 优势 4：时长双保险（ccspan 算力时长 + ClaudeScope 逐 Call 耗时）
- ccspan 的 `compute`（Σ `turn_duration.durationMs`）给**轮次级**真实算力时间。
- ClaudeScope 的工具配对给**单次工具调用级**耗时（`ts_end - ts_start`）。
- 两者颗粒度互补：既能看"这轮花了多久"，又能定位"是哪个 Bash 调用卡住了"。

### 优势 5：成本可插拔 + token 细分
- ccspan 的 `costProvider` 接口（CodeBurn 外壳 + 优雅降级 + 预留内置定价表）直接复用，成本不是硬依赖。
- ClaudeScope 的 Usage 细分（input/cache_read/cache_creation/output + ephemeral）+ 补齐 `server_tool_use`（计费项）后，成本估算比两者单独都准。

### 优势 6：双形态输出（富 UI + 脚本/JSON）
- ClaudeScope 的 Plotly/Gradio 给**交互式富可视化**（甘特图、堆叠面积、事件检查器）。
- ccspan 的 CLI / `--json` / `--plain` 给**脚本化与机器可读**。
- 结合后同一数据内核既能在桌面 UI 里钻取，又能 pipe 进报表/告警。

### 优势 7：正确性硬骨头由 ccspan 兜底
- **全局去重** `(message.id, requestId)`（避免 resumed 会话重放双算）。
- **时长只取主线程**（子 agent 与主线程并发，否则墙钟双算）。
- **per-event cwd 归因**（79/141 会话中途换目录）。
- 这三件 ClaudeScope 完全没做，ccspan 已踩平。

---

## 4. 结合架构设计

关键优雅点：**子 transcript 与主会话同格式，parser 递归复用**。

```
┌─────────────────────────────────────────────────────────────┐
│  发现层（来自 ccspan 的 scan/cascade，改造）                  │
│  扫 ~/.claude/projects/<slug>/<sessionId>/subagents/**/*.jsonl│
│  建 agentId → child_file 索引；prompt 分段（时序，见 §6）     │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  解析内核（来自 ClaudeScope 的 parser，扩展）                 │
│  parse_jsonl(file)  ← 同一函数递归用于主会话与每个子 transcript│
│   · Turn 重建 + tool_use/tool_result 配对（已有）            │
│   · 新增：读顶层 toolUseResult → 结构化 ToolCall 结果        │
│   · 新增：遇到 Agent tool_use + toolUseResult.agentId        │
│           → 查索引 → parse_jsonl(child) → 挂到 child_session │
│           → 递归（孙 agent）                                 │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  聚合/归因层（来自 ccspan 的 aggregate + ClaudeScope analyzer）│
│  三时长模型 · token/成本 · prompt-cascade · 全局去重         │
└─────────────────────────────────────────────────────────────┘
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
   渲染：富 UI（Plotly/Gradio 或 Electron）  CLI/JSON（ccspan render）
```

**产出数据模型**：一棵递归 Session 树
```
Session
└─ Turn
   ├─ user_msg
   ├─ assistant_msgs[] → blocks(text/thinking/tool_use)
   └─ tool_calls[]
       ├─ 结构化结果（toolUseResult）   ← 新
       └─ child_session: Session | None ← 新（Agent 调用才有，递归）
```
ClaudeScope 现有的扁平 Turn 树，只需加两个指针字段（`structured_result` + `child_session`）即可升级。

---

## 5. 数据流蓝图（一次查询的完整路径）

1. `scan` 发现主会话 + 所有 `subagents/**` 子 transcript，建 `agentId` 索引。
2. `parse_jsonl(主会话)` → 主 Session 树。
3. 遍历主树中的 `Agent` tool_call → 取 `toolUseResult.agentId` → 命中索引 → `parse_jsonl(子文件)` → 挂为 `child_session`（递归到叶）。
4. `aggregate`：按 prompt 分段归因、算三时长、折 token、join 成本、全局去重。
5. `render`：富 UI 钻取 或 CLI/JSON 输出。

---

## 6. 针对本机数据的适配点（版本差异，不阻塞）

ccspan 报告基于其作者数据，本机实测有几处不同，迁移时需适配：

| ccspan 报告说法 | 本机实际 | 适配方式 |
|----------------|---------|---------|
| 子 transcript 在 `<session>/subagents/` | 在 `<project>/<session>/subagents/`（深一层，还有 `workflows/wf_<id>/` 子层） | 修正扫描路径与递归 glob |
| `promptId` 工具/agent 事件也带（100%） | **只在 `user` 事件上有**（12,980 全在 user） | cascade 归因改用**时序分段**（两 prompt 之间活动归前者），不靠 promptId join |
| 去重键 `(message.id, requestId)` | **无 requestId** | 退化为 `message.id` 单键去重 |
| Agent 结果带 `toolStats` 拆分 | **async agent 的 `toolStats` 为 null** | async 子 agent 必须读 transcript 才有工具拆分（正好走结合架构）；同步完成的 agent 父文件已带汇总 |

---

## 7. 风险与权衡

| 风险 | 说明 | 对策 |
|------|------|------|
| 复杂度上升 | 引入跨文件发现 + 递归解析 + 归因 | 分层保持纯函数（学 ccspan），解析内核零 UI 依赖（学 ClaudeScope） |
| async agent 的 `outputFile` 不稳定 | 部分 `.output` 文件已被清理（存在性不一致） | 不依赖 outputFile，统一走 `subagents/agent-*.jsonl`（稳定存在） |
| 两套输出形态维护成本 | 富 UI + CLI 双前端 | 共享同一"解析+聚合"内核，前端薄壳化 |
| 子 agent 树可能很深 | workflow 派生多级 | UI 默认折叠 + 懒加载；JSON 完整递归输出 |

---

## 8. 结论与推荐配方

**强烈建议结合。** 推荐配方：

> **ClaudeScope 的 `parser` 做解析内核（递归复用到子 agent），ccspan 的 `scan` / `cascade` / `aggregate` 做发现与归因外壳，再把两边都没用的顶层 `toolUseResult` 收为结构化结果的主通道，最后双前端（富 UI + CLI/JSON）共享同一内核。**

预期收益：
- **子 agent 深度树**：从"可能做不了"→ **确定可行**（链接 + transcript + 递归格式三齐）。
- **文件变更 / 命令详情**：从"文本解析"→ **结构化直读**（`structuredPatch` / `stdout` 现成）。
- 整体难度**下一个台阶**，基本无硬骨头。
- 单独看，ClaudeScope 看不到子 agent 与成本，ccspan 看不到子 agent 的"作为"；结合后是**唯一同时具备"全链路归因 + 逐事件细节 + 子 agent 深度还原 + 成本"**的方案。
