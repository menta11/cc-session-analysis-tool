import { describe, it, expect } from 'vitest'
import { parseLines } from '../core/parser/parse'
import { buildTreeNode } from '../core/view/treeView'

const lines = [
  '{"type":"user","uuid":"u1","timestamp":"2026-04-24T12:00:00.000Z","sessionId":"m","cwd":"/home/me/proj","message":{"role":"user","content":"go"}}',
  '{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-04-24T12:00:01.000Z","sessionId":"m","message":{"model":"x","role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}],"usage":{}}}',
  '{"type":"user","uuid":"u2","parentUuid":"a1","timestamp":"2026-04-24T12:00:11.000Z","sessionId":"m","toolUseResult":{"stdout":"o","stderr":"","interrupted":false},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"o"}]}}',
  '{"type":"assistant","uuid":"a2","parentUuid":"u2","timestamp":"2026-04-24T12:00:11.000Z","sessionId":"m","message":{"model":"x","role":"assistant","content":[{"type":"tool_use","id":"t2","name":"Agent","input":{"description":"do thing"}}],"usage":{}}}',
  '{"type":"user","uuid":"u3","parentUuid":"a2","timestamp":"2026-04-24T12:01:51.000Z","sessionId":"m","toolUseResult":{"agentId":"child","agentType":"general-purpose","totalDurationMs":99000,"totalTokens":500,"totalToolUseCount":3,"isAsync":false,"description":"do thing"},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t2","content":"done"}]}}',
  '{"type":"assistant","uuid":"a3","parentUuid":"u3","timestamp":"2026-04-24T12:01:51.000Z","sessionId":"m","message":{"model":"x","role":"assistant","content":[{"type":"tool_use","id":"t3","name":"AskUserQuestion","input":{}}],"usage":{}}}',
  '{"type":"user","uuid":"u4","parentUuid":"a3","timestamp":"2026-04-24T12:02:41.000Z","sessionId":"m","toolUseResult":{"questions":[],"answers":[]},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t3","content":"ans"}]}}',
  '{"type":"user","uuid":"u5","timestamp":"2026-04-24T12:03:20.000Z","sessionId":"m","message":{"role":"user","content":"next"}}',
  '{"type":"assistant","uuid":"a4","parentUuid":"u5","timestamp":"2026-04-24T12:03:25.000Z","sessionId":"m","message":{"model":"x","role":"assistant","content":[{"type":"text","text":"ok"}],"usage":{}}}',
]

describe('buildTreeNode', () => {
  it('builds root → 等用户 / 本地工具 / compute with breakdown ms', () => {
    const s = parseLines(lines, 'm')
    const tree = buildTreeNode(s)
    expect(tree.kind).toBe('root')
    expect(tree.ms).toBe(205_000) // wall
    expect(tree.children!.map((c) => c.kind)).toEqual(['waitUser', 'localTool', 'compute'])
    expect(tree.children!.find((c) => c.kind === 'waitUser')!.ms).toBe(89_000) // 39k 间隙 + 50k Ask
    expect(tree.children!.find((c) => c.kind === 'compute')!.ms).toBe(6_000)
  })

  it('buckets direct tools into Bash / other under 本地工具 → 直接工具', () => {
    const s = parseLines(lines, 'm')
    const tree = buildTreeNode(s)
    const local = tree.children!.find((c) => c.kind === 'localTool')!
    const direct = local.children!.find((c) => c.kind === 'direct')!
    expect(direct.children!.map((c) => c.label)).toEqual(['Bash'])
    expect(direct.children![0].count).toBe(1)
    expect(direct.children![0].calls?.[0].name).toBe('Bash')
  })

  it('lists delegated agents (sorted by duration, expandable when childSession present)', () => {
    const s = parseLines(lines, 'm')
    // 给 Agent 调用挂一个子会话 → expandable
    s.turns[0].toolCalls[1].childSession = parseLines(
      [
        '{"type":"user","uuid":"cu1","timestamp":"2026-04-24T12:00:11.000Z","sessionId":"child","message":{"role":"user","content":"sub"}}',
        '{"type":"assistant","uuid":"ca1","parentUuid":"cu1","timestamp":"2026-04-24T12:01:51.000Z","sessionId":"child","message":{"model":"x","role":"assistant","content":[{"type":"text","text":"ok"}],"usage":{}}}',
      ],
      'child',
    )
    const tree = buildTreeNode(s)
    const delegated = tree.children!.find((c) => c.kind === 'localTool')!.children!.find((c) => c.kind === 'delegated')!
    expect(delegated.count).toBe(1)
    const agent = delegated.children![0]
    expect(agent.kind).toBe('agent')
    expect(agent.ms).toBe(100_000) // 子 agent 总耗时（11k→111k）
    expect(agent.expandable).toBe(true)
    expect(agent.childSession).toBeDefined()
    expect(agent.label).toContain('general-purpose')
  })
})
