import { describe, it, expect } from 'vitest'
import { parseLines } from '../core/parser/parse'
import { buildTreeNode, clipTreeToWindow } from '../core/view/treeView'

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

describe('clipTreeToWindow', () => {
  const s = parseLines(lines, 'm')
  const tree = buildTreeNode(s)

  it('keeps tree unchanged when window covers whole session', () => {
    const clipped = clipTreeToWindow(tree, s.startedAt!, s.endedAt!)
    expect(clipped.ms).toBe(tree.ms)
    expect(clipped.children!.length).toBe(3)
    const wait = clipped.children!.find((c) => c.kind === 'waitUser')!
    expect(wait.ms).toBe(tree.children!.find((c) => c.kind === 'waitUser')!.ms)
  })

  it('clips segments to window and recomputes node ms', () => {
    // 窗口 [11s, 111s]：只覆盖 t2 agent 的段
    const start = s.startedAt! + 11_000
    const end = s.startedAt! + 111_000
    const clipped = clipTreeToWindow(tree, start, end)
    // 根节点 ms = 窗口时长
    expect(clipped.ms).toBe(100_000)
    // delegated 段完全在窗口内 → ms 保留
    const local = clipped.children!.find((c) => c.kind === 'localTool')!
    const delegated = local.children!.find((c) => c.kind === 'delegated')!
    expect(delegated.ms).toBe(100_000)
    // waitUser 段被裁剪（窗口内无 waitUser 段？依赖会话结构）
    const wait = clipped.children!.find((c) => c.kind === 'waitUser')!
    expect(wait.ms).toBeGreaterThanOrEqual(0)
  })

  it('sets wallMs to window duration for all nodes', () => {
    const start = s.startedAt! + 11_000
    const end = s.startedAt! + 111_000
    const clipped = clipTreeToWindow(tree, start, end)
    expect(clipped.wallMs).toBe(100_000)
    expect(clipped.children![0].wallMs).toBe(100_000)
  })

  it('preserves calls (toolBucket detail) unfiltered', () => {
    const start = s.startedAt! + 11_000
    const end = s.startedAt! + 111_000
    const clipped = clipTreeToWindow(tree, start, end)
    const local = clipped.children!.find((c) => c.kind === 'localTool')!
    const direct = local.children!.find((c) => c.kind === 'direct')!
    const bash = direct.children!.find((c) => c.kind === 'toolBucket')!
    // 窗口内没有 Bash 调用（t1 在 1s-11s），但 calls 保留完整
    expect(bash.calls).toHaveLength(1)
  })

  it('returns null-ms nodes when segments all outside window', () => {
    const start = s.startedAt! + 112_000 // 窗口在 t2 之后
    const end = s.startedAt! + 200_000
    const clipped = clipTreeToWindow(tree, start, end)
    const local = clipped.children!.find((c) => c.kind === 'localTool')!
    const delegated = local.children!.find((c) => c.kind === 'delegated')!
    expect(delegated.ms).toBe(0)
  })

  it('recomputes count to windowed segment count (calls kept full)', () => {
    // 窗口 [11s, 111s]：只覆盖 t2 agent 段，不覆盖 t1 Bash 段
    const start = s.startedAt! + 11_000
    const end = s.startedAt! + 111_000
    const clipped = clipTreeToWindow(tree, start, end)
    const local = clipped.children!.find((c) => c.kind === 'localTool')!
    const direct = local.children!.find((c) => c.kind === 'direct')!
    const bash = direct.children!.find((c) => c.kind === 'toolBucket')!
    // Bash 段（1s-11s）在窗口外 → count 重算为 0，但 calls 保留完整
    expect(bash.count).toBe(0)
    expect(bash.calls).toHaveLength(1)
    // delegated agent 段（11s-111s）在窗口内 → count 保持
    const delegated = local.children!.find((c) => c.kind === 'delegated')!
    expect(delegated.count).toBe(1)
  })
})
