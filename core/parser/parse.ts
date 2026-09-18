import { fsBridge } from '../fsBridge'
import { baseName } from '../paths'
import type { ApiError, AssistantMsg, ContentBlock, Session, Turn, TurnDuration, UserMsg } from './types'
import {
  emptyUsage,
  extractTextFromContent,
  extractToolResultText,
  parseContentBlocks,
  parseTimestamp,
  usageFromRecord,
} from './blocks'
import { extractStructuredResult } from './toolResult'

const SKIP_TYPES = new Set([
  'progress',
  'permission-mode',
  'queue-operation',
  'last-prompt',
  'attachment',
  'file-history-snapshot',
])

type Obj = Record<string, unknown>

/**
 * 用户按 Esc 打断时 cc 写进对话的标记（两种：一般打断 / 打断工具调用）。
 *
 * 判据是**整条正文就是标记**，不做「正文里含标记」：cc 也会把标记拼进用户的下一条消息
 * （本工具开发过程中的一条会话就是 `1、[Request interrupted by user]操作是…`），
 * 那是用户自己的话，按真实提问处理才对。
 */
const INTERRUPT_MARKERS = ['[Request interrupted by user]', '[Request interrupted by user for tool use]']

function isInterruptMarker(text: string): boolean {
  return INTERRUPT_MARKERS.includes(text.trim())
}

/** 裸命令记录：整条正文就是一个 `/name`（本机 16 条，另有 396+ 条是 `<command-name>` 形态）。 */
const BARE_COMMAND = /^\/([A-Za-z:_-]+)$/
/** cc 的命令回显记录：`<command-name>/clear</command-name><command-message>…</command-message>`。 */
const COMMAND_NAME_TAG = /<command-name>([^<]*)<\/command-name>/
/** 用户在命令后面自己写的正文（技能调用的参数）。 */
const COMMAND_ARGS_TAG = /<command-args>([\s\S]*?)<\/command-args>/
/** 命令输出的记录：`<local-command-stdout>…</local-command-stdout>`。 */
const COMMAND_STDOUT_PREFIX = '<local-command-stdout>'

/**
 * 这条 user 记录是 cc 的本地命令壳吗？是就给出命令名（去掉前导 `/`）。
 *
 * `<local-command-stdout>` 自己不带命令名，取**本文件里最近一条命令**（实测 93 条输出记录全部紧跟
 * 在自己的命令记录之后，没有例外；一路没有命令则回 null）。
 * 带 `<command-args>` 的技能调用不算命令记录 —— 用户在那条消息里真的说了话。
 */
function commandNameOf(text: string, lastCommand: string | null): string | null {
  const s = text.trim()
  if (s.startsWith(COMMAND_STDOUT_PREFIX)) return lastCommand
  const args = COMMAND_ARGS_TAG.exec(s)
  if (args && args[1].trim() !== '') return null
  const bare = BARE_COMMAND.exec(s)
  if (bare) return bare[1]
  const named = COMMAND_NAME_TAG.exec(s)
  const name = named ? named[1].trim().replace(/^\//, '') : ''
  return name === '' ? null : name
}

/**
 * 这条 assistant 记录是上游 API 报错吗？
 *
 * 判据只有 `isApiErrorMessage === true` 一个。`model === '<synthetic>'` **不能**拿来代办：错误记录
 * 的 model 确实也是它，但 `/compact` 生成的摘要同样是 `<synthetic>`，那是正常消息。
 *
 * 两个字段都可能缺（本机 86 条里 44 条没归类、17 条没状态码），缺了就是 null —— 与其他「缺失 → null，
 * 不猜」的字段一致，视图层据此走兜底文案。
 */
function apiErrorOf(ev: Obj): ApiError | null {
  if (ev['isApiErrorMessage'] !== true) return null
  const kind = ev['error']
  const status = ev['apiErrorStatus']
  return {
    kind: typeof kind === 'string' && kind !== '' ? kind : null,
    status: typeof status === 'number' && Number.isFinite(status) ? status : null,
  }
}

export interface ParseOptions {
  /** 解析子 agent transcript 时为 true：把 isSidechain 消息当主线（默认 false 仅用于主会话，排除 sidechain 避免与 transcript 双算）。 */
  subagent?: boolean
}

/**
 * 从磁盘读并解析（**同步**）。仅 Node 宿主可用 —— 走 `FsBridge.readTextSync`。
 * Tauri 渲染层没有同步 fs，会抛出明确错误；渲染层请改用
 * `parseJsonlText(await readText(path), path)`。
 */
export function parseJsonl(path: string, options?: ParseOptions): Session {
  return parseJsonlText(fsBridge().readTextSync(path), path, options)
}

/** 从已有文本解析（纯函数，不碰 fs）。跨宿主推荐入口，也是 Tauri 侧使用的那个。 */
export function parseJsonlText(content: string, path: string, options?: ParseOptions): Session {
  return parseLines(content.split('\n'), baseName(path).replace(/\.jsonl$/, ''), options)
}

/**
 * 解析 JSONL 行序列为 Session 树。两遍处理：
 *  1) 逐行 JSON 容错 + 收集会话元数据 + 过滤噪声事件（first-seen-wins）。
 *  2) 按 timestamp 稳定排序后重建 Turn 树，并靠 tool_use_id 把 tool_use↔tool_result 配对算出单次耗时。
 */
export function parseLines(lines: Iterable<string>, sessionIdFallback = 'unknown', options?: ParseOptions): Session {
  const events: Obj[] = []
  const warnings: string[] = []
  const skipped: Record<string, number> = {}
  const systemDurations: TurnDuration[] = []

  let sessionId: string | null = null
  let cwd: string | null = null
  let gitBranch: string | null = null
  let version: string | null = null
  let wallStart: number | null = null
  let wallEnd: number | null = null

  // ---- Pass 1：读行 → 容错 → 过滤 ----
  let i = 0
  for (const rawLine of lines) {
    i++
    const line = typeof rawLine === 'string' ? rawLine.trim() : ''
    if (line === '') continue
    let obj: Obj
    try {
      obj = JSON.parse(line) as Obj
    } catch {
      warnings.push(`line ${i}: JSON decode error`)
      continue
    }
    if (typeof obj !== 'object' || obj === null) {
      warnings.push(`line ${i}: expected object`)
      continue
    }

    const t = obj.type
    sessionId = sessionId ?? (typeof obj.sessionId === 'string' ? obj.sessionId : null)
    cwd = cwd ?? (typeof obj.cwd === 'string' ? obj.cwd : null)
    gitBranch = gitBranch ?? (typeof obj.gitBranch === 'string' ? obj.gitBranch : null)
    version = version ?? (typeof obj.version === 'string' ? obj.version : null)

    // 总耗时跨度取所有记录（含 system/progress）的时间戳 min/max，避免漏末尾 system 事件
    const wallTs = parseTimestamp(obj.timestamp)
    if (wallTs != null) {
      if (wallStart == null || wallTs < wallStart) wallStart = wallTs
      if (wallEnd == null || wallTs > wallEnd) wallEnd = wallTs
    }

    if (t === 'system' && obj.subtype === 'turn_duration') {
      const d = Number(obj.durationMs)
      // ts 一起留下：它既是「哪一轮」的凭据（该轮结束时刻），也不能靠出现顺序当轮号 ——
      // 这个事件不是每轮都发。见 types.ts::TurnDuration。
      if (Number.isFinite(d) && wallTs != null) systemDurations.push({ ts: wallTs, durationMs: d })
      continue
    }
    if (t === 'system' || SKIP_TYPES.has(t as string)) {
      const key = (t as string) ?? 'unknown'
      skipped[key] = (skipped[key] ?? 0) + 1
      continue
    }
    if (t === 'user') {
      // 系统注入的 user 事件（isMeta: 图片粘贴/技能上下文/命名提醒；内容为 task-notification 的后台
      // 任务完成通知）不是真实提问：不建轮，避免污染轮次/间隙/AI 分析素材。
      if (obj['isMeta'] === true) {
        skipped['user-meta'] = (skipped['user-meta'] ?? 0) + 1
        continue
      }
      const content = (obj['message'] as Obj | undefined)?.['content']
      if (typeof content === 'string' && content.startsWith('<task-notification>')) {
        skipped['user-task-notification'] = (skipped['user-task-notification'] ?? 0) + 1
        continue
      }
      events.push(obj)
    } else if (t === 'assistant') {
      events.push(obj)
    } else {
      const key = (t as string) ?? 'unknown'
      skipped[key] = (skipped[key] ?? 0) + 1
    }
  }

  // ---- 按 timestamp 稳定排序 ----
  const ordered = events
    .map((ev, idx) => ({ ev, idx, ts: parseTimestamp(ev.timestamp) }))
    .sort((a, b) => {
      const ta = a.ts ?? Number.NEGATIVE_INFINITY
      const tb = b.ts ?? Number.NEGATIVE_INFINITY
      if (ta === tb) return a.idx - b.idx
      return ta - tb
    })

  // ---- Pass 2：重建 Turn 树 + 工具配对 ----
  const turns: Turn[] = []
  const sidechainMsgs: AssistantMsg[] = []
  const pending = new Map<string, { block: ContentBlock; tsStart: number }>()
  let current: Turn | null = null

  /**
   * `message.id` → 已建好的那条消息 + 它已带上的 tool_use id（后续记录要并进同一条）。
   * `inMain` = 这条消息算在主线里（sidechain 且没开 subagent 模式的不算，它的工具也不登记）。
   */
  const byMessageId = new Map<string, { msg: AssistantMsg; toolUseIds: string[]; inMain: boolean }>()

  /** 本文件里最近一条本地命令的名字（命令输出记录靠它认领自己的命令）。 */
  let lastCommand: string | null = null

  const newTurn = (userMsg: UserMsg | null): Turn => {
    const turn: Turn = { index: turns.length, userMsg, assistantMsgs: [], toolCalls: [] }
    turns.push(turn)
    current = turn
    return turn
  }

  for (const { ev, ts } of ordered) {
    if (ts === null) {
      warnings.push(`event ${String(ev.uuid ?? '')}: missing/invalid timestamp`)
      continue
    }

    const t = ev.type
    const msg = (ev.message ?? {}) as Obj
    const uuid = String(ev.uuid ?? '')
    const parentUuid = typeof ev.parentUuid === 'string' ? ev.parentUuid : null

    if (t === 'user') {
      const content = msg.content
      const { text, hasToolResults } = extractTextFromContent(content)
      const commandName = commandNameOf(text, lastCommand)
      if (commandName !== null) lastCommand = commandName
      const userMsg: UserMsg = {
        uuid,
        parentUuid,
        ts,
        text,
        hasToolResults,
        isInterrupt: isInterruptMarker(text),
        commandName,
      }

      const isNewTurnStarter = typeof content === 'string' || (Array.isArray(content) && !hasToolResults)
      if (isNewTurnStarter) {
        newTurn(userMsg)
      } else {
        // 工具结果回执 → 挂当前 Turn，按 tool_use_id 配对
        const cur = current ?? newTurn(null)
        if (Array.isArray(content)) {
          for (const item of content) {
            if (!item || typeof item !== 'object') continue
            const b = item as Obj
            if (b.type !== 'tool_result') continue
            const tid = String(b.tool_use_id ?? '')
            if (tid === '') continue
            const p = pending.get(tid)
            if (!p) continue
            pending.delete(tid)
            const block = p.block as Extract<ContentBlock, { type: 'tool_use' }>
            const { text: preview, truncated } = extractToolResultText(b.content)
            cur.toolCalls.push({
              toolUseId: tid,
              name: block.name,
              input: block.input,
              result: preview,
              isError: Boolean(b.is_error),
              tsStart: p.tsStart,
              tsEnd: ts,
              durationMs: ts - p.tsStart,
              resultTruncated: truncated,
              structuredResult: extractStructuredResult(block.name, ev.toolUseResult),
            })
          }
        }
      }
    } else if (t === 'assistant') {
      const model = String(msg.model ?? '')
      const blocks = parseContentBlocks(msg.content)
      // message.id = API 消息的身份；同一条消息的记录共享它。缺了就退回 uuid（各成一条消息）
      const msgId = typeof msg.id === 'string' && msg.id !== '' ? msg.id : uuid
      const known = byMessageId.get(msgId)

      if (known) {
        // 同一条消息的后续记录：内容并入，时刻推进到「消息写完」。
        known.msg.blocks.push(...blocks)
        known.msg.ts = ts
        // 同一条消息的几条记录是**边写边落**的：先落的那些只有 input，output 与缓存那几个字段要等
        // 最后一条才补齐（子 agent transcript 里几乎条条如此）。token 账因此取**最后一条带 usage 的
        // 记录** —— 取第一条会把 output 读成 0，而 input 也会少掉缓存那几项。
        const usage = usageFromRecord(msg.usage)
        if (usage) known.msg.usage = usage
        if (known.msg.stopReason == null && typeof msg.stop_reason === 'string') {
          known.msg.stopReason = msg.stop_reason
        }
        // 这条消息里更早记录带的 tool_use：那时整条消息还没写完，工具最早也只能现在开跑。
        // 不这么挪的话，工具的开始时刻会落在模型还在吐字的时间段里（多算一截「生成时间」当执行时间）。
        for (const id of known.toolUseIds) {
          const p = pending.get(id)
          if (p && p.tsStart < ts) p.tsStart = ts
        }
      } else {
        const amsg: AssistantMsg = {
          uuid,
          parentUuid,
          ts,
          model,
          blocks,
          usage: usageFromRecord(msg.usage) ?? emptyUsage(),
          stopReason: typeof msg.stop_reason === 'string' ? msg.stop_reason : null,
          isSidechain: Boolean(ev.isSidechain),
          isSynthetic: model === '<synthetic>',
          apiError: apiErrorOf(ev),
        }
        // 被排除的 sidechain 消息不进主线，它带的工具也不登记 —— 否则边线里的工具会跟主线的
        // 工具结果配成对（默认模式下那正是要避免的重复计数）。
        const inMain = !(amsg.isSidechain && !options?.subagent)
        byMessageId.set(msgId, { msg: amsg, toolUseIds: [], inMain })
        if (inMain) (current ?? newTurn(null)).assistantMsgs.push(amsg)
        else sidechainMsgs.push(amsg)
      }

      const entry = byMessageId.get(msgId)
      if (!entry?.inMain) continue
      for (const b of blocks) {
        if (b.type !== 'tool_use') continue
        pending.set(b.id, { block: b, tsStart: ts })
        entry.toolUseIds.push(b.id)
      }
    }
  }

  const unmatchedToolUses: ContentBlock[] = [...pending.values()].map((p) => p.block)

  return {
    sessionId: sessionId ?? sessionIdFallback,
    cwd,
    gitBranch,
    version,
    isSubagent: options?.subagent ?? false,
    startedAt: wallStart,
    endedAt: wallEnd,
    turns,
    sidechainMsgs,
    unmatchedToolUses,
    systemTurnDurations: systemDurations,
    skippedCounts: skipped,
    parseWarnings: warnings,
  }
}
