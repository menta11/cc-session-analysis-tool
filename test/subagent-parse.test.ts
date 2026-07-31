import { describe, it, expect } from 'vitest'
import { parseLines } from '../core/parser/parse'

// 子 agent transcript 的记录全部 isSidechain:true；解析它时须把 sidechain 当主线，否则 tool_use 被排除、无法配对/递归。
const lines = [
  '{"type":"user","uuid":"u1","isSidechain":true,"timestamp":"2026-04-24T12:00:00.000Z","sessionId":"m","message":{"role":"user","content":"go"}}',
  '{"type":"assistant","uuid":"a1","parentUuid":"u1","isSidechain":true,"timestamp":"2026-04-24T12:00:01.000Z","sessionId":"m","message":{"model":"x","role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{}}],"usage":{}}}',
  '{"type":"user","uuid":"u2","parentUuid":"a1","isSidechain":true,"timestamp":"2026-04-24T12:00:02.000Z","sessionId":"m","toolUseResult":{"stdout":"out","stderr":"","interrupted":false},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"out"}]}}',
]

describe('parseLines — subagent transcript mode', () => {
  it('default (main session): excludes sidechain assistant msgs → no tool pairing', () => {
    const s = parseLines(lines, 'm')
    expect(s.sidechainMsgs).toHaveLength(1)
    expect(s.turns[0].toolCalls).toHaveLength(0)
  })

  it('subagent:true: treats sidechain as main thread → pairs tool_use/result', () => {
    const s = parseLines(lines, 'm', { subagent: true })
    expect(s.sidechainMsgs).toHaveLength(0)
    expect(s.turns[0].toolCalls).toHaveLength(1)
    expect(s.turns[0].toolCalls[0].name).toBe('Bash')
    expect(s.turns[0].toolCalls[0].structuredResult).toMatchObject({ toolName: 'Bash', stdout: 'out' })
  })
})
