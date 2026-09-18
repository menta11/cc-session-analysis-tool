/**
 * golden 素材自检。
 *
 * C7 的强度完全依赖 SSE_FULL 这份素材：如果它本身写坏了（data 行不是合法 JSON、
 * 少了多字节字符、或者对抗性切片其实没切在危险位置），C7 会「绿着但没用」。
 * 这组用例把素材本身钉住。
 */
import { describe, expect, it } from 'vitest'
import { SSE_FULL, SSE_TINY, dangerousFragments } from './cases'

/** proxy.js 的 KNOWN_SSE_TYPES（error 由 C8 的 HTTP 错误路径覆盖，不在流素材里） */
const EXPECTED_EVENTS = [
  'message_start',
  'content_block_start',
  'content_block_stop',
  'content_block_delta',
  'message_delta',
  'message_stop',
  'ping',
]

describe('SSE golden 素材自检', () => {
  it('SSE_FULL 每个 event 都有 data 行，且除 [DONE] 外都是合法 JSON', () => {
    const events = SSE_FULL.toString('utf8')
      .split(/\r?\n\r?\n/)
      .filter((e) => e.trim() !== '')
    expect(events.length).toBeGreaterThan(10)

    for (const ev of events) {
      const dataLines = ev.split(/\r?\n/).filter((l) => l.startsWith('data:'))
      expect(dataLines.length, `event 没有 data 行: ${JSON.stringify(ev.slice(0, 60))}`).toBeGreaterThan(0)
      const payload = dataLines.map((l) => l.slice(5).trim()).join('\n')
      if (payload === '[DONE]') continue
      expect(() => JSON.parse(payload), `data 不是合法 JSON: ${payload.slice(0, 100)}`).not.toThrow()
    }
  })

  it('SSE_FULL 覆盖 KNOWN_SSE_TYPES 里的 7 种事件', () => {
    const names = [...SSE_FULL.toString('utf8').matchAll(/^event: (\S+)/gm)].map((m) => m[1])
    for (const want of EXPECTED_EVENTS) {
      expect(names, `素材缺少事件类型 ${want}`).toContain(want)
    }
  })

  it('SSE_FULL 覆盖全部 4 种 delta 类型（含真实流量里实测到的 input_json_delta）', () => {
    const text = SSE_FULL.toString('utf8')
    for (const want of ['text_delta', 'thinking_delta', 'input_json_delta', 'signature_delta']) {
      expect(text, `素材缺少 delta 类型 ${want}`).toContain(`"type":"${want}"`)
    }
  })

  it('SSE_FULL 含真正的多字节字符（否则切在「序列中间」无从谈起）', () => {
    const text = SSE_FULL.toString('utf8')
    for (const ch of ['你好，世界', '🌏', '—', '…', '✓']) {
      expect(text, `素材缺少多字节字符 ${ch}`).toContain(ch)
    }
    // emoji 必须是 4 字节（不是被转义成 \uXXXX）
    expect(Buffer.from('🌏', 'utf8').length).toBe(4)
    expect(text).not.toContain('\\ud83c') // JSON.stringify 未做 \u 转义，emoji 以原始字节存在
  })

  it('dangerousFragments 还原无损，且确实切在多字节序列内部', () => {
    const frags = dangerousFragments(SSE_FULL)
    expect(frags.length).toBeGreaterThan(20)
    expect(Buffer.concat(frags)).toEqual(SSE_FULL)

    // 某一片的末字节是多字节序列的前导字节 → 后面被切开，正是要考的边界
    const cutInsideMultibyte = frags.slice(0, -1).some((f) => (f[f.length - 1] & 0xc0) === 0xc0)
    expect(cutInsideMultibyte, '没有任何切片落在多字节序列内部，对抗性不足').toBe(true)

    // 也必须有切片落在 CRLF 中间（\r 与 \n 之间）
    const cutInsideCrlf = frags.slice(0, -1).some((f) => f[f.length - 1] === 0x0d)
    expect(cutInsideCrlf, '没有切片落在 CRLF 中间').toBe(true)
  })

  it('SSE_TINY 是合法的极小素材，可逐字节喂', () => {
    const events = SSE_TINY.toString('utf8')
      .split(/\r?\n\r?\n/)
      .filter((e) => e.trim() !== '')
    expect(events).toHaveLength(2)
    expect(() => JSON.parse(events[0].split(/\r?\n/)[1].slice(5).trim())).not.toThrow()
    expect(events[1]).toBe('data: [DONE]')
  })
})
