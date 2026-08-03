# AI 分析报告链路 · 实现方案（最终实现版）

> 范围：改造 `core/ai/prompt.ts` + `core/ai/analyzeRequest.ts` + `core/ai/template.ts` + `electron/main/claudeCli.ts` + `electron/main/index.ts`(IPC) + `electron/preload/index.ts` + `src/components/AiReport.tsx`，把"裸跑 `claude -p` + 纯文本 `<pre>`"升级为：**厚摘要 + 标注文件地图 + 单一系统提示模板 + 流式 markdown 报告**，支持整会话与节点诊断两种调用（同一模板）。
>
> 原则：**引擎 own 数字与结构，claude own 解读与取证。** 数字一律来自 `core` 引擎，提示词绝不要求 claude 自行从日志算时间。
>
> 状态：**已实现并端到端验证**（流式 ✓、占比正确 ✓、报告可用 ✓）。98 测试 / 19 文件全过；typecheck/build clean。

---

## 0. 现状与目标差（实现后对照）

| 项 | 旧现状 | 实现后 |
|---|---|---|
| 喂给 claude 的数据 | `buildSessionDigest`：墙钟+三类分解+top10 直接工具+top10 子 agent（≈800 字） | 厚摘要 `buildDigest`：时序分桶（阶段底料）/轮间间隙 top/错误汇总/诊断事实/子 agent 全量表/并行度，概览+全表带**引擎进度条** |
| 文件地图 | 无 | `buildFileMap`：全量紧凑路径 + top5 慢子 agent 深挖线索 + 并行组 |
| 提示词 | `analyzePrompt` 单段、无角色/模板/格式约束 | 单一模板 `agent-run.md`（角色+格式+质量硬约束），**inline 进 stdin**（非 `--append-system-prompt` argv，见 §6 踩坑） |
| 分析模式 | 仅整会话；`analyzeAgent` 喂 child digest 但无诊断事实 | 整会话 + 节点诊断共用同一模板；`buildAnalyzeRequest(kind, …)` 统一组装，节点带父子对账/占父% |
| 关键事件呈现 | top10 慢调用平铺 | **按阶段** `| 阶段 | 事件 | 类型 | 耗时 | 占比 | 备注 |`；阶段由 claude 划分、耗时=所含分桶之和；占比列用 10 格进度条 |
| 输出 | `claude -p` 攒满 stdout 一次性返回；`<pre>` 纯文本 | `claude -p --verbose --include-partial-messages --output-format stream-json`，`stream_event` delta 经 `onChunk` 逐段透出；顺接 `session_id`/`costUsd`/`durationMs`/`numTurns`；react-markdown 渲染 |
| 降级 | claude 未装/超时 → `ok:false` | 能力探测 `claudeCapabilities()`；不支持 partial → stream-json 整消息一次性；不支持 stream-json → `claude -p` 文本攒满 |

---

## 1. 模块清单（实现后）

```
core/ai/
  ├ prompt.ts          # buildDigest(厚，统一，含引擎进度条) + buildDiagnosticFacts + buildFileMap
  ├ analyzeRequest.ts  # buildAnalyzeRequest(kind, session, opts) → {systemPrompt, userMessage}；whole/node
  ├ template.ts        # getSystemPrompt()：经 Vite ?raw inline templates/agent-run.md
  └ templates/
       └ agent-run.md   # 单一模板（整会话/节点诊断共用）
electron/main/
  ├ claudeCli.ts       # runClaudeStream + buildStdin + parseStreamJsonLine + claudeCapabilities + resolveClaudePath
  └ index.ts           # Session 缓存 + analyze:run（buildAnalyzeRequest → runClaudeStream，onChunk→webContents.send）
electron/preload/index.ts  # analyzeReport(kind,path,focusToolUseId?) + onAnalyzeChunk(→cleanup)
src/components/AiReport.tsx  # react-markdown + remark-gfm + 流式增量 + sessionId 淡显
src/components/DetailPanel.tsx  # onAnalyzeAgent(toolUseId)
src/index.html               # .md-report markdown 样式（随亮/暗主题）
```

> `prompt.ts`/`analyzeRequest.ts`/`template.ts` 属 `core/`（纯 TS、可单测）；`analyzeRequest.ts` 只被主进程 import（渲染层不碰，避免把 template.ts 的 `?raw` .md 打进 renderer bundle）。渲染层只传 kind+sessionPath+focusToolUseId，提示词在主进程组装。

---

## 2. 厚摘要 `buildDigest(session, opts?)`（统一，对任意 Session）

复用 `sessionIntervals(session)` 拿 `waitUser/direct/delegated/compute` 四类区间集合，所有衍生量从区间派生，与甘特对账一致。概览 + 子 agent 全表带**引擎进度条**（`format.ts` 的 `bar(part, whole, 10)`，永远正确）。

```
# Agent 运行耗时摘要
- 墙钟 {wallMs} | 轮次 {turns.length} | 子agent {countSubagents} | isSubagent={bool}
- 占父墙钟 {pct}% {bar}                  // 仅 opts.parentWallMs 存在（节点诊断）
- 等用户 {waitUserMs} ({pct}) {bar}       // 子 agent 恒0；0 则模板跳过
- 本地工具 {localMs} ({pct}) {bar} — 直接 {directMs} / 委派子agent {delegatedMs}
- 模型思考 {computeMs} ({pct}) {bar}     // 派生残差；口径"模型思考"，弃旧"LLM(think+output)"

## 时序分桶（阶段划分底料；自适应段数：目标20，min5/max40）
| 段 | 时间窗 | 等用户 | 本地工具 | 模型思考 | 段合计 |
（每段各类 unionDuration；claude 据此归并阶段、求和填阶段耗时）

## 轮间间隙 top 5                       // isSubagent 时此节略
- 第 N→N+1 轮：{gapMs}（{起止}）

## 错误汇总
- 错误调用 {errCount} 次 / 错误耗时 {errMs} ({pct})
- 按工具：Bash ×{n} / Edit ×{n} / Agent ×{n} …
- 失败子 agent top 3

## 诊断事实（对任意 Session 都算；不挂模式标签）
- 显著慢调用 top 5：{toolUseId} {name} {input摘要} {durationMs} {interrupted?}{timeout?}{isError?}{tsEnd==null?' UNPAIRED':''}
- 重复模式 top 5：{name} {指纹} ×{count} {全isError?'(全失败)':''}
- 未配对 tool_use：{toolUseId列表}（session.unmatchedToolUses）
- 父子对账：父调度 {parentDurationMs} / 子实际 {childWallMs} / 缺口 {gapMs}（{sync|async}）  // 仅 opts.parentAgentCall 存在时
- 体量：步数 / token / 模型思考 / 本地工具

## 最慢直接工具 top 10
## 子agent 全量表（按耗时降序；>30 截断 + 按类型聚合）
- {agentType} "{desc}" {wallMs}({占父%}) {bar} tok={n} {失败?'✗'} agentId={id}
   // 注意：buildDigest 全表不含文件路径——路径在 buildFileMap（core 无文件系统）
## 并行度
- 峰值同时活跃子 agent {peakParallel}（{时段}）
```

**要点**
- `interTurnGaps` 逻辑在 `prompt.ts` 内联重算（带轮次位置），未导出 `timeBreakdown.interTurnGaps`。
- 时序分桶自适应段数：`count = clamp(round(wallMs / (30*60*1000)), 5, 40)`。
- 诊断事实"指纹" = name + 关键字段（Bash→command、Edit→file_path+oldString前40、Read→file_path、Agent→description）。
- 父子对账/占父墙钟条件化：仅 `opts.parentAgentCall`（及 `parentWallMs`）存在时输出。
- 子 agent 全表 >30 截断 + 按类型聚合，控制体积。

---

## 3. 文件地图 `buildFileMap(session, opts)`

给 claude 的"按图索骥"清单，避免盲扫 90 个文件。**全量紧凑列路径**（claude 按需 Read），**rich 标注只给 top 5 慢子 agent**（父位置 + 子内最慢/重复指纹）。

```
# 文件地图（claude 可按需 Read 深挖；勿整文件读，按 toolUseId grep 定位行）
projectsRoot = {sessionDir}
## 主文件
- {relPath}（{lines} 行 / {size}）   // fileMeta 回调注入，core 不直接读 fs
## 子agent 文件（按耗时降序，全量紧凑）
- {agentType} {wallMs}({占父%}){失败?'✗'} agentId={id} → {relPath}
## 深挖线索（top 5 慢子agent）
- {agentType} "{desc}" agentId={id} → {relPath}
    父调用: turn {N} / toolUseId={t} / sync|async
    子内最慢: {childToolUseId} {childName} {wall}
    子内重复: {fingerprint} ×{n}        // count>1 才显示
## 并行组（时间重叠簇，count≥2）
- [{时段}] {n} 个: {id1, id2, …}
```

复用 `agentIndex`（agentId→file）映射，不重复实现发现逻辑。`opts.fileMeta` 由调用方注入（core 不读 fs）。节点诊断时 `session`=child，列孙 agent。

---

## 4. 提示词组装 `buildAnalyzeRequest`（实现：analyzePrompt 折进此处）

> 规划稿原拟 `analyzePrompt({digest,fileMap?})` 单立纯函数；实现时该函数仅 2 行（`systemPrompt=getSystemPrompt()`、`userMessage=digest+fileMap`），**折进 `buildAnalyzeRequest`**，避免命名与旧 `analyzePrompt` 冲突 + 减少无谓分层。旧 `analyzePrompt` 已删除。

```ts
buildAnalyzeRequest(session, {
  kind: 'whole' | 'node',
  projectsRoot, mainFilePath, agentIndex,
  focusToolUseId?,            // node 模式：递归定位 child + parentAgentCall
  fileMeta?,
}): { systemPrompt: string; userMessage: string }
```

- **systemPrompt** = `getSystemPrompt()`（单一模板 §5）。
- **userMessage** = `digest + '\n\n' + fileMap`。
- whole：`buildDigest(session)` + `buildFileMap(session)`。
- node：递归 `findToolCall(session, focusToolUseId)` → child + 父会话；`buildDigest(child, { parentAgentCall, parentWallMs: breakdownOf(parent).wallMs })` + `buildFileMap(child, { mainFilePath: childFilePath, … })`。
- `focusToolUseId` 找不到或无 childSession → 抛错（IPC 层 catch 返回 ok:false）。

---

## 5. 单一模板 `templates/agent-run.md`（可编辑资产，`?raw` inline）

由 `template.ts` 经 Vite `?raw` 构建期内联为字符串（dev/prod 都行、无需 fs 路径）。**只定结构 + 质量硬约束**；诊断用"事实 + 参考模式 + 开放式指令"。

```markdown
# 角色
你是 Claude Code agent 运行耗时分析专家。本次分析的 agent run 可能是主会话（含等用户介入）或子 agent（单 prompt、等用户恒0）。基于引擎给出的结构化数据（数字已对账，勿自行从原始日志重算时间），分析耗时与慢因。

# 输出格式（严格遵守）
## 概览
墙钟 / 等用户 / 本地工具(直接+委派) / 模型思考，一行带占比。若为子 agent，附父调度区间与占父墙钟%。

## 关键事件（按阶段）
| 阶段 | 事件 | 类型 | 耗时 | 占比 | 备注 |
- 阶段划分与命名由你定：基于「时序分桶」表，将连续分桶语义归并为阶段。
- 阶段耗时 = 所含分桶耗时之和（用所给数据求和），禁从原始时间戳推算。
- 每阶段挑 1–3 个关键事件，耗时原样引用。
- 占比列用 10 格进度条 + 百分比（█/░，如 █████░░░░░ 50%）。占比 = 该行耗时 ÷ 墙钟(概览给出)；若该事件在「子agent全表」已有占父%，直接引用。

## 慢因分析
基于诊断事实直击重点，主因 + 次因各一两句：说清是什么、为什么慢、影响多大（占比/时长即可）。不必罗列 toolUseId、重复指纹、缺口值等明细。常见慢法（仅供参考，非穷尽、非分类清单）：
- 卡在单点 / 活多但合理 / 陷入循环 / 交接缺口（仅 sync 子agent）/ 上下文爆炸
可参考，但勿强行归类。

## 取证
如需佐证，按「文件地图」Read 原始日志的对应 toolUseId 行（先 grep 定位再读上下文）。

## 优化建议
针对已识别瓶颈，给可操作改进点。

# 质量硬约束
1. 表格数字直接引用所给数据，禁止重新计算时间（阶段耗时仅靠分桶求和）。
2. 慢因分析含结论 + 关键占比/时长即可，不堆砌明细；至少 1 个主因 + 1 个次因。
3. 允许结论=组合或"上述皆非"。
4. 等用户=0 时不展开等用户分析。
5. 全文 markdown，中文，600 字内（表格/取证段不计入）。
```

> 模板体积 ~750 字符（<2KB）。占比列允许 claude 自算 `耗时/墙钟`——实测 claude 多数情况引用 digest 占比正确（55%/23%/11% 全对），偶有抽风（出现过 1h1m→40%），靠"直接引用全表占比"约束收敛。

---

## 6. `claudeCli.ts`（实现后）

### 6.1 流式 + 遥测

```ts
interface ClaudeResult {
  ok: boolean; text: string; error?: string
  sessionId?: string  // stream-json system/init 与 result 取出，备追问（--resume）
  costUsd?: number    // result.total_cost_usd
  durationMs?: number // result.duration_ms（注意字段名，见踩坑）
  numTurns?: number   // result.num_turns
}
runClaudeStream(userMessage, systemPrompt, onChunk, opts?) → Promise<ClaudeResult>
```

- **args（最佳）**：`['claude', '-p', '--verbose', '--include-partial-messages', '--output-format', 'stream-json']`。
- **stdin** = `buildStdin(systemPrompt, userMessage)` = `${systemPrompt}\n\n---\n\n# 待分析数据\n\n${userMessage}`。systemPrompt **inline 进 stdin**，不走 `--append-system-prompt` argv（见 §6.3）。
- **`parseStreamJsonLine`**（纯函数，可单测）解析 NDJSON：
  - `system`+`subtype=init` → `sessionId`
  - `stream_event`+`event.type=content_block_delta`+`delta.type=text_delta` → `delta` 增量文本（**真流式**）
  - `assistant` 整消息 → 仅在未收到 delta 时作回退（partial 模式下 delta 已累积，跳过避免重复）
  - `result` → `session_id`/`total_cost_usd`/`duration_ms`/`num_turns`
  - 非法/空行 → `{type:'other'}`，不崩

### 6.2 能力探测 + 降级

`claudeCapabilities()`（`spawnSync(claudePath, ['--help'])`，缓存）→ `{ streamJson, partial }`：
- `streamJson && partial` → 上面最佳 args（真流式 + 遥测）。
- `streamJson && !partial` → `['-p','--verbose','--output-format','stream-json']`（整 assistant 消息一次性 + 遥测，无逐段）。
- 都不支持 → `['-p']` 文本攒满（无流式/遥测）。

`resolveClaudePath()`：`where`/`which` 解析（缓存）。

### 6.3 spawn 转义坑（关键决策）

本机 `where claude` 只返回 npm 装的 `claude`（shell 脚本）+ `claude.cmd`（batch shim），**无 `.exe`**。Windows 下 Node 因 CVE 补丁禁止 `shell:false` spawn `.cmd`，故**必须 `shell:true`**。而模板里全是 `|`（表格），经 `shell:true` 的 argv 会被 cmd.exe 当管道符切碎。

**解法**：用户内容（systemPrompt，含 `|`）**走 stdin**（不经 shell 解析，安全）；argv 只留无用户内容的安全 flag（`-p --verbose --include-partial-messages --output-format stream-json`）。即规划稿的 `--append-system-prompt`（argv 传模板）改为 `buildStdin` inline。功能等价（指令前缀 + 数据），仅从 system 消息变 user 消息前缀——对报告生成无影响。

---

## 7. IPC + preload + 渲染层

### 7.1 主进程 `index.ts`

```ts
interface CachedSession { session; agentIndex; mainFilePath; projectsRoot }
const sessionCache = new Map<string, CachedSession>()   // session:load 时填

ipcMain.handle('analyze:run', async (e, { kind, sessionPath, focusToolUseId? }) => {
  const cached = sessionCache.get(sessionPath) ?? → ok:false('会话未加载')
  const { systemPrompt, userMessage } = buildAnalyzeRequest(cached.session, { kind, …, focusToolUseId })  // try/catch
  const win = BrowserWindow.fromWebContents(e.sender)
  return runClaudeStream(userMessage, systemPrompt, (chunk) => win?.webContents.send('analyze:chunk', chunk))
})
```

### 7.2 preload + `src/preload.d.ts`

```ts
analyzeReport: (kind, sessionPath, focusToolUseId?) => ipcRenderer.invoke('analyze:run', { kind, sessionPath, focusToolUseId }),
onAnalyzeChunk: (cb) => { const l = (_e, t) => cb(t); ipcRenderer.on('analyze:chunk', l); return () => ipcRenderer.removeListener('analyze:chunk', l) },
```

### 7.3 `App.tsx` + `AiReport.tsx` + `DetailPanel.tsx`
- `App.tsx`：`analyze(kind, focusToolUseId?)` → 注册 `onAnalyzeChunk`（acc 累加 + `setReportText`）→ `analyzeReport` → finally `off()`。`sessionId` state 备追问。
- `AiReport.tsx`：`react-markdown`+`remark-gfm`；流式增量重渲染；`sessionId` 工具栏淡显（`session xxxxxxxx…`）。
- `DetailPanel.tsx`：`onAnalyzeAgent(toolUseId)`（从 `node.call.toolUseId` 取）。
- `src/index.html`：`.md-report` 样式（表格/标题/代码/引用，随亮/暗主题 CSS 变量）。

---

## 8. 测试（实现后）

| 文件 | 覆盖 |
|---|---|
| `test/ai-prompt.test.ts` | `buildDigest` 各段 / `buildDiagnosticFacts`（含/不含 parentAgentCall → 父子对账） |
| `test/fileMap.test.ts` | `buildFileMap` 结构/主文件/agentId+路径/深挖线索/无并行组 |
| `test/analyzeRequest.test.ts` | `buildAnalyzeRequest` whole + node 三条错误路径（缺 id / 不存在 / 非 Agent） |
| `test/template.test.ts` | 加载非空 / <2KB / 角色+格式+约束 / 阶段+分桶求和 / 仅供参考+勿强行归类 |
| `test/claudeCli.test.ts` | `buildStdin` + `parseStreamJsonLine`（system/assistant/delta/result/坏行） |
| `test/real-sample-digest.smoke.test.ts` | 真实 71598b9d（89 子 agent）：buildDigest 不崩+各段+全表截断、buildFileMap 排序+路径命中、buildAnalyzeRequest node、**端到端组装链路**（buildAnalyzeRequest→buildStdin 全链） |

> `claudeCli` 的降级路径（caps=false → text 攒满）涉及 spawnSync/spawn，未做 mock 单测；**真机 smoke 验证**（17-chunk 流式 + sessionId/cost/durationMs/numTurns 全取到）。真调 claude 的集成测试不进套件（慢 + 花钱 + 需登录）。

---

## 9. 踩坑记录（真机探测发现，规划稿无法预见）

| 坑 | 现象 | 处置 |
|---|---|---|
| **stream-json 默认不流式** | `--output-format stream-json` 只在结尾发 1 个完整 `assistant` 事件，无逐段 delta → "看着像一次性输出" | 加 `--include-partial-messages`，增量文本走 `stream_event.content_block_delta.text_delta` |
| **stream-json 需 --verbose** | `claude -p --output-format stream-json` 不带 `--verbose` 退出码 1 | args 必带 `--verbose` |
| **result 耗时字段名** | 规划稿猜 `total_duration_ms`，实际是 `duration_ms`（cost=`total_cost_usd`、轮次=`num_turns`、session=`session_id` 都对） | parser 取 `duration_ms` |
| **Windows .cmd + argv 的 `\|`** | `where claude` 无 `.exe`，必须 `shell:true`，模板表格 `\|` 被 cmd.exe 当管道符切碎 | systemPrompt 走 stdin（`buildStdin`），argv 只留安全 flag |
| **renderer 拉入 node:path** | step 2 给 `prompt.ts` 加 `node:path` 的 `relative`，被 App.tsx import → 渲染层（无 node polyfill）加载即崩白屏 | `relOf` 改纯字符串实现，prompt.ts 零 Node 依赖 |
| **`?raw` 类型声明** | 自定义 `declare module '*.md?raw'` tsc 不认（相对路径 `?raw` 导入需 Vite 官方声明） | `/// <reference types="vite/client" />` |
| **占比偶发抽风** | claude 多数引用 digest 占比正确，偶现 1h1m→40%（该 55%） | 模板约束"直接引用全表占父%"；digest 概览/全表带引擎进度条兜底 |
| **dev 不重启 main** | electron-vite main 热重启有时不触发，跑旧 claudeCli → 流式不生效 | 改 claudeCli 后须完全杀 dev 重起 |

---

## 10. 任务拆分（已完成）

1. ✅ `prompt.ts` 厚摘要统一（buildDigest + buildDiagnosticFacts + 时序分桶自适应 + 引擎进度条）
2. ✅ `buildFileMap`（文件地图）
3. ✅ `template.ts` + `agent-run.md`（单一模板，`?raw` inline）
4. ✅ `buildAnalyzeRequest`（whole/node，analyzePrompt 折入）
5. ✅ `claudeCli.ts`（runClaudeStream + buildStdin + parseStreamJsonLine + claudeCapabilities + 降级；真机 smoke 验证）
6. ✅ IPC/preload 流式事件
7. ✅ `AiReport.tsx` markdown 渲染 + 流式增量 + sessionId 淡显
8. ✅ `App.tsx` analyzeAgent 签名 + 主进程 Session 缓存 + DetailPanel toolUseId
9. ✅ 真实样本集成验证（buildAnalyzeRequest→buildStdin 全链 smoke）+ 旧测试修正（删旧 `analyzePrompt`+测试、删旧 `runClaude` 死代码）

> 端到端手动验证：流式逐段滚出 ✓、占比正确（55%/23%/11%）✓、markdown 表格渲染 ✓、节点诊断含父子对账 ✓。
