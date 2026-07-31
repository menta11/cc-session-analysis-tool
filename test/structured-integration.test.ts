import { describe, it, expect } from 'vitest'
import { parseLines } from '../core/parser/parse'

describe('parseLines — structured result integration', () => {
  it('attaches the top-level toolUseResult to the paired ToolCall', () => {
    const lines = [
      '{"type":"user","uuid":"u1","timestamp":"2026-04-24T12:00:00.000Z","sessionId":"m","message":{"role":"user","content":"go"}}',
      '{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-04-24T12:00:01.000Z","sessionId":"m","message":{"model":"x","role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}],"usage":{}}}',
      '{"type":"user","uuid":"u2","parentUuid":"a1","timestamp":"2026-04-24T12:00:02.000Z","sessionId":"m","toolUseResult":{"stdout":"file1\\nfile2","stderr":"","interrupted":false},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"file1\\nfile2"}]}}',
    ]
    const s = parseLines(lines, 'm')
    const tc = s.turns[0].toolCalls[0]

    expect(tc.name).toBe('Bash')
    expect(tc.structuredResult).toMatchObject({
      toolName: 'Bash',
      stdout: 'file1\nfile2',
      stderr: '',
      interrupted: false,
    })
  })

  it('extracts Agent structured result (agentId/type/totals) for later subagent linking', () => {
    const lines = [
      '{"type":"user","uuid":"u1","timestamp":"2026-04-24T12:00:00.000Z","sessionId":"m","message":{"role":"user","content":"go"}}',
      '{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-04-24T12:00:01.000Z","sessionId":"m","message":{"model":"x","role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Agent","input":{"description":"do thing"}}],"usage":{}}}',
      '{"type":"user","uuid":"u2","parentUuid":"a1","timestamp":"2026-04-24T12:00:02.000Z","sessionId":"m","toolUseResult":{"agentId":"abc","agentType":"general-purpose","totalDurationMs":12345,"totalTokens":1000,"totalToolUseCount":5,"isAsync":false},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"done"}]}}',
    ]
    const s = parseLines(lines, 'm')
    const tc = s.turns[0].toolCalls[0]

    expect(tc.structuredResult).toMatchObject({
      toolName: 'Agent',
      agentId: 'abc',
      agentType: 'general-purpose',
      totalDurationMs: 12345,
      totalTokens: 1000,
      totalToolUseCount: 5,
      isAsync: false,
    })
  })
})
