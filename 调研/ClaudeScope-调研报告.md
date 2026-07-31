# ClaudeScope 调研报告

> 调研对象：`ClaudeScope-main.zip`（源仓库 `github.com/liuziyu77/ClaudeScope`，主页 `liuziyu77.github.io/ClaudeScope`）
> 定位：**单会话** Claude Code 轨迹可视化（时间 / token / 工具 / 思考）的 **Gradio** 交互应用
> 元信息：v0.1.0 · MIT · 作者 Ziyu Liu（上海交通大学）· Python ≥3.10 · 依赖 pandas + plotly + gradio
> 调研日期：2026-07-30
> 验证方法：源码逐行通读 + 在本机 141 个真实会话（27,772 条 assistant 事件）上探测 schema

---

## 1. 概览

ClaudeScope 把 Claude Code 存在 `~/.claude/projects/<slug>/<sessionId>.jsonl` 的会话文件，解析成 4 个交互视图，回答 *agent 做了什么、何时、花了多少 token、成没成*。它的真正价值不在 UI，而在**解析层**：把扁平、可能乱序、偶尔损坏的 JSONL 事件，重建成以"轮次（Turn）"为骨架的结构化树，并通过 `tool_use` ↔ `tool_result` 配对还原**每次工具调用的真实墙钟耗时**。

差异化定位：相比只算 token / 钱的工具，ClaudeScope 把**时间线**和**逐事件检查器**做得细致；但它是**单会话**视角，没有跨会话聚合、成本估算、子 agent 还原。

---

## 2. 核心能力（4 个视图）

| 视图 | 内容 | 数据来源 |
|------|------|---------|
| **会话选择/上传** | 下拉浏览本地所有会话（按 mtime 倒序，标注项目/会话/大小）或上传 `.jsonl`，实时显示一行摘要 | `paths.py` 扫描 + `summary()` |
| **Timeline（甘特图）** | 每个事件按泳道（User / Text / Thinking / Tool:\<Name\>）铺开，x 轴真实时间，错误标 `✗` | `gantt_events()` → Plotly `px.timeline` |
| **Tokens** | 每条消息的 input / cache_read / cache_creation / output 堆叠面积图 + 累计 output 虚线（右轴） | `token_series()` |
| **Tools** | 每个工具的调用次数 + 总耗时柱状图，hover 带错误数 | `tool_stats()` |
| **事件检查器** | 下拉任一事件，看完整内容（user prompt / assistant thinking+tool input / tool result） | `_build_details()` |

---

## 3. 数据来源与解析

Claude Code 每个顶层会话写一个 JSONL，每行一个事件。事件有 `type`：`user` / `assistant` / `system` / `progress` / `file-history-snapshot` 等。ClaudeScope 解析的关键字段（`parser.py`）：

| 字段 | 用途 | ClaudeScope 是否读取 |
|------|------|:---:|
| `timestamp` | 排序、算 wallclock、给每个 block 定位时间 | ✅ |
| `type` | 分类（只保留 user/assistant，其余进 skip 计数） | ✅ |
| `message.content`（block 数组） | text / thinking / tool_use / tool_result 的结构来源 | ✅ |
| `message.usage` | input / cache / output token + service_tier + ephemeral | ✅（部分，见 §8） |
| `subtype: turn_duration` 的 `durationMs` | Claude 引擎自测的真实算力时间 | ✅ |
| `cwd` / `gitBranch` / `version` / `sessionId` | 会话级元数据（first-seen-wins） | ✅ |
| **顶层 `toolUseResult`** | **所有工具的结构化结果**（Bash stdout/stderr、Edit diff、Agent 汇总…） | ❌ **完全没读** |
| `isSidechain` | 子 agent 标记 | ⚠️ 读但实际无效（见 §8） |

> ⚠️ 关键事实：**顶层 `toolUseResult` 字段在本机出现 11,298 次**，是所有工具结果的结构化金矿，ClaudeScope 一个都没用——它只读 `message.content` 里的 tool_result 文本。这是它最大的解析盲区（详见 §8）。

---

## 4. ★ 解析层详解（最大亮点）

`parser.py`（约 400 行，**除 pandas 外零第三方依赖**）是整个工具的技术核心，分两遍处理：

### 4.1 第一遍：读行 → 容错 → 过滤
- 逐行 `json.loads`，损坏行不崩溃，记入 `parse_warnings` 跳过。
- 提取会话级元数据（`sessionId` / `cwd` / `gitBranch` / `version`，first-seen-wins）。
- 过滤噪声事件进 `skipped_counts`：`progress` / `permission-mode` / `queue-operation` / `last-prompt` / `attachment` / `file-history-snapshot` + 非 `turn_duration` 的 `system`。
- 抢救 `system/turn_duration` 的 `durationMs` → `system_turn_durations_ms`。
- 只留 `user` / `assistant` 进第二遍。

### 4.2 时间排序
按 `timestamp` 稳定排序，对抗真实文件里偶尔的乱序行。

### 4.3 第二遍：重建 Turn 树 + 工具配对（核心算法）
维护 `current`（当前 Turn）与 `pending`（`{tool_use_id: (block, ts_start)}`）两个状态：
- **assistant 事件**：解析 model / blocks / usage；`is_sidechain=true` 的进 `sidechain_msgs`，不污染主线；否则挂入当前 Turn，并把 `tool_use` 块登记到 `pending`。
- **user 事件——关键判定**：靠 content 形态区分"用户在打字"（str 或无 tool_result 的 list → **新 Turn**）vs"工��结果回执"（含 tool_result 的 list → 挂当前 Turn）。回执到来时，按 `tool_use_id` 从 `pending` 取出当初登记的块，组装成 `ToolCall`：
  - `ts_start` = assistant 发起调用的时刻
  - `ts_end` = tool_result 回来的时刻
  - → 得到**这次工具调用的真实耗时**

> 这是 ClaudeScope 最值钱的能力：tool_use 的发起和结果分记在两行（一行 assistant、一行 user），它靠 `tool_use_id` 把两者**缝合成一次完整调用并算出耗时**。

### 4.4 产出数据模型
一棵以 Turn 为骨架的树：`Session → Turn(user_msg, assistant_msgs[], tool_calls[])`，外加 `sidechain_msgs` / `unmatched_tool_uses` / `system_turn_durations_ms` / `skipped_counts` / `parse_warnings`。`Usage` 还细分了 5m / 1h 临时缓存。

---

## 5. 分析层与可视化

| 模块 | 行数 | 职责 |
|------|:---:|------|
| `analyzer.py` | ~290 | `summary()`（SessionSummary dataclass）、`gantt_events()` / `token_series()` / `tool_stats()` → 纯 pandas DataFrame |
| `viz.py` | ~165 | 3 个 Plotly figure 工厂（figure 即 JSON，可 1:1 迁到 Plotly.js） |
| `app.py` | ~330 | Gradio UI：下拉/上传/Tab/事件检查器 |
| `paths.py` | ~50 | 扫描 `~/.claude/projects` |

`analyzer` 的 pandas 用得很浅（sort / cumsum / quantile / group），无不可替代操作，迁 TS 不难。

---

## 6. 架构与工程质量

- **纯净分层**：数据层（paths/parser/analyzer）**零 UI 依赖**，README 明确设计为可独立用于自建 dashboard。这正好对应未来 Electron 的"主进程/渲染进程"分层。
- **测试扎实**：16 个 pytest 用例 + `mini_session.jsonl` 固定样本，覆盖解析结构、工具配对、usage、截断、sidechain、token 序列、汇总。本机实测 **16 全过**。
- **类型化**：大量 `@dataclass(frozen=True, slots=True)`，结构清晰，易翻译成 TS interface。
- **健壮性**：损坏行/乱序/缺失均不崩，且都有记录可查（`parse_warnings` / `skipped_counts` / `unmatched_tool_uses`）。

---

## 7. 亮点

1. **工具调用配对 → 真实耗时**——别人替你踩坑换来的核心能力。
2. **Turn 重建**——靠 content 形态区分用户输入 vs 工具回执，把扁平事件重组成对话轮次。
3. **数据/UI 干净解耦**——解析层可独立复用，是后续重写/移植的理想地基。
4. **Plotly figure 即数据**——可视化层可无损迁到 Plotly.js（Web/Electron 友好）。
5. **容错与可观测**——坏数据不崩，且留下诊断记录。

---

## 8. 局限与空白（关键——结合报告的起点）

以下结论均由本机 141 个真实会话探测得出，非源码推测：

| # | 空白 | 实测证据 | 影响 |
|---|------|---------|------|
| 1 | **顶层 `toolUseResult` 完全没读** | 出现 11,298 次；含 Bash `stdout/stderr/interrupted`、Edit `oldString/newString/structuredPatch`、Agent `agentId/totalDurationMs/totalTokens` | 丢失所有工具的结构化结果，被迫从文本抠 exit code |
| 2 | **子 agent 处理是死代码** | 141 文件里 `isSidechain=true` **0 个**；真实子 agent transcript 在 `<project>/<session>/subagents/`（54 目录、1,211 文件），靠 `toolUseResult.agentId`（442 个）链接 | sidechain 收集永远空；无法还原子 agent |
| 3 | **漏识 4 类事件** | `file-history-delta`（735）、`ai-title`（2491）、`mode`（3501）、`agent-name`（113）落入兜底 else 被丢弃 | 丢文件变更增量、可读会话标题、运行模式、子 agent 命名 |
| 4 | **usage 丢 4 个字段** | `server_tool_use` / `iterations` / `speed` / `inference_geo` 真实存在但未映射 | 成本估算不准（漏 server 工具计费）、丢推理强度/地域 |
| 5 | **结果截断 5KB** | `_RESULT_PREVIEW_LIMIT = 5*1024`；真实 Agent 报告最长 8KB+ | 每条子 agent 汇报被切尾 |
| 6 | **图片结果丢弃** | `tool_result` 里 `list[image]` 104 次（截图） | 看不到 playwright/pencil 截图结果 |
| 7 | **单会话视角** | 无跨会话聚合层 | 无法做项目级/跨会话对比、Top 会话 |
| 8 | **会话级 cwd** | 79/141 文件会话中途 cwd 变化；ClaudeScope 只取首个 | 时长/token 无法归因到当时的工作目录 |
| 9 | **无成本、无 prompt 归因** | 无定价层、无 `promptId` 归因 | 无法回答"花了多少钱""哪个 prompt 触发了什么" |

---

## 9. 对本项目的启示

**ClaudeScope 的解析层是一个"偏统计友好"的扎实地基**：把"时间线 + token + 工具耗时"这条主线做得干净，所以它的 4 个视图都围绕这三者。

- **高复用部分（≈85% 骨架）**：事件循环、JSON 容错、时间戳排序、Turn 重建、`tool_use`/`tool_result` 配对、datetime 处理——无论后续做什么功能都跑不掉，且已被测试锁定。
- **需扩展部分**：① 停止丢弃被忽略的事件类型（改 skip-list，易）；② Usage 补字段（易）；③ 按工具名特化抽取 + 读顶层 `toolUseResult`（中）；④ 子 agent 跨文件链接（需引入 ccspan 的发现机制，见结合报告）。

> 一句话：ClaudeScope 适合作为**解析内核**复用，但它对子 agent 和结构化工具结果是盲区——这两块正是 [[ccspan-调研报告]] 已验证可行、且互补的部分。
