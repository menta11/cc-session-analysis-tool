import { describe, it, expect } from 'vitest'
import { parseLines } from '../core/parser/parse'
import { breakdownOf, sessionIntervals, complement } from '../core/model/timeBreakdown'

// 两轮：T0=Bash(10s)+Agent(100s)+AskUserQuestion(50s)；轮间间隙 39s；T1=纯回复(5s 思考)。
const lines = [
  // T0
  '{"type":"user","uuid":"u1","timestamp":"2026-04-24T12:00:00.000Z","sessionId":"m","message":{"role":"user","content":"go"}}',
  '{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-04-24T12:00:01.000Z","sessionId":"m","message":{"model":"x","role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{}}],"usage":{}}}',
  '{"type":"user","uuid":"u2","parentUuid":"a1","timestamp":"2026-04-24T12:00:11.000Z","sessionId":"m","toolUseResult":{"stdout":"out","stderr":"","interrupted":false},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"out"}]}}',
  '{"type":"assistant","uuid":"a2","parentUuid":"u2","timestamp":"2026-04-24T12:00:11.000Z","sessionId":"m","message":{"model":"x","role":"assistant","content":[{"type":"tool_use","id":"t2","name":"Agent","input":{}}],"usage":{}}}',
  '{"type":"user","uuid":"u3","parentUuid":"a2","timestamp":"2026-04-24T12:01:51.000Z","sessionId":"m","toolUseResult":{"agentId":"child","agentType":"general-purpose"},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t2","content":"done"}]}}',
  '{"type":"assistant","uuid":"a3","parentUuid":"u3","timestamp":"2026-04-24T12:01:51.000Z","sessionId":"m","message":{"model":"x","role":"assistant","content":[{"type":"tool_use","id":"t3","name":"AskUserQuestion","input":{}}],"usage":{}}}',
  '{"type":"user","uuid":"u4","parentUuid":"a3","timestamp":"2026-04-24T12:02:41.000Z","sessionId":"m","toolUseResult":{"questions":[],"answers":[]},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t3","content":"answer"}]}}',
  // T1（新 prompt @200s → 轮间间隙 200-161=39s）
  '{"type":"user","uuid":"u5","timestamp":"2026-04-24T12:03:20.000Z","sessionId":"m","message":{"role":"user","content":"next"}}',
  '{"type":"assistant","uuid":"a4","parentUuid":"u5","timestamp":"2026-04-24T12:03:25.000Z","sessionId":"m","message":{"model":"x","role":"assistant","content":[{"type":"text","text":"ok"}],"usage":{}}}',
]

describe('breakdownOf', () => {
  it('decomposes wall into 等用户 / 本地工具 / compute(模型思考)', () => {
    const b = breakdownOf(parseLines(lines, 'm'))

    expect(b.directMs).toBe(10_000) // Bash [1k,11k]
    expect(b.delegatedMs).toBe(100_000) // Agent [11k,111k]
    expect(b.localToolMs).toBe(110_000) // merged Bash∪Agent = [1k,111k]
    expect(b.waitUserMs).toBe(89_000) // 轮间间隙 39k + AskUserQuestion 50k
    expect(b.wallMs).toBe(205_000) // 0 → 末尾 205k
    expect(b.computeMs).toBe(6_000) // 205k − 89k − 110k = 6k（T0 起步 1k + T1 思考 5k）
  })

  it('merges parallel Agent intervals (no double-count)', () => {
    const parallel = [
      '{"type":"user","uuid":"u1","timestamp":"2026-04-24T12:00:00.000Z","sessionId":"m","message":{"role":"user","content":"go"}}',
      '{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-04-24T12:00:01.000Z","sessionId":"m","message":{"model":"x","role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Agent","input":{}},{"type":"tool_use","id":"t2","name":"Agent","input":{}}],"usage":{}}}',
      '{"type":"user","uuid":"u2","parentUuid":"a1","timestamp":"2026-04-24T12:01:40.000Z","sessionId":"m","toolUseResult":{"agentId":"c1"},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"d1"}]}}',
      '{"type":"user","uuid":"u3","parentUuid":"a1","timestamp":"2026-04-24T12:02:30.000Z","sessionId":"m","toolUseResult":{"agentId":"c2"},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t2","content":"d2"}]}}',
    ]
    const b = breakdownOf(parseLines(parallel, 'm'))
    expect(b.delegatedMs).toBe(149_000) // 两 Agent 都从 1k 起，重叠 → 并集 149s
    expect(b.waitUserMs).toBe(0) // 单轮、无 AskUserQuestion
  })

  it('counts only the node’s own calls (delegated = dispatch span, child internals excluded)', () => {
    const s = parseLines(lines, 'm')
    s.turns[0].toolCalls[1].childSession = parseLines(
      [
        '{"type":"user","uuid":"cu1","timestamp":"2026-04-24T12:00:11.000Z","sessionId":"child","message":{"role":"user","content":"sub"}}',
        '{"type":"assistant","uuid":"ca1","parentUuid":"cu1","timestamp":"2026-04-24T12:01:51.000Z","sessionId":"child","message":{"model":"x","role":"assistant","content":[{"type":"tool_use","id":"ct","name":"Bash","input":{}}],"usage":{}}}',
        '{"type":"user","uuid":"cu2","parentUuid":"ca1","timestamp":"2026-04-24T12:01:51.000Z","sessionId":"child","toolUseResult":{"stdout":"","stderr":"","interrupted":false},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"ct","content":"x"}]}}',
      ],
      'child',
    )
    const b = breakdownOf(s)
    expect(b.delegatedMs).toBe(100_000) // 仍是父侧 Agent 调度区间
    expect(b.directMs).toBe(10_000) // 父自己的 Bash，不被子的 Bash 污染
  })
})

describe('workflow 的那一类（workflowMs）', () => {
  // 一轮：0s 提问 → 1s 发起 workflow（0.337s 就返回）→ 20s~30s 主 agent 顺手跑了个 Bash
  // → 120s 收尾。workflow 按 run 记录真跑了 90s（[1s, 91s]），横跨主线上那段 Bash。
  const wfLines = [
    '{"type":"user","uuid":"u1","timestamp":"2026-04-24T12:00:00.000Z","sessionId":"m","message":{"role":"user","content":"跑一遍评审"}}',
    '{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-04-24T12:00:01.000Z","sessionId":"m","message":{"model":"x","role":"assistant","content":[{"type":"tool_use","id":"wf","name":"Workflow","input":{"scriptPath":"D:/wf/x.js"}}],"usage":{}}}',
    '{"type":"user","uuid":"u2","parentUuid":"a1","timestamp":"2026-04-24T12:00:01.337Z","sessionId":"m","toolUseResult":{"status":"async_launched","taskId":"t","taskType":"local_workflow","workflowName":"parallel-review","runId":"wf_1"},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"wf","content":"Workflow launched in background."}]}}',
    '{"type":"assistant","uuid":"a2","parentUuid":"u2","timestamp":"2026-04-24T12:00:20.000Z","sessionId":"m","message":{"model":"x","role":"assistant","content":[{"type":"tool_use","id":"b1","name":"Bash","input":{}}],"usage":{}}}',
    '{"type":"user","uuid":"u3","parentUuid":"a2","timestamp":"2026-04-24T12:00:30.000Z","sessionId":"m","toolUseResult":{"stdout":"","stderr":"","interrupted":false},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"b1","content":"x"}]}}',
    '{"type":"assistant","uuid":"a3","parentUuid":"u3","timestamp":"2026-04-24T12:02:00.000Z","sessionId":"m","message":{"model":"x","role":"assistant","content":[{"type":"text","text":"收尾"}],"usage":{}}}',
  ]

  /** 给那条 Workflow 调用挂上 run 记录（真链接见 test/linkWorkflows.test.ts） */
  const withRun = (durationMs: number | null): ReturnType<typeof parseLines> => {
    const s = parseLines(wfLines, 'm')
    const tc = s.turns.flatMap((t) => t.toolCalls).find((c) => c.name === 'Workflow')!
    if (durationMs !== null) {
      tc.workflowRun = {
        runId: 'wf_1',
        workflowName: 'parallel-review',
        summary: '',
        status: 'completed',
        startTs: Date.parse('2026-04-24T12:00:01.000Z'),
        durationMs,
        agentCount: 3,
        totalTokens: null,
        totalToolCalls: null,
        phases: [],
        resultText: '',
        resultTruncated: false,
        logs: [],
      }
    }
    return s
  }

  it('用 run 记录的真实区间，不用调用自己那 337ms', () => {
    const b = breakdownOf(withRun(90_000))
    expect(b.workflowMs).toBe(90_000) // [1s, 91s]
    expect(b.directMs).toBe(10_000) // 主线那个 Bash [20s, 30s]
    expect(b.localToolMs).toBe(90_000) // Bash 落在 workflow 区间里 → 并集还是 90s
    expect(b.wallMs).toBe(120_000)
    // 等式没破：总耗时 = 等用户 + 本地工具 + 模型思考（新类别进了 localTool，不是另起一摊）
    expect(b.waitUserMs + b.localToolMs + b.computeMs).toBe(b.wallMs)
    expect(b.computeMs).toBe(30_000)
  })

  it('workflow 与直接工具可以重叠（后台在跑、主 agent 照常干活），逐项相加会超过并集', () => {
    const b = breakdownOf(withRun(90_000))
    expect(b.directMs + b.workflowMs).toBeGreaterThan(b.localToolMs) // 重叠那 10s 只算一次
  })

  it('没有 run 记录 → 退回发起那一段，不拿「发起→返回」冒充运行时长', () => {
    const b = breakdownOf(withRun(null))
    expect(b.workflowMs).toBe(337) // [1s, 1.337s]：调用自己那个长度
    expect(b.localToolMs).toBe(10_337) // 与 [20s,30s] 的 Bash 并集
  })

  it('甘特区间：workflow 那一段单独成类，不与 direct 混在一起', () => {
    const ci = sessionIntervals(withRun(90_000))
    expect(ci.workflow).toEqual([
      { start: Date.parse('2026-04-24T12:00:01.000Z'), end: Date.parse('2026-04-24T12:01:31.000Z') },
    ])
    expect(ci.direct).toEqual([
      { start: Date.parse('2026-04-24T12:00:20.000Z'), end: Date.parse('2026-04-24T12:00:30.000Z') },
    ])
  })
})

describe('sessionIntervals + complement（甘特数据）', () => {
  const BASE = Date.parse('2026-04-24T12:00:00.000Z')

  it('produces per-category wall-clock intervals with compute as complement', () => {
    const ci = sessionIntervals(parseLines(lines, 'm'))
    expect(ci.direct).toEqual([{ start: BASE + 1_000, end: BASE + 11_000 }])
    expect(ci.delegated).toEqual([{ start: BASE + 11_000, end: BASE + 111_000 }])
    // waitUser = AskUserQuestion [111k,161k] + 轮间间隙 [161k,200k]
    expect(ci.waitUser).toContainEqual({ start: BASE + 111_000, end: BASE + 161_000 })
    expect(ci.waitUser).toContainEqual({ start: BASE + 161_000, end: BASE + 200_000 })
    // compute = [0,1k] ∪ [200k,205k]（工具/等待覆盖的补集）
    expect(ci.compute).toEqual([
      { start: BASE, end: BASE + 1_000 },
      { start: BASE + 200_000, end: BASE + 205_000 },
    ])
  })

  it('complement subtracts intervals from a range', () => {
    expect(complement([{ start: 2, end: 4 }], 0, 10)).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 10 },
    ])
    expect(complement([], 0, 10)).toEqual([{ start: 0, end: 10 }])
    expect(complement([{ start: 0, end: 10 }], 0, 10)).toEqual([])
  })
})

describe('方案A：后台 agent 与等用户重叠 → 等用户让出（sum=总耗时）', () => {
  it('async agent 子总耗时覆盖整个轮间间隙 → 等用户=0，重叠归委派', () => {
    const s = parseLines(
      [
        '{"type":"user","uuid":"u1","timestamp":"2026-04-24T12:00:00.000Z","sessionId":"m","message":{"role":"user","content":"go"}}',
        '{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-04-24T12:00:01.000Z","sessionId":"m","message":{"model":"x","role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Agent","input":{}}],"usage":{}}}',
        '{"type":"user","uuid":"u2","parentUuid":"a1","timestamp":"2026-04-24T12:00:05.000Z","sessionId":"m","toolUseResult":{"agentId":"c","agentType":"general-purpose"},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"done"}]}}',
        '{"type":"user","uuid":"u3","timestamp":"2026-04-24T12:01:05.000Z","sessionId":"m","message":{"role":"user","content":"next"}}',
        '{"type":"assistant","uuid":"a3","parentUuid":"u3","timestamp":"2026-04-24T12:01:06.000Z","sessionId":"m","message":{"model":"x","role":"assistant","content":[{"type":"text","text":"ok"}],"usage":{}}}',
      ],
      'm',
    )
    // 异步后台 agent：子总耗时 [5k,65k] 正好覆盖整个轮间间隙 [5k,65k]
    s.turns[0].toolCalls[0].childSession = parseLines(
      [
        '{"type":"user","uuid":"cu1","timestamp":"2026-04-24T12:00:05.000Z","sessionId":"c","message":{"role":"user","content":"sub"}}',
        '{"type":"assistant","uuid":"ca1","parentUuid":"cu1","timestamp":"2026-04-24T12:01:05.000Z","sessionId":"c","message":{"model":"x","role":"assistant","content":[{"type":"text","text":"ok"}],"usage":{}}}',
      ],
      'c',
    )
    const b = breakdownOf(s)
    expect(b.delegatedMs).toBe(60_000) // 子总耗时 [5k,65k]
    expect(b.waitUserMs).toBe(0) // 轮间间隙被 agent 全覆盖 → 让出 → 真空闲 0
    expect(b.computeMs).toBe(6_000) // [0,5k] + [65k,66k]
    expect(b.waitUserMs + b.localToolMs + b.computeMs).toBe(b.wallMs) // sum 严格 = 总耗时
  })
})
