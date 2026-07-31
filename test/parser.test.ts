import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { parseJsonl, parseLines } from '../core/parser/parse'

const FIXTURE = fileURLToPath(new URL('./fixtures/mini_session.jsonl', import.meta.url))

describe('parseJsonl — basic structure', () => {
  it('parses session metadata and turn structure', () => {
    const s = parseJsonl(FIXTURE)

    expect(s.sessionId).toBe('mini')
    expect(s.cwd).toBe('/home/user/proj')
    expect(s.gitBranch).toBe('main')
    expect(s.version).toBe('2.1.110')

    expect(s.turns).toHaveLength(2)
    const [t0, t1] = s.turns

    expect(t0.userMsg?.text).toBe('run my tests')
    expect(t0.assistantMsgs).toHaveLength(2)
    expect(t0.toolCalls).toHaveLength(2)

    expect(t1.userMsg?.text).toBe('now summarize')
    expect(t1.assistantMsgs).toHaveLength(1)
    expect(t1.toolCalls).toHaveLength(0)
  })
})

describe('parseJsonl — content blocks', () => {
  it('parses thinking/text/tool_use blocks of the first assistant msg', () => {
    const s = parseJsonl(FIXTURE)
    const blocks = s.turns[0].assistantMsgs[0].blocks

    expect(blocks).toHaveLength(3)
    expect(blocks[0]).toMatchObject({ type: 'thinking', text: 'I should run pytest', signature: 'sig1' })
    expect(blocks[1]).toMatchObject({ type: 'text', text: 'Running your tests.' })
    expect(blocks[2]).toMatchObject({ type: 'tool_use', name: 'Bash' })
  })
})

describe('parseJsonl — tool pairing', () => {
  it('pairs tool_use↔tool_result by id and computes wall-clock duration', () => {
    const s = parseJsonl(FIXTURE)
    const byName = new Map(s.turns[0].toolCalls.map((c) => [c.name, c]))

    const bash = byName.get('Bash')!
    expect(bash.isError).toBe(false)
    expect(bash.tsEnd).not.toBeNull()
    expect(bash.result).toBe('3 passed in 0.2s')
    expect(bash.durationMs).toBeGreaterThanOrEqual(1400) // a1 12:00:01 → u2 12:00:02.5 = 1500ms
    expect(bash.durationMs).toBeLessThanOrEqual(1600)

    const read = byName.get('Read')!
    expect(read.isError).toBe(true)
    expect(read.result).toBe('file not found')
  })
})

describe('parseJsonl — usage', () => {
  it('parses token usage incl ephemeral cache breakdown', () => {
    const s = parseJsonl(FIXTURE)
    const u = s.turns[0].assistantMsgs[0].usage

    expect(u.input).toBe(10)
    expect(u.cacheCreation).toBe(100)
    expect(u.cacheRead).toBe(200)
    expect(u.output).toBe(50)
    expect(u.serviceTier).toBe('standard')
    expect(u.ephemeral1h).toBe(100)
  })
})

describe('parseJsonl — sidechain isolation', () => {
  it('keeps sidechain messages out of main turns', () => {
    const s = parseJsonl(FIXTURE)
    expect(s.sidechainMsgs).toHaveLength(1)
    for (const turn of s.turns) {
      for (const a of turn.assistantMsgs) {
        expect(a.isSidechain).toBe(false)
      }
    }
  })
})

describe('parseJsonl — noise filtering', () => {
  it('skips progress events and captures turn_duration', () => {
    const s = parseJsonl(FIXTURE)
    expect(s.skippedCounts.progress ?? 0).toBe(1)
    expect(s.systemTurnDurationsMs).toEqual([6000])
  })
})

describe('parseLines — tolerance', () => {
  it('skips malformed JSON lines with a warning instead of throwing', () => {
    const lines = [
      '{"type":"user","uuid":"u1","parentUuid":null,"timestamp":"2026-04-24T12:00:00.000Z","sessionId":"m","message":{"role":"user","content":"hi"}}',
      '{not json',
      '{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-04-24T12:00:01.000Z","sessionId":"m","message":{"model":"x","role":"assistant","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":1,"output_tokens":1}}}',
    ]
    const s = parseLines(lines, 'm')

    expect(s.parseWarnings).toHaveLength(1)
    expect(s.turns).toHaveLength(1)
    expect(s.turns[0].assistantMsgs).toHaveLength(1)
  })

  it('truncates tool results over the 5KB preview limit', () => {
    const big = 'x'.repeat(6 * 1024)
    const lines = [
      '{"type":"user","uuid":"u1","parentUuid":null,"timestamp":"2026-04-24T12:00:00.000Z","sessionId":"m","message":{"role":"user","content":"go"}}',
      '{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-04-24T12:00:01.000Z","sessionId":"m","message":{"model":"x","role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{}}],"usage":{}}}',
      '{"type":"user","uuid":"u2","parentUuid":"a1","timestamp":"2026-04-24T12:00:02.000Z","sessionId":"m","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"' + big + '"}]}}',
    ]
    const s = parseLines(lines, 'm')

    expect(s.turns[0].toolCalls).toHaveLength(1)
    const tc = s.turns[0].toolCalls[0]
    expect(tc.resultTruncated).toBe(true)
    expect(tc.result).not.toBeNull()
    expect(tc.result!.length).toBe(5 * 1024)
  })
})
