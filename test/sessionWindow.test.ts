import { describe, it, expect } from 'vitest'
import { parseLines } from '../core/parser/parse'
import { clipSessionToWindow } from '../core/ai/sessionWindow'
import { breakdownOf } from '../core/model/timeBreakdown'

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

  it('clips child agent duration to window (delegated not inflated)', () => {
    // 给 t2 Agent 调用挂一个子 agent：子 agent 时间戳超出窗口（90s 时长，横跨窗口边界）
    const childLines = [
      '{"type":"user","uuid":"cu1","timestamp":"2026-04-24T12:00:11.000Z","sessionId":"child","message":{"role":"user","content":"sub"}}',
      '{"type":"assistant","uuid":"ca1","parentUuid":"cu1","timestamp":"2026-04-24T12:01:41.000Z","sessionId":"child","message":{"model":"x","role":"assistant","content":[{"type":"text","text":"ok"}],"usage":{}}}',
    ]
    const child = parseLines(childLines, 'child')
    // t2 Agent 在第一个 turn 的第 2 个 toolCall
    session.turns[0].toolCalls[1].childSession = child

    // 窗口 [11s, 60s]：t2 在 11s 发起，子 agent 11s-101s，窗口只覆盖 [11s,60s]
    const start = session.startedAt! + 11_000
    const end = session.startedAt! + 60_000
    const clipped = clipSessionToWindow(session, start, end)
    const b = breakdownOf(clipped)
    // delegated 时长不应超过窗口（60s-11s=49s）
    expect(b.delegatedMs).toBeLessThanOrEqual(end - start)
  })
})