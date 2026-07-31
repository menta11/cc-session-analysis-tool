# ccspan 调研报告

> 调研对象：`ccspan-main.zip`（源仓库 `github.com/refo/ccspan`）
> 定位：**按项目（per-project）**聚合 Claude Code 会话日志，输出 **Token + 成本 + 时长** 三维度分析的 CLI
> 元信息：v0.1.0 · MIT · 作者 Refik Onal · Node ≥18 · **零运行时依赖** · 全程本地只读
> 调研日期：2026-07-30

---

## 1. 概览

ccspan 读取 `~/.claude/projects/*.jsonl`，原地解析，按项目维度聚合出 token、成本、**时长**三个维度的报告。它的核心差异化卖点是 **「时长」**——ccusage、CodeBurn 等现有工具只算 token / 钱，没人报"花在某个项目上的时间"。

- 交互模式：全屏 TUI（项目列表 → 时间线树）
- 脚本模式：文本报告 / JSON
- 安装即用：`npx ccspan`，无需配置、不拷贝不外传数据

---

## 2. 核心能力（对外命令）

| 命令 | 作用 |
|------|------|
| `ccspan` | **交互式 TUI**（终端默认）：项目列表 → 回车进入项目时间线树 |
| `ccspan <project>` | 直接进入某项目（大小写不敏感的**路径子串**匹配） |
| `ccspan <project> --plain` | 文本报告：token、成本、时长、按天表 |
| `ccspan --json` | 机器可读 JSON |
| `--from / --to YYYY-MM-DD` | 按日期过滤（UTC） |
| `--timeline` | **Prompt-cascade 时间线**（招牌功能，见 §5） |
| `--sessions` | 按成本/算力 Top 会话 |
| `--idle <sec>` | "活跃/空闲"分界阈值（默认 300s） |
| `--no-cost` | 跳过成本查询 |
| `--all` | 列表显示全部项目（默认仅 Top 20） |

管道 / `--json` / `--plain` 时自动降级为文本输出，交互与脚本两套用法都顺畅。

---

## 3. 数据来源与解析

Claude Code 每个**顶层会话**写一个 JSONL：`~/.claude/projects/<sanitized-cwd>/<session-id>.jsonl`，每行一个事件。ccspan 解析的关键字段（`lib/parse.js`）：

| 字段 | 用途 |
|------|------|
| `timestamp` + `cwd` | `cwd` 一次会话内会变，所以每个时间间隔和每笔 token 都**归因到当时的 cwd** |
| `message.usage` | 拆 input / output / cache-create / cache-read + `model` |
| `subtype: turn_duration` | 带 `durationMs`，Claude Code 引擎自测的**真实算力时间**（约 74% 文件有） |
| `toolUseResult`（Task 事件） | 子 agent 的 `totalDurationMs / totalTokens / totalToolUseCount / agentType / agentId` |
| `promptId` | 用户 prompt 与其触发的工具/agent 调用 **100% 都带**，是时间线归因的基石 |
| `<command-name>` | 识别斜杠命令，给 prompt 打干净标签 |

子 agent 有**独立 transcript**：`<session>/subagents/agent-<id>.jsonl`，靠 `toolUseResult.agentId` 100% 关联到父调用。

---

## 4. ★ 三种时长模型（最大亮点，刻意设计的非冗余）

设计文档专门论证了为什么给三个指标而非一个：

| 指标 | 来源 | 含义 |
|------|------|------|
| **wall** | 每会话首尾时间戳跨度之和 | 日历跨度（含空闲） |
| **active** | gap 启发式：所有 ≤`--idle` 的间隔之和 | "你在键盘前"的时间（始终可得） |
| **compute**（头条） | Σ `turn_duration.durationMs` per cwd | Claude 引擎**真实算力时间**（精确，覆盖率部分） |
| idle | wall − active | 等待/离开 |

`compute` 在覆盖率 <100% 时标注百分比。

**刻意没有 $/小时指标**——作者认为拿近似时长除真实成本会叠加误差，宁可并排展示让人自己判断。这个设计克制且专业。

---

## 5. ★ Prompt-cascade 时间线（最有创意的功能）

`--timeline` 把一天切成**触发的用户 prompt**，每个 prompt 下面挂它 spawn 的子 agent（递归树）：

```
2026-06-23                              16h28m   537.7M tok
▸ Base directory for this skill…        16h30m    45.8k tok
    Bash ×11
  ├─ general-purpose   Integrate plan gw     2h03m   177.1k tok
  │  ├─ maestro:developer  GW Wave 1…           9m    69.9k tok
  │  └─ maestro:reviewer   Review GW…           5m   114.0k tok
  └─ general-purpose   Integrate plan platform 3h09m   162.2k tok
```

归因逻辑：
- agent 靠 **`promptId` join 到 prompt**（100% 覆盖）
- 直接工具调用靠 prompt 之间的**时序分段**
- 当天没归到任何 prompt 的活动滚到一个 "main thread" 行，**什么都不丢**

---

## 6. 子代理处理（本调研重点关注）

### 6.1 当前能展示的子代理信息

时间线每个子代理行展示：**类型（agentType）+ 任务标签（description）+ 耗时 + token**，JSON 里额外带 prompt 头和工具使用总数。

| 维度 | 是否有 | 来源 |
|------|--------|------|
| 类型/角色 (`agentType`) | ✅ | 如 `general-purpose`、`maestro:developer` |
| 被分配的任务标签 (`description`) | ✅ | Agent 工具调用时的 `description`，如 "Integrate plan gw" |
| 发给它的 prompt (`promptHead`) | ✅（仅 JSON） | 任务 prompt 前 60 字符 |
| 耗时 + token | ✅ | `totalDurationMs` / `totalTokens` |
| 它 spawn 的子-子代理 | ✅ | 递归读它自己的 transcript |
| 是谁触发的（哪个用户 prompt） | ✅ | `promptId` join |

### 6.2 当前**不展示**的信息（"做了什么"的细节）

- ❌ **用了哪些工具**（Bash ×5 · Read ×3 这种按工具名拆分）—— 主线程的 prompt 组有，**子代理没有**
- ❌ **碰了哪些文件 / 跑了什么命令**
- ❌ **它的内部步骤序列、输出、结论**

### 6.3 一个值得注意的不对称

- 主线程的直接工具调用：`buildCascade`（`lib/cascade.js`）按工具名聚合 → 顶层能看到 `Bash ×11`
- 但 `buildCascade` **只跑主会话文件**；子 agent transcript 在 `scan.js` Pass 2 里只过 `foldTokens`（折 token）+ 收集它自己的子代理 → transcript 里的 `toolUses`（工具名）被**直接丢弃**

子代理的工具调用在文本时间线里**连个数都不显示**，只有 JSON 里带了一个 `tools` 字段（`totalToolUseCount`，单一总数，不是拆分）。

### 6.4 结论：数据其实都在，只差一层没展开

transcript `<session>/subagents/agent-<id>.jsonl` 里有子 agent 每一次 `tool_use`（名字 + 参数）和 `tool_result`。ccspan **主动选择**只折 token + 拼 agent 树，没把"它做了什么"挖出来。

> **"看子代理做了什么 + 耗时多久"这个组合，技术上零障碍**——耗时 ccspan 已验证可行；"做了什么"只需把它丢弃的 transcript `tool_use` 层捡回解析。这是 ccspan 留下的最大空白，也是本工具最直接、最高价值的差异化方向。

---

## 7. 成本集成（可插拔外壳）

成本逻辑封装在 `costProvider` 接口后，v1 实现 shell 调 `npx codeburn export -f json ...`（LiteLLM 定价）：

- **CodeBurn 不在 → 优雅降级**：token 和所有时长照常显示，成本显示 `n/a` 并提示安装命令
- 预留"内置静态定价表"的零外部工具模式（接口已是 drop-in，v1 未实现）

---

## 8. 输出形态

| 模式 | 触发 | 内容 |
|------|------|------|
| TUI | 终端默认 | 项目列表 → 可折叠时间线树（j/k 移动、Enter 展开、Esc 返回、q 退出） |
| 文本报告 | `--plain` 或管道 | TOKENS / COST / DURATION / PER DAY 四段，可追加 `--sessions` `--timeline` |
| JSON | `--json` | `summary / perDay / sessions / timeline / mainThread`，agent 树递归嵌套 |

ANSI 颜色在 TTY 且 `NO_COLOR` 未设时开启，管道 / `--json` 自动剥离。

---

## 9. 架构与工程质量

- **纯净分层**：`cli.js`(115 行) 命令层；`lib/` 全是**纯函数**（scan / parse / aggregate / cascade / cost / render / format / match）；`tui.js`(86 行) 仅终端薄壳，状态全在纯模型 `tui-model.js`(338 行)。整个项目 ~1400 行。
- **测试扎实**：15 个测试文件、~970 行，用 `node:test` 对所有纯核心函数跑**合成 JSONL fixture**（无网、无真实 `~/.claude`）。parse / cascade / aggregate / match / args / cost / render / TUI 运行时全覆盖。
- **健壮性细节**：跳过不可读文件/不可解析行、`mkdtemp` 避免 PID 冲突、SIGINT/SIGTERM 恢复终端（不把用户卡在 alt-screen）、TTY/`NO_COLOR` 感知。
- 有完整 **superpowers 设计文档 + plan 文档**（`docs/superpowers/`），是 TDD / superpowers 工作流的产物。

---

## 10. 亮点 vs 局限

### 值得借鉴
1. **三时长模型 + 拒绝 $/hr 的克制**——把"时长"做成真正有信息量的维度
2. **Prompt-cascade 归因**（用 `promptId` 把工具/agent 挂回用户 prompt）——还原"用户做了什么 → 触发了什么"的故事树
3. **子 agent transcript 完整处理 + 全局去重**（`(message.id, requestId)`，同 ccusage，避免 resumed 会话重放双算）——计数准确性的硬骨头
4. **`costProvider` 可插拔 + 优雅降级**——成本不是硬依赖
5. **零依赖、原地读、全本地**——隐私友好、`npx` 直跑

### 局限（v1 范围外）
1. 成本强依赖外部 CodeBurn，无内置定价表
2. 无内联定价 → 每日成本不精确（整会话成本归到开始日，跨午夜近似）
3. **子代理"做了什么"未展开**（本工具的差异化机会，见 §6）
4. 无 watch/流式、无多机聚合、无 JSON 外的导出格式
5. `compute` 覆盖率依赖新版日志（旧日志无 `turn_duration`）

---

## 11. 对本项目的启示

### 11.1 必抄对的硬骨头（否则数字会错）
- **全局 `(message.id, requestId)` 去重**，跨主文件 + transcript
- **时长只取主线程**，子 agent 与主线程并发，计入墙钟会双算
- **`cwd` 归因到事件发生时刻**，不能取会话级单一 cwd

### 11.2 建议直接做的差异化（ccspan 的空白）
**子代理行为还原** —— 拿 transcript 把"做了什么"补上。最小数据流：

| 想知道 | 解析 transcript 的字段 |
|--------|----------------------|
| 跑了什么命令 | `tool_use` name=`Bash` → `input.command` |
| 读了/改了哪些文件 | `tool_use` name=`Read`/`Edit`/`Write` → `input.file_path` |
| 搜了什么 | `tool_use` name=`Grep`/`Glob` → `input.pattern` |
| 调了哪些子工具 | `tool_use` name=`Agent`/`Task` → `input.description` |
| 每步结果 | 对应 `tool_result`（按 `tool_use_id` 关联） |
| 每步耗时 | transcript 自己的 `turn_duration.durationMs`（比父汇总 `totalDurationMs` 颗粒度更细） |

配合 ccspan 已验证的 promptId 归因 + agentId 递归树，可拼出"某个用户 prompt → 子 agent → 具体命令/文件/结论 + 每步耗时"的完整链路。

### 11.3 可选增强
- 内联定价表实现**零外部工具的精确日成本**（ccspan 设计了但没做）
- 子代理层级也做按工具名拆分（消除 §6.3 的不对称）

---

## 附：项目结构

```
ccspan-main/
├── cli.js              (115) 命令层 / 参数分发
├── lib/
│   ├── args.js         (54)  参数解析（纯）
│   ├── scan.js         (200) 扫描日志，两 Pass（主文件 + transcript）
│   ├── parse.js        (119) 单行 JSONL 解析（纯）
│   ├── aggregate.js    (54)  时长归因 + token 聚合 + 按时长分桶（纯）
│   ├── cascade.js      (69)  prompt 分段 + agent 归因（纯）
│   ├── cost.js         (56)  CodeBurn 外壳 + 成本 join
│   ├── match.js        (11)  项目名子串匹配（纯）
│   ├── render.js       (264) 文本/JSON 渲染（纯）
│   ├── format.js       (32)  时长/token/货币格式化（纯）
│   ├── tui.js          (86)  终端薄壳（alt-screen + raw 键盘）
│   └── tui-model.js    (338) TUI 状态 + 布局（纯模型）
├── test/               (15 文件, ~970 行) node:test 合成 fixture
└── docs/superpowers/   设计文档 + plan 文档
```
