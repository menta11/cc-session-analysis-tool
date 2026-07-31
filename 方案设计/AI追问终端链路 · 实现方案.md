# AI 追问终端链路 · 实现方案

> 范围：在已落地的"AI 分析报告链路"之上，新增**追问入口**——把每次分析产生的 claude 会话 id 接出来，加一个"打开 claude 终端继续追问"按钮，点击即在 OS 终端里 `claude --resume <id>` 续接那次分析对话。
>
> 依赖：`AI分析报告链路 · 实现方案.md` 已把 `ClaudeResult.sessionId`（stream-json `system/init` 取出）透到 renderer 并暂存。本方案只消费，不改 `runClaudeStream`。
>
> **实现状态（2026-07-31）**：已全部落地并通过 typecheck / build / 单测。实现中对原设计有两处关键修订（已并入下文）：① 续问终端的 cwd 用**主进程 `process.cwd()`** 而非 `session.cwd`（与分析 spawn 同 cwd，否则 resume 找不到会话）；② `openTerminal(id)` 不再接收 cwd 参数、且去掉 electron 依赖。另：`analyze:run` 的 claude 调用超时由默认 180s 放宽到 600s（大会话厚摘要+取证易超时）。

---

## 0. 现状与目标差

| 项 | 现状（stream-json 改造后） | 目标（本方案） |
|---|---|---|
| sessionId | `runClaudeStream` 返回 `ClaudeResult.sessionId`；`AiReport` 暂存到 state | 按会话记忆，供续问按钮读 |
| 报告状态 | `App.tsx` 全局单值 `reportText/reportError`；切会话清空 | `Record<loadedSession, {text,error,claudeId,loading}>`，切会话还原各自分析，**不串台** |
| 续问入口 | 无 | "打开 claude 终端继续追问"按钮，与"导出 .md"并排 |
| 按钮禁用判据 | 导出按钮=`!text` | 续问按钮=`!claudeId`（与导出略不同） |
| 终端打开 | 无 | 新增 `terminal:open` IPC + 跨平台开终端跑 `claude --resume <id>`，cwd=主进程 `process.cwd()`（与分析同 cwd，见 §3.2） |

> 不在范围内：应用内文本追问（`claude -p --resume` 追加回答到报告）；已确认走"开终端=完整 Claude Code agent 能力（能改文件、跑工具）"。

---

## 1. 模块改造总览

```
electron/main/
  ├ claudeCli.ts        # 不改（runClaudeStream 已透 sessionId，归另一终端）
  ├ terminal.ts         # ★新：buildResumeCommand(id, cwd, platform) 纯函数 + openTerminal(id) 用 process.cwd() 开终端
  └ index.ts            # +1 IPC: terminal:open；analyze:run 超时放宽 600s
electron/preload/index.ts  # +1: openTerminal(claudeId)
src/
  ├ App.tsx             # 报告状态改 per-session Record；analyze 写回当前会话条目；load 还原
  └ components/AiReport.tsx  # +1 按钮（沿用 sessionId prop）；加 onOpenTerminal + 禁用变灰样式
test/
  └ terminal.test.ts    # ★新：buildResumeCommand 各平台命令串 + isSessionId + openTerminal 守卫
```

> `terminal.ts` 的 `buildResumeCommand` 是纯函数、零副作用，可独立单测；`openTerminal` 薄薄一层 spawn，手动验（CI 无法验窗口是否真打开）。

---

## 2. 多会话报告状态模型（解决 #7 串台）

**问题**：`currentSessionId` 若是全局单值，A→B→A 后点续问会拿 B 的 id 开终端。

**解法**：按 loaded session 记一份报告状态，续问按钮永远读"当前会话"自己那份 id，结构上不可能串台。

```ts
// App.tsx
export interface ReportState {
  text: string
  error: string
  claudeId: string | undefined
  loading: boolean
}
const [reports, setReports] = useState<Record<string, ReportState>>({})
// key = selectedPath（loaded session 的 .jsonl 路径，唯一且早于 parse 就绪）
const cur = reports[selectedPath ?? ''] ?? { text: '', error: '', claudeId: undefined, loading: false }
```

**生命周期**：
- `load(path)`：`setSelectedPath(path)`；报告区显示 `reports[path] ?? 空`（切回 A 自动还原 A 的报告 + claudeId）。
- `analyze()` 开始：`setReports(r => ({ ...r, [path]: { ...cur, loading: true } }))`。
- `analyze()` 完成（`res.ok`）：`setReports(r => ({ ...r, [path]: { text: res.text, error: '', claudeId: res.sessionId, loading: false } }))`。
- `analyze()` 失败：`claudeId` 保持 undefined（按钮继续灰），写 error。
- 整会话分析与节点分析**共用同一 key**（当前会话）；节点分析覆盖整会话报告 + claudeId。续问 resume 的是"当前下屏显示的那份报告"对应的 claude 会话。
- 老的 claude session 留盘不清理（量小，可接受）。

> 重启不恢复内存 map（YAGNI）；claude session 文件仍在盘上，想续问旧分析可走 `claude -r` 选择器手动找。

---

## 3. 终端打开：`buildResumeCommand` + `openTerminal`

### 3.1 纯函数（可单测）

```ts
// electron/main/terminal.ts
export interface ResumeCommand {
  exe: string
  args: string[]
  opts: { detached: boolean; stdio: 'ignore' }
}

/** 构造跨平台续问命令。id 须为 UUID（openTerminal 校验）；cwd 由调用方给（实际传 process.cwd()）。 */
export function buildResumeCommand(id: string, cwd: string, platform: NodeJS.Platform): ResumeCommand
```

- **Win**：开新 `cmd` 窗口跑 `claude --resume <id>`，cwd 设到 `process.cwd()`：
  - `exe: 'cmd.exe'`
  - `args: ['/d', '/c', 'start', '', '/d', cwd, 'cmd', '/k', `claude --resume ${id}`]`
  - （首个 `''` = 空 title，规避 `start` 把首参数当程序名的经典歧义；`/d cwd` 设工作目录；`cmd /k` 跑完不关窗）
- **Mac**：唤 Terminal.app 跑命令：
  - `exe: 'osascript'`
  - `args: ['-e', `tell application "Terminal" to do script "cd ${escAppleScript(cwd)} && claude --resume ${id}"`]
  - `escAppleScript`：对 cwd 里的 `"`/`\` 转义（id 是 UUID 无需转义）

> **安全**：`id` 必须通过 `isSessionId` UUID 校验，否则 `openTerminal` 直接拒绝、不开窗。cwd = `process.cwd()`（主进程自身路径，可信）。

### 3.2 薄封装（手动验）

```ts
export async function openTerminal(id: string): Promise<{ ok: boolean; error?: string }> {
  if (!isSessionId(id)) return { ok: false, error: 'sessionId 非法，拒绝打开终端' }
  // resume 必须与分析调用同 cwd：claude 按 cwd-sanitized 路径存会话
  // （~/.claude/projects/<sanitize(cwd)>/<id>.jsonl）。分析在主进程 cwd 跑
  // （runClaudeStream 的 spawn 未指定 cwd），故会话落在 sanitize(process.cwd()) 下；
  // resume 必须从同一 cwd 进入，否则报 "No conversation found with session ID"。
  const dir = process.cwd()
  const cmd = buildResumeCommand(id, dir, process.platform)
  const child = spawn(cmd.exe, cmd.args, { ...cmd.opts, cwd: dir })
  child.on('error', () => { /* 终端启动失败仅记日志，不抛 */ })
  child.unref()
  return { ok: true }
}
```

- `terminal.ts` 不再 import electron（去 `app.getPath` 兜底与 `existsSync`），仅 `node:child_process`；`process.cwd()` 恒存在。
- `detached + stdio:'ignore' + unref()`：子终端与主进程脱钩，关 app 不杀终端。
- 不等终端退出（`openTerminal` 立即返回 ok；终端自身成败由用户在窗口里看——#5 用户手动验）。

---

## 4. IPC + preload

```ts
// electron/main/index.ts
ipcMain.handle('terminal:open', (_e, { claudeId }) => openTerminal(claudeId))

// electron/preload/index.ts
openTerminal: (claudeId: string) =>
  ipcRenderer.invoke('terminal:open', { claudeId }),
```

> 另：同文件 `analyze:run` 调 `runClaudeStream(..., { timeoutMs: 600_000 })`（默认 180s 对大会话太紧）。

---

## 5. `AiReport.tsx` 改造

- props 增 `onOpenTerminal: () => void`（`sessionId?: string` prop 已由 stream-json 改造存在，**沿用其名**，不另起 `claudeId`）。
- 加 `btnStyle(disabled)` 帮助函数：禁用时 `opacity:0.5 + cursor:not-allowed`——否则自定义 `background` 会盖掉浏览器默认禁用灰，按钮看着像能点。
- 在"导出 .md"旁加按钮：

```tsx
const btnStyle = (disabled: boolean): React.CSSProperties =>
  disabled ? { ...btn, opacity: 0.5, cursor: 'not-allowed' } : btn

<button
  onClick={onOpenTerminal}
  disabled={!sessionId || loading}
  style={btnStyle(!sessionId || loading)}
  title={sessionId ? `续接 claude 会话 ${sessionId.slice(0, 8)}` : '需先生成一次分析'}
>
  打开 claude 终端继续追问
</button>
```

- 禁用判据 **`!sessionId || loading`**（非 `!text`）：分析成功但 sessionId 未捕获（stream-json 降级路径无遥测）时按钮仍灰着，正确。导出 .md 按钮同理套 `btnStyle(!text || loading)`。
- 按钮文案常驻；无 sessionId 时灰且带 tooltip 说明原因。

---

## 6. `App.tsx` 接线

```tsx
const cur = reports[selectedPath ?? ''] ?? EMPTY_REPORT
// 报告区：
<AiReport
  text={cur.text}
  loading={cur.loading}
  error={cur.error}
  sessionId={cur.claudeId}
  onGenerate={analyzeWhole}
  onSave={save}
  onOpenTerminal={() => {
    if (cur.claudeId) void window.api.openTerminal(cur.claudeId)
  }}
/>
```

- `analyze` 完成时写回 `reports[selectedPath]`（含 `claudeId: res.sessionId`）；流式 chunk 也写 `reports[key].text` 增量（`key` 闭包锁定起始会话，切走不污染）。
- `cur.claudeId` 作为 `sessionId` prop 传给 AiReport（保持其 prop 名）；切会话（`load`）只换 `selectedPath`、不动 `reports`——下屏自然显示目标会话的报告，`cur.claudeId` 也跟着切，**不串台**。

---

## 7. 测试

| 层 | 用例 |
|---|---|
| `terminal.test.ts`（纯） | `isSessionId` 接受合法 uuid、拒非法串；`buildResumeCommand` Win：exe=`cmd.exe`、args 含 `/d <cwd>` 与 `claude --resume <id>`；Mac：exe=`osascript`、args 含 `cd <cwd> && claude --resume <id>`、cwd 含空格/引号时 AppleScript 转义正确；`openTerminal('not-a-uuid')` 返回 `ok:false`（守卫早返回、不 spawn） |
| `App` 状态 | A→B→A：切回 A 时 `cur.claudeId` 仍是 A 的，不被 B 覆盖；分析失败时 `claudeId` 保持 undefined |
| 集成 | 真实样本分析一次 → 拿到 `claudeId` → 点追问按钮 → 手动确认 OS 终端窗口打开、`claude --resume` 进入交互、有上次分析的上下文 |

> `openTerminal` 的 spawn 路径无单测（CI 无法验窗口）；纯函数 + 守卫已覆盖，spawn 由手动 E2E 验。

---

## 8. 风险与回退

| 风险 | 处置 |
|---|---|
| `claude --resume <id>` 找不到会话 | **根因**：resume cwd 与分析 spawn cwd 不一致（claude 按 sanitize(cwd) 存会话）。**已修**：`openTerminal` 用 `process.cwd()` 与分析同 cwd |
| `claude --resume` 找不到会话（claude session 文件真被清） | 开窗本身不报错；claude 在终端里报错，用户可见。不阻断 |
| Windows `start`/`cmd /k` 行为差异（空 title、PATH 解析） | id 已 UUID 校验；手动验一次 Win/Mac 各开窗 |
| `claude` 未装 | 终端里报"command not found"，用户可见；不影响 app |
| 节点分析覆盖整会话报告 | 已确认可接受（下屏只展示当前那份） |
| 内存 map 无上限 | 单机会话量有限；YAGNI，不 LRU |
| 大会话分析超时 | `analyze:run` 超时放宽 600s；仍超时则排查取证路径（路径错致 claude 反复重试） |

---

## 9. 任务拆分（建议顺序）

1. ✅ **`terminal.ts` + `buildResumeCommand` + 单测**（§3）—— 纯新增，不依赖 stream-json
2. ✅ **`openTerminal` + `terminal:open` IPC + preload + 类型**（§3.2、§4）
3. ✅ **`App.tsx` 报告状态改 per-session Record**（§2、§6）
4. ✅ **`AiReport.tsx` 加追问按钮 + 禁用变灰**（§5）
5. ✅ 手动集成验证（Win 开窗 + resume 进入交互 + 不串台）
6. ✅ 修复：cwd 改 `process.cwd()`（resume 找不到会话）、超时放宽 600s、禁用按钮显式变灰

> 全部落地，typecheck / build / 6 单测通过；手动 E2E 由用户确认。

---

## 10. 与"AI 分析报告链路"改造的分工边界

| 项 | 归属 |
|---|---|
| `runClaudeStream` 解析 `system/init` 取 `sessionId` | 另一终端（已写入其方案 §6.1） |
| `ClaudeResult.sessionId` 透到 renderer、`AiReport` 暂存 | 另一终端（其方案 §7.3） |
| per-session 报告状态 Record | 本方案 |
| 追问按钮 + 禁用判据 | 本方案 |
| `terminal.ts` + `terminal:open` IPC | 本方案 |
| 跨平台开终端 spawn | 本方案 |

> 唯一接口契约：`analyze:run` 的 `ClaudeResult` 必须含 `sessionId?: string`（成功且有则非空、降级时 undefined）。本方案据此 gating 按钮。
