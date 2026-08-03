import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { AssistantMsg, ContentBlock, Session, Turn, UserMsg } from './types'
import {
  extractTextFromContent,
  extractToolResultText,
  parseContentBlocks,
  parseTimestamp,
  usageFromDict,
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

export interface ParseOptions {
  /** 解析子 agent transcript 时为 true：把 isSidechain 消息当主线（默认 false 仅用于主会话，排除 sidechain 避免与 transcript 双算）。 */
  subagent?: boolean
}

export function parseJsonl(path: string, options?: ParseOptions): Session {
  const content = readFileSync(path, 'utf8')
  return parseLines(content.split('\n'), basename(path).replace(/\.jsonl$/, ''), options)
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
  const systemDurations: number[] = []

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
      if (Number.isFinite(d)) systemDurations.push(d)
      continue
    }
    if (t === 'system' || SKIP_TYPES.has(t as string)) {
      const key = (t as string) ?? 'unknown'
      skipped[key] = (skipped[key] ?? 0) + 1
      continue
    }
    if (t === 'user' || t === 'assistant') {
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
      const userMsg: UserMsg = { uuid, parentUuid, ts, text, hasToolResults }

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
      const amsg: AssistantMsg = {
        uuid,
        parentUuid,
        ts,
        model,
        blocks,
        usage: usageFromDict(msg.usage),
        isSidechain: Boolean(ev.isSidechain),
        isSynthetic: model === '<synthetic>',
      }

      if (amsg.isSidechain && !options?.subagent) {
        sidechainMsgs.push(amsg)
        continue
      }
      const cur = current ?? newTurn(null)
      cur.assistantMsgs.push(amsg)
      for (const b of blocks) {
        if (b.type === 'tool_use') pending.set(b.id, { block: b, tsStart: ts })
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
    systemTurnDurationsMs: systemDurations,
    skippedCounts: skipped,
    parseWarnings: warnings,
  }
}
