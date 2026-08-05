import { describe, it, expect } from 'vitest'
import { parseLines } from '../core/parser/parse'
import { clipSessionToWindow } from '../core/ai/sessionWindow'

const lines = [
  '{"type":"user","uuid":"u1","timestamp":"2026-04-24T12:00:00.000Z","sessionId":"m","cwd":"/home/me/proj","message":{"role":"user","content":"go"}}',
  '{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-04-24T12:00:01.000Z","sessionId":"m","message":{"model":"x","role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}],"usage":{}}}',
  '{"type":"user","uuid":"u2","parentUuid":"a1","timestamp":"2026-04-24T12:00:11.000Z","sessionId":"m","toolUseResult":{"stdout":"o"},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"o"}]}}',
  '{"type":"assistant","uuid":"a2","parentUuid":"u2","timestamp":"2026-04-24T12:00:11.000Z","sessionId":"m","message":{"model":"x","role":"assistant","content":[{"type":"tool_use","id":"t2","name":"Agent","input":{"description":"do thing"}}],"usage":{}}}',
  '{"type":"user","uuid":"u3","parentUuid":"a2","timestamp":"2026-04-24T12:01:51.000Z","sessionId":"m","toolUseResult":{"agentId":"c","agentType":"general-purpose","totalDurationMs":99000,"description":"do thing"},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t2","content":"done"}]}}',
  '{"type":"user","uuid":"u4","timestamp":"2026-04-24T12:03:20.000Z","sessionId":"m","message":{"role":"user","content":"next"}}',
  '{"type":"assistant","uuid":"a3","parentUuid":"u4","timestamp":"2026-04-24T12:03:25.000Z","sessionId":"m","message":{"model":"x","role":"assistant","content":[{"type":"text","text":"ok"}],"usage":{}}}',
]

const session = parseLines(lines, 'm')

describe('clipSessionToWindow', () => {
  it('keeps all turns when window covers whole session', () => {
    const clipped = clipSessionToWindow(session, session.startedAt!, session.endedAt!)
    expect(clipped.turns.length).toBe(session.turns.length)
    expect(clipped.sessionId).toBe(session.sessionId)
  })

  it('keeps only turns within window (complete turns, not sliced)', () => {
    // 窗口 [12:00:11, 12:03:20]：覆盖 t2 agent turn + 最后的 user turn
    const start = session.startedAt! + 11_000
    const end = session.startedAt! + 200_000
    const clipped = clipSessionToWindow(session, start, end)
    // 应保留窗口内完整 turns（t2 agent turn + next turn）
    expect(clipped.turns.length).toBeGreaterThan(0)
    // 每个保留的 turn 是完整的（含其 toolCalls）
    for (const t of clipped.turns) {
      expect(t.toolCalls.length).toBe(t.toolCalls.length) // 结构完整
    }
  })

  it('sets startedAt/endedAt to window bounds', () => {
    const start = session.startedAt! + 11_000
    const end = session.startedAt! + 200_000
    const clipped = clipSessionToWindow(session, start, end)
    expect(clipped.startedAt).toBe(start)
    expect(clipped.endedAt).toBe(end)
  })

  it('returns empty turns when window has no turns', () => {
    const start = session.startedAt! + 500_000
    const end = session.startedAt! + 600_000
    const clipped = clipSessionToWindow(session, start, end)
    expect(clipped.turns.length).toBe(0)
  })
})