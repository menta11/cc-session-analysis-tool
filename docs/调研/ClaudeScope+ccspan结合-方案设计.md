# ClaudeScope × ccspan 结合工具 · 方案设计

> 文档类型：方案设计（重写蓝图）
> 目标产物：**Win + Mac 双端通用**的 Claude Code 会话分析桌面工具（+ CLI/JSON 模式）
> 技术基础：ClaudeScope 解析内核（TS 重写，递归到子 agent）+ ccspan 发现/归因 + 顶层 `toolUseResult` 结构化
> 关联文档：[[ClaudeScope-调研报告]] · [[ccspan-调研报告]] · [[ClaudeScope+ccspan结合-调研报告]]
> 日期：2026-07-30
> 验证基础：本机 141 个真实会话 + 1,211 个子 agent transcript 实测

---

## 0. 背景

基于三份调研得出：ClaudeScope 的解析器适合作为**解析内核**复用（骨架复用率 ≈85%），但其对**子 agent** 与**结构化工具结果**是盲区；ccspan 已验证子 agent 发现 / 链接 / 递归的可行性，并自陈"子 agent 做了什么"是其最大空白——正好由 ClaudeScope 解析器填补。本文档是该结合方案的**可执行重写蓝图**，源自在结合调研中成型的设计，独立成文以便评审与迭代。

> 关键事实（均实测）：顶层 `toolUseResult` 出现 11,298 次（ClaudeScope 全未读）；子 agent transcript 在 `<project>/<session>/subagents/`（54 目录、1,211 文件），由 `toolUseResult.agentId`（442 个）链接；子 transcript 与主会话同格式 → 解析器可递归复用。

---

## 1. 目标与范围

| 项 | 设定 |
|----|------|
| 产物 | Win + Mac 双端通用的 Claude Code 会话分析桌面工具（+ CLI/JSON 模式） |
| 内核 | ClaudeScope 解析器（TS 重写，递归到子 agent）+ ccspan 发现/归因 + 顶层 `toolUseResult` 结构化 |
| 不做 | 不复用 Python 代码（属重写非重构）；不强依赖外部成本工具（内置静态定价表） |
| 复用率 | 解析骨架 ≈85%（事件循环 / Turn 重建 / 工具配对 / 排序 / 容错），其余为扩展 |

---

## 2. 技术栈

| 层 | 选型 | 理由 |
|----|------|------|
| 运行时 | **Electron**（主进程 Node.js + 渲染进程 Chromium） | 双端分发、原生文件对话框、`electron-builder` 一键出 Win/Mac |
| 语言 | **TypeScript** 全栈 | 类型安全；dataclass → interface 翻译直接 |
| 解析内核 | 纯 TS，**零 UI 依赖** | 可独立单测；Electron 主进程与 CLI 共用 |
| 可视化 | **Plotly.js** | ClaudeScope 的 Python Plotly figure 即 JSON，近 1:1 迁移 |
| UI 框架 | React（或 Vue，二选一） | 渲染层薄壳；事件检查器 / 树视图标准组件 |
| 打包 | electron-builder | Win：NSIS `.exe`；Mac：`.dmg` |

---

## 3. 模块划分

```
core/                          # 纯 TS，零 UI 依赖，全量单测（Electron 主进程 + CLI 共用）
├── parser/                    # ← 来自 ClaudeScope parser.py（扩展）
│   ├── types.ts               #   Session/Turn/ToolCall/Usage… 接口（+ structuredResult, childSession）
│   ├── parse.ts               #   parseLines/parseJsonl（递归可用）
│   ├── blocks.ts              #   text/thinking/tool_use 块解析
│   └── toolResult.ts          # ★新增：读顶层 toolUseResult，按工具名特化抽取
├── discovery/                 # ← 来自 ccspan scan.js（适配）
│   ├── scan.ts                #   发现主会话 + <project>/<session>/subagents/** 子 transcript
│   ├── agentIndex.ts          #   agentId → child_file 索引
│   └── sessionRef.ts          #   会话元数据（slug/mtime/size/ai-title）
├── aggregate/                 # ← ccspan aggregate + ClaudeScope analyzer
│   ├── durations.ts           #   wall / active / compute（ccspan 三时长）
│   ├── tokens.ts              #   token 汇总（含 server_tool_use/iterations/speed）
│   ├── cascade.ts             #   prompt 时序分段 + 工具/agent 归因
│   ├── dedup.ts               #   message.id 单键去重（本机无 requestId）
│   └── views.ts               #   ganttEvents/tokenSeries/toolStats（← analyzer）
├── cost/                      # ← ccspan costProvider
│   ├── costProvider.ts        #   可插拔接口 + 优雅降级
│   └── staticPricing.ts       # ★新增：内置静态定价表（ccspan 设计未实现）
└── index.ts                   #   对外门面（parseSession/buildTree/aggregate）

ui/                            # 渲染层（Electron）：React + Plotly.js
└── （会话选择、Timeline、Tokens、Tools、事件检查器、★子 agent 树视图）

cli/                           # 无头入口（--json/--plain），共享 core
```

---

## 4. 数据模型（递归 Session 树）

```ts
interface Session {
  sessionId, cwd, gitBranch, version, startedAt, endedAt
  turns: Turn[]
  unmatchedToolUses, systemTurnDurationsMs, skippedCounts, parseWarnings
  // （sidechainMsgs 保留接口，但本机真实数据恒空）
}
interface Turn { index, userMsg, assistantMsgs: AssistantMsg[], toolCalls: ToolCall[] }
interface ToolCall {
  toolUseId, name, input, result, isError, tsStart, tsEnd, resultTruncated
  structuredResult?: StructuredResult   // ★新增：来自顶层 toolUseResult
  childSession?: Session                // ★新增：Agent 调用才有，递归
}
// StructuredResult 按 tool name 分型：Bash(stdout/stderr/interrupted)、
// Edit(oldString/newString/structuredPatch)、Agent(agentId/agentType/totalDurationMs…) 等
```

ClaudeScope 现有扁平 Turn 树，**只加两个字段**（`structuredResult` + `childSession`）即升级为可承载子 agent 与结构化结果的完整模型。

---

## 5. 分阶段任务拆分

| 阶段 | 目标 | 关键任务 | 验收 | 粗估 |
|------|------|---------|------|:---:|
| **P0 解析内核（忠实移植）** | 行为对齐 ClaudeScope | 移植 types/parse/blocks；把 16 个 pytest 的解析子集翻成 TS 测试；用 `mini_session.jsonl` +真实样本验证 | 解析输出与原版逐字段一致 | 2–3 天 |
| **P1 结构化结果** | 吃透 toolUseResult | 读顶层 `toolUseResult`；Bash/Edit/Write/Grep/Agent 特化抽取；放宽 5KB 截断策略（全量+摘要） | Bash 显示 stdout/stderr、Edit 显示 diff、Agent 显示汇总 | 2 天 |
| **P2 发现 + 子 agent 树** | 递归建树（已去风险） | scan `subagents/**`；建 agentId 索引；递归 parse 挂 `childSession`；处理 `workflows/wf_<id>/` 子层 | 真实数据上树渲染到正确深度 | 2–3 天 |
| **P3 聚合与归因** | ccspan 正确性 | 三时长模型；per-event cwd 归因；message.id 去重；prompt 时序分段归因；token/成本汇总；内置静态定价 | 三时长与 ccspan 同会话数值一致 | 3–4 天 |
| **P4 富 UI** | Plotly.js 三图 + 检查器 + 树视图 | 迁 gantt/token/tools 三图；事件检查器；★子 agent 树视图（默认折叠+懒加载） | 真实会话可交互钻取 | 3–4 天 |
| **P5 打包 + 双模式** | 双端可分发 | electron-builder 出 Win/Mac；`--cli/--json` 无头模式（共享 core） | 两平台安装即用、读 `~/.claude/projects` | 2 天 |

> MVP（解析 + 子 agent 树 + 一张图）≈ 1 周；双端打磨发布 ≈ 2–3 周（单人）。

---

## 6. 关键技术决策与风险

| 决策/风险 | 处置 |
|----------|------|
| pandas → TS | analyzer 用法浅（sort/cumsum/quantile/group），用普通对象数组 + 少量手写聚合替代 |
| 递归 parse 内存 | 深层 agent 树 → `childSession` 懒加载，UI 默认折叠 |
| async agent 的 `outputFile` 不稳定 | 不依赖 outputFile，统一走 `agent-*.jsonl`（稳定存在） |
| JSONL 版本漂移 | 解析保持容错；把 schema 探测脚本纳入 CI，字段缺失时告警而非崩溃 |
| Gradio → Electron | markdown/事件检查器 → React 组件；Plotly Python fig → Plotly.js（trace/layout 近 1:1） |
| 子 agent 跨文件匹配 | 已验证 `agentId` 直接对应文件名，无需启发式（区别于早期担忧） |

---

## 7. 验收标准

1. **解析一致性**：P0 的 TS 测试全过，且对 `mini_session.jsonl` 输出与原 Python 版逐字段一致。
2. **结构化结果**：真实会话里 Bash/Edit/Agent 的 `structuredResult` 正确填充。
3. **子 agent 树**：在已知含 Agent 调用的真实会话上，树渲染到正确深度，孙 agent 可展开。
4. **时长正确性**：同一会话的 wall/active/compute 与 ccspan 数值一致（交叉校验）。
5. **双端运行**：Win + Mac 均能启动、扫描 `~/.claude/projects`、加载会话不崩。
6. **降级**：无外部成本工具时，token 与时长照常，成本走内置定价表。
