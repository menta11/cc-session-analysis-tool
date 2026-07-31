import type { ContentBlock, Usage } from './types'

export const RESULT_PREVIEW_LIMIT = 5 * 1024 // 字符；P1 会放宽为全量+摘要

type Obj = Record<string, unknown>

const toNum = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export function parseTimestamp(s: unknown): number | null {
  if (typeof s !== 'string' || s === '') return null
  const ms = Date.parse(s)
  return Number.isNaN(ms) ? null : ms
}

export function emptyUsage(): Usage {
  return { input: 0, cacheCreation: 0, cacheRead: 0, output: 0, serviceTier: null, ephemeral5m: 0, ephemeral1h: 0 }
}

export function usageFromDict(d: unknown): Usage {
  if (!d || typeof d !== 'object') return emptyUsage()
  const o = d as Obj
  const cc = (o.cache_creation as Obj | undefined) ?? {}
  return {
    input: toNum(o.input_tokens),
    cacheCreation: toNum(o.cache_creation_input_tokens),
    cacheRead: toNum(o.cache_read_input_tokens),
    output: toNum(o.output_tokens),
    serviceTier: typeof o.service_tier === 'string' ? o.service_tier : null,
    ephemeral5m: toNum(cc.ephemeral_5m_input_tokens),
    ephemeral1h: toNum(cc.ephemeral_1h_input_tokens),
  }
}

export function parseContentBlocks(content: unknown): ContentBlock[] {
  if (!Array.isArray(content)) return []
  const out: ContentBlock[] = []
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue
    const b = raw as Obj
    const t = b.type
    if (t === 'text') {
      out.push({ type: 'text', text: String(b.text ?? '') })
    } else if (t === 'thinking') {
      out.push({ type: 'thinking', text: String(b.thinking ?? ''), signature: typeof b.signature === 'string' ? b.signature : null })
    } else if (t === 'tool_use') {
      const input = b.input
      const caller = b.caller
      out.push({
        type: 'tool_use',
        id: String(b.id ?? ''),
        name: String(b.name ?? ''),
        input: input && typeof input === 'object' ? (input as Record<string, unknown>) : {},
        caller: caller && typeof caller === 'object' ? (caller as Record<string, unknown>) : null,
      })
    }
  }
  return out
}

/** 用户消息 content → (拼接文本, 是否含 tool_result)。区分"用户在打字" vs "工具结果回执"。 */
export function extractTextFromContent(content: unknown): { text: string; hasToolResults: boolean } {
  if (typeof content === 'string') return { text: content, hasToolResults: false }
  if (!Array.isArray(content)) return { text: '', hasToolResults: false }
  const texts: string[] = []
  let hasToolResults = false
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue
    const b = raw as Obj
    if (b.type === 'text') texts.push(String(b.text ?? ''))
    else if (b.type === 'tool_result') hasToolResults = true
  }
  return { text: texts.join('\n'), hasToolResults }
}

/** tool_result content → (预览文本, 是否截断)。content 可为 str / list / null。 */
export function extractToolResultText(content: unknown): { text: string; truncated: boolean } {
  let s: string
  if (typeof content === 'string') {
    s = content
  } else if (Array.isArray(content)) {
    const parts: string[] = []
    for (const raw of content) {
      if (raw && typeof raw === 'object') {
        const b = raw as Obj
        if (b.type === 'text') parts.push(String(b.text ?? ''))
      } else if (typeof raw === 'string') {
        parts.push(raw)
      }
    }
    s = parts.join('\n')
  } else if (content == null) {
    return { text: '', truncated: false }
  } else {
    s = JSON.stringify(content)
  }
  if (s.length > RESULT_PREVIEW_LIMIT) return { text: s.slice(0, RESULT_PREVIEW_LIMIT), truncated: true }
  return { text: s, truncated: false }
}
