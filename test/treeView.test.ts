import { describe, it, expect } from 'vitest'
import { parseLines } from '../core/parser/parse'
import { buildTreeNode, clipTreeToWindow, findToolPath } from '../core/view/treeView'

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

  it('workflow 自成一支：一次调用一个节点，它下面是这一跑的子 agent（各自可展开）', () => {
    const wfLines = [
      '{"type":"user","uuid":"u1","timestamp":"2026-04-24T12:00:00.000Z","sessionId":"m","message":{"role":"user","content":"评审"}}',
      '{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-04-24T12:00:01.000Z","sessionId":"m","message":{"model":"x","role":"assistant","content":[{"type":"tool_use","id":"wf","name":"Workflow","input":{"scriptPath":"D:/wf/x.js"}}],"usage":{}}}',
      '{"type":"user","uuid":"u2","parentUuid":"a1","timestamp":"2026-04-24T12:00:01.337Z","sessionId":"m","toolUseResult":{"status":"async_launched","taskId":"t","taskType":"local_workflow","workflowName":"parallel-review","runId":"wf_1"},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"wf","content":"launched"}]}}',
      '{"type":"assistant","uuid":"a3","parentUuid":"u2","timestamp":"2026-04-24T12:01:40.000Z","sessionId":"m","message":{"model":"x","role":"assistant","content":[{"type":"text","text":"收尾"}],"usage":{}}}',
    ]
    const s = parseLines(wfLines, 'm')
    const tc = s.turns.flatMap((t) => t.toolCalls).find((c) => c.name === 'Workflow')!
    tc.workflowRun = {
      runId: 'wf_1',
      workflowName: 'parallel-review',
      summary: '',
      status: 'completed',
      startTs: Date.parse('2026-04-24T12:00:01.000Z'),
      durationMs: 90_000,
      agentCount: 2,
      totalTokens: null,
      totalToolCalls: null,
      phases: [],
      resultText: '',
      resultTruncated: false,
      logs: [],
    }
    const child = (id: string, prompt: string): ReturnType<typeof parseLines> =>
      parseLines(
        [
          `{"type":"user","uuid":"${id}u","timestamp":"2026-04-24T12:00:02.000Z","sessionId":"${id}","isSidechain":true,"message":{"role":"user","content":"${prompt}"}}`,
          `{"type":"assistant","uuid":"${id}a","parentUuid":"${id}u","timestamp":"2026-04-24T12:00:40.000Z","sessionId":"${id}","isSidechain":true,"message":{"model":"x","role":"assistant","content":[{"type":"text","text":"ok"}],"usage":{}}}`,
        ],
        id,
      )
    tc.childSessions = [child('c1', '你是准确性与一致性专家'), child('c2', '你是边界条件专家')]

    const tree = buildTreeNode(s)
    const local = tree.children!.find((c) => c.kind === 'localTool')!
    const wfBucket = local.children!.find((c) => c.kind === 'workflow')!
    expect(wfBucket.label).toBe('workflow')
    expect(wfBucket.ms).toBe(90_000) // run 记录的真实时长，不是调用自己那 337ms
    expect(wfBucket.count).toBe(1)
    expect(wfBucket.segments).toEqual([
      { start: Date.parse('2026-04-24T12:00:01.000Z'), end: Date.parse('2026-04-24T12:01:31.000Z'), color: 'var(--cat-workflow)' },
    ])

    const run = wfBucket.children![0]
    expect(run.kind).toBe('workflow')
    expect(run.label).toBe('parallel-review · 2 个子 agent')
    expect(run.ms).toBe(90_000)
    expect(run.call?.toolUseId).toBe('wf')
    // 子 agent 是这一跑的 children（不是 childSession：一次调用背后是一整套）
    expect(run.children!.map((c) => c.kind)).toEqual(['agent', 'agent'])
    expect(run.children![0].label).toBe('#1 你是准确性与一致性专家')
    expect(run.children![0].expandable).toBe(true)
    expect(run.children![0].childSession?.sessionId).toBe('c1')
    expect(run.children![0].ms).toBe(38_000) // 该子 agent 自己的时间跨度
  })

  it('没有 run 记录时标签明说状态未知之外的实情（用回执里的名字，不编）', () => {
    const noRun = [
      '{"type":"user","uuid":"u1","timestamp":"2026-04-24T12:00:00.000Z","sessionId":"m","message":{"role":"user","content":"评审"}}',
      '{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-04-24T12:00:01.000Z","sessionId":"m","message":{"model":"x","role":"assistant","content":[{"type":"tool_use","id":"wf","name":"Workflow","input":{"scriptPath":"D:/wf/x.js"}}],"usage":{}}}',
      '{"type":"user","uuid":"u2","parentUuid":"a1","timestamp":"2026-04-24T12:00:01.337Z","sessionId":"m","toolUseResult":{"status":"async_launched","workflowName":"parallel-review"},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"wf","content":"launched"}]}}',
    ]
    const tree = buildTreeNode(parseLines(noRun, 'm'))
    const wfBucket = tree.children!.find((c) => c.kind === 'localTool')!.children!.find((c) => c.kind === 'workflow')!
    const run = wfBucket.children![0]
    expect(run.label).toBe('parallel-review')
    expect(run.ms).toBe(337) // 退回发起那一段
    expect(run.children).toEqual([])
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

  it('clips calls to window (tsStart within window)', () => {
    const start = s.startedAt! + 11_000
    const end = s.startedAt! + 111_000
    const clipped = clipTreeToWindow(tree, start, end)
    const local = clipped.children!.find((c) => c.kind === 'localTool')!
    const direct = local.children!.find((c) => c.kind === 'direct')!
    const bash = direct.children!.find((c) => c.kind === 'toolBucket')!
    // 窗口 [11s,111s]：t1 Bash 在 1s-11s（tsStart 不在窗口内）→ calls 裁剪为空
    expect(bash.calls).toHaveLength(0)
  })

  it('returns null-ms nodes when segments all outside window', () => {
    const start = s.startedAt! + 112_000 // 窗口在 t2 之后
    const end = s.startedAt! + 200_000
    const clipped = clipTreeToWindow(tree, start, end)
    const local = clipped.children!.find((c) => c.kind === 'localTool')!
    const delegated = local.children!.find((c) => c.kind === 'delegated')!
    expect(delegated.ms).toBe(0)
  })

  it('recomputes count to windowed segment count', () => {
    // 窗口 [11s, 111s]：只覆盖 t2 agent 段，不覆盖 t1 Bash 段
    const start = s.startedAt! + 11_000
    const end = s.startedAt! + 111_000
    const clipped = clipTreeToWindow(tree, start, end)
    const local = clipped.children!.find((c) => c.kind === 'localTool')!
    const direct = local.children!.find((c) => c.kind === 'direct')!
    const bash = direct.children!.find((c) => c.kind === 'toolBucket')!
    // Bash 段（1s-11s）在窗口外 → count 重算为 0
    expect(bash.count).toBe(0)
    // delegated agent 段（11s-111s）在窗口内 → count 保持
    const delegated = local.children!.find((c) => c.kind === 'delegated')!
    expect(delegated.count).toBe(1)
  })
})

describe('findToolPath（日志视图「在树视图定位」用）', () => {
  it('直接工具：定位到它所在的桶，路径 = 逐层下标', () => {
    const s = parseLines(lines, 'm')
    const tree = buildTreeNode(s)
    // root.children = [waitUser, localTool, compute] → localTool.children = [direct, delegated]
    // → direct.children = [bucket-Bash]
    expect(findToolPath(tree, 't1')).toEqual({ node: expect.objectContaining({ id: 'bucket-Bash' }), path: [1, 0, 0] })
  })

  it('委派调用：定位到 agent 节点', () => {
    const s = parseLines(lines, 'm')
    const hit = findToolPath(buildTreeNode(s), 't2')
    expect(hit?.node.kind).toBe('agent')
    expect(hit?.path).toEqual([1, 1, 0])
  })

  it('子 agent 内部的工具：定位进子会话的树，路径接在 agent 节点之后', () => {
    const s = parseLines(lines, 'm')
    const child = parseLines(
      [
        '{"type":"user","uuid":"cu1","timestamp":"2026-04-24T12:00:11.000Z","sessionId":"child","message":{"role":"user","content":"sub"}}',
        '{"type":"assistant","uuid":"ca1","parentUuid":"cu1","timestamp":"2026-04-24T12:00:12.000Z","sessionId":"child","message":{"model":"x","role":"assistant","content":[{"type":"tool_use","id":"ct1","name":"Grep","input":{"pattern":"x"}}],"usage":{}}}',
        '{"type":"user","uuid":"cu2","parentUuid":"ca1","timestamp":"2026-04-24T12:00:13.000Z","sessionId":"child","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"ct1","content":"o"}]}}',
      ],
      'child',
    )
    s.turns[0].toolCalls[1].childSession = child
    const hit = findToolPath(buildTreeNode(s), 'ct1')
    expect(hit?.node.id).toBe('bucket-other')
    // [localTool, delegated, agent-0] + 子会话内 [localTool, direct, bucket-other]
    expect(hit?.path).toEqual([1, 1, 0, 1, 0, 0])
  })

  it('找不到就返回 null（调用方据此不切视图）', () => {
    const s = parseLines(lines, 'm')
    expect(findToolPath(buildTreeNode(s), '不存在的 id')).toBeNull()
  })
})
