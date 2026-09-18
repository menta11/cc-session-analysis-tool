/**
 * `claude` CLI 调用 —— 从 迁移前 Electron 壳的 `claudeCli.ts`（已删除） 迁到 `core/`，此后由 Tauri 渲染层独占使用。
 *
 * 迁移原则（同 `core/fsBridge.ts`）：**只把子进程 IO 换成 `ProcBridge`，业务逻辑逐字保留**。
 * 于是 stream-json 逐行解析、stdin 组装、能力探测判据、以及「delta 与整消息二选一避免重复」
 * 的策略都留在 TS —— 它们有 9 条测试。
 *
 * 唯一形状变化：`resolveClaudePath` / `claudeCapabilities` 由同步变异步（Tauri 只有异步 IPC）。
 * 它们本来就在 `runClaudeStream` 的 async 路径上且带缓存，所以调用方无感；缓存改成缓存
 * **Promise** 而不是值，顺带把并发首调去重了。
 */
import { procBridge } from '../procBridge'

export interface ClaudeResult {
  ok: boolean
  text: string
  error?: string
  /** stream-json system/init 与 result 事件取出，备后续追问（--resume）。 */
  sessionId?: string
  /** result 事件白送：本次调用花费（美元）。 */
  costUsd?: number
  /** result 事件白送：claude 端实测耗时（ms）。 */
  durationMs?: number
  /** result 事件白送：claude 端轮次数。 */
  numTurns?: number
}

// ──────────────────────── 纯函数（可单测） ────────────────────────

/**
 * 组装 stdin：systemPrompt 作为指令前缀 inline 进 userMessage。
 * 不走 `--append-system-prompt` argv —— Windows 下 claude 是 .cmd shim，
 * 必须 shell:true 调用，argv 里的 `|`（表格）会被 cmd.exe 当管道符切碎；
 * stdin 不经 shell 解析，安全承载任意字符。
 */
export function buildStdin(systemPrompt: string, userMessage: string): string {
  return `${systemPrompt}\n\n---\n\n# 待分析数据\n\n${userMessage}`
}

/** stream-json 单行解析结果。坏行/空行返回 { type: 'other' }。 */
export interface ParsedStreamEvent {
  type: 'system' | 'assistant' | 'delta' | 'result' | 'other'
  text?: string
  sessionId?: string
  costUsd?: number
  durationMs?: number
  numTurns?: number
}

/**
 * 解析 stream-json 一行（NDJSON）。容错：非法 JSON 返回 other，不抛。
 * - system/init → sessionId
 * - stream_event.content_block_delta.text_delta → 增量文本（delta）
 * - assistant 整消息 → 全量文本（partial 模式下作回退，避免与 delta 重复）
 * - result → cost/duration/numTurns/sessionId
 */
export function parseStreamJsonLine(line: string): ParsedStreamEvent {
  const s = line.trim()
  if (!s) return { type: 'other' }
  let obj: {
    type?: string
    subtype?: string
    session_id?: string
    message?: { content?: Array<{ type: string; text?: string }> }
    event?: { type?: string; delta?: { type?: string; text?: string } }
    total_cost_usd?: number
    duration_ms?: number
    num_turns?: number
  }
  try {
    obj = JSON.parse(s)
  } catch {
    return { type: 'other' }
  }
  if (obj.type === 'system' && obj.subtype === 'init') {
    return { type: 'system', sessionId: typeof obj.session_id === 'string' ? obj.session_id : undefined }
  }
  if (obj.type === 'stream_event' && obj.event) {
    if (
      obj.event.type === 'content_block_delta' &&
      obj.event.delta?.type === 'text_delta' &&
      typeof obj.event.delta.text === 'string'
    ) {
      return { type: 'delta', text: obj.event.delta.text }
    }
    return { type: 'other' }
  }
  if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
    let text = ''
    for (const b of obj.message.content) {
      if (b && b.type === 'text' && typeof b.text === 'string') text += b.text
    }
    return text ? { type: 'assistant', text } : { type: 'other' }
  }
  if (obj.type === 'result') {
    return {
      type: 'result',
      sessionId: typeof obj.session_id === 'string' ? obj.session_id : undefined,
      costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : undefined,
      durationMs: typeof obj.duration_ms === 'number' ? obj.duration_ms : undefined,
      numTurns: typeof obj.num_turns === 'number' ? obj.num_turns : undefined,
    }
  }
  return { type: 'other' }
}

// ──────────────────────── claude 路径/能力探测（缓存 Promise） ────────────────────────

let pathPromise: Promise<string | null> | undefined

/** 解析 claude 可执行路径（Windows: where; Unix: which）。缓存。 */
export function resolveClaudePath(): Promise<string | null> {
  pathPromise ??= (async () => {
    const cmd = procBridge().platform === 'win32' ? 'where' : 'which'
    try {
      const r = await procBridge().execText(cmd, ['claude'])
      return r.out.split(/\r?\n/).map((x) => x.trim()).find(Boolean) ?? null
    } catch {
      return null
    }
  })()
  return pathPromise
}

export interface ClaudeCaps {
  /** 支持 --output-format stream-json（+ --verbose）。 */
  streamJson: boolean
  /** 支持 --include-partial-messages（增量 delta，真流式）。 */
  partial: boolean
}

let capsPromise: Promise<ClaudeCaps> | undefined

/** 探测 claude 能力（--help 一次，缓存）。 */
export function claudeCapabilities(): Promise<ClaudeCaps> {
  capsPromise ??= (async () => {
    const p = await resolveClaudePath()
    if (!p) return { streamJson: false, partial: false }
    try {
      const r = await procBridge().execText(p, ['--help'])
      return {
        streamJson: r.out.includes('stream-json'),
        partial: r.out.includes('include-partial-messages'),
      }
    } catch {
      return { streamJson: false, partial: false }
    }
  })()
  return capsPromise
}

// ──────────────────────── 对外 API ────────────────────────

/**
 * 流式调用 claude：
 * - 支持 partial → `--include-partial-messages`，stream_event delta 经 onChunk 逐段透出（真流式）。
 * - 仅 stream-json（无 partial）→ 整 assistant 消息一次性 onChunk + 取遥测。
 * - 都不支持 → `claude -p` 原始文本（无流式/遥测）。
 * systemPrompt 始终 inline 进 stdin（见 buildStdin）。
 */
export async function runClaudeStream(
  userMessage: string,
  systemPrompt: string,
  onChunk: (text: string) => void,
  opts: { timeoutMs?: number } = {},
): Promise<ClaudeResult> {
  const stdin = buildStdin(systemPrompt, userMessage)
  const caps = await claudeCapabilities()
  const useStream = caps.streamJson
  const usePartial = caps.streamJson && caps.partial
  const args = usePartial
    ? ['-p', '--verbose', '--include-partial-messages', '--output-format', 'stream-json']
    : useStream
      ? ['-p', '--verbose', '--output-format', 'stream-json']
      : ['-p']
  let sessionId: string | undefined
  let costUsd: number | undefined
  let durationMs: number | undefined
  let numTurns: number | undefined
  let text = ''
  let gotDeltas = false
  // label: 'claude' —— 保持迁移前的用户可见错误文案不变
  const res = await procBridge().runLines(
    'claude',
    args,
    stdin,
    (line) => {
      if (!useStream) {
        text += line + '\n'
        return
      }
      const ev = parseStreamJsonLine(line)
      if (ev.type === 'delta' && ev.text) {
        gotDeltas = true
        text += ev.text
        onChunk(ev.text)
      } else if (ev.type === 'assistant' && ev.text && !gotDeltas) {
        // 非 partial 模式：整消息一次性透出（partial 模式下 delta 已累积，跳过避免重复）
        text += ev.text
        onChunk(ev.text)
      } else if (ev.type === 'system') {
        sessionId = ev.sessionId
      } else if (ev.type === 'result') {
        if (ev.sessionId) sessionId = ev.sessionId
        costUsd = ev.costUsd
        durationMs = ev.durationMs
        numTurns = ev.numTurns
      }
    },
    { timeoutMs: opts.timeoutMs, label: 'claude' },
  )
  return {
    ok: res.ok,
    text: useStream ? text : text.trimEnd(),
    error: res.error,
    sessionId,
    costUsd,
    durationMs,
    numTurns,
  }
}
