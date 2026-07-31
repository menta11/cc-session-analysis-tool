import { describe, it, expect } from 'vitest'
import { buildStdin, parseStreamJsonLine } from '../electron/main/claudeCli'

describe('buildStdin', () => {
  it('systemPrompt inline 为前缀 + 分隔 + 待分析数据 + userMessage', () => {
    const s = buildStdin('SYS', 'DATA')
    expect(s).toContain('SYS')
    expect(s).toContain('---')
    expect(s).toContain('# 待分析数据')
    expect(s).toContain('DATA')
    // 顺序：SYS 在前，DATA 在后
    expect(s.indexOf('SYS')).toBeLessThan(s.indexOf('DATA'))
  })
})

describe('parseStreamJsonLine', () => {
  it('空行 / 非法 JSON → other', () => {
    expect(parseStreamJsonLine('').type).toBe('other')
    expect(parseStreamJsonLine('   ').type).toBe('other')
    expect(parseStreamJsonLine('not json').type).toBe('other')
  })

  it('system/init → 取出 sessionId', () => {
    const ev = parseStreamJsonLine(
      '{"type":"system","subtype":"init","session_id":"abc-123","cwd":"/x","version":"2.1.210"}',
    )
    expect(ev.type).toBe('system')
    expect(ev.sessionId).toBe('abc-123')
  })

  it('assistant 文本 → 取出 text', () => {
    const ev = parseStreamJsonLine(
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello "}]}}',
    )
    expect(ev.type).toBe('assistant')
    expect(ev.text).toBe('hello ')
  })

  it('stream_event content_block_delta → delta 增量文本', () => {
    const ev = parseStreamJsonLine(
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"1\\n"}}}',
    )
    expect(ev.type).toBe('delta')
    expect(ev.text).toBe('1\n')
  })

  it('stream_event 非 text delta → other', () => {
    const ev = parseStreamJsonLine(
      '{"type":"stream_event","event":{"type":"message_start","message":{}}}',
    )
    expect(ev.type).toBe('other')
  })

  it('assistant 无 text 块（仅 thinking）→ other', () => {
    const ev = parseStreamJsonLine(
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","text":"..."}]}}',
    )
    expect(ev.type).toBe('other')
  })

  it('result → 取出 cost/duration/numTurns/sessionId', () => {
    const ev = parseStreamJsonLine(
      '{"type":"result","result":"done","session_id":"abc-123","total_cost_usd":0.0012,"duration_ms":4500,"num_turns":1,"is_error":false}',
    )
    expect(ev.type).toBe('result')
    expect(ev.sessionId).toBe('abc-123')
    expect(ev.costUsd).toBe(0.0012)
    expect(ev.durationMs).toBe(4500)
    expect(ev.numTurns).toBe(1)
  })

  it('其他 type → other', () => {
    const ev = parseStreamJsonLine('{"type":"stream_event","event_type":"content_block_delta"}')
    expect(ev.type).toBe('other')
  })
})
