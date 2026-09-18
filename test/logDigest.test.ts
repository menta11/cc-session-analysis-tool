import { describe, it, expect } from 'vitest'
import { buildLogDigest, MAX_DIGEST_ROWS, type LogScope } from '../core/ai/logDigest'
import { breakdownLines, buildDigest } from '../core/ai/prompt'
import { buildLogRows, logSummary, type LogRow, type LogSummary } from '../core/view/logView'
import { breakdownOf } from '../core/model/timeBreakdown'
import { parseLines } from '../core/parser/parse'

/**
 * 与 `test/timeBreakdown.test.ts` 同一份重叠 fixture：workflow 按 run 记录真跑 90s（[1s,91s]），
 * 横跨主线上 20s~30s 那段 Bash。**「本地工具」的并集与相加在这里会给出两个不同的数** ——
 * 正是这一点让两份 digest 的口径分歧可以被钉住。
 */
const wfLines = [
  '{"type":"user","uuid":"u1","timestamp":"2026-04-24T12:00:00.000Z","sessionId":"m","message":{"role":"user","content":"跑一遍评审"}}',
  '{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-04-24T12:00:01.000Z","sessionId":"m","message":{"model":"x","role":"assistant","content":[{"type":"tool_use","id":"wf","name":"Workflow","input":{"scriptPath":"D:/wf/x.js"}}],"usage":{}}}',
  '{"type":"user","uuid":"u2","parentUuid":"a1","timestamp":"2026-04-24T12:00:01.337Z","sessionId":"m","toolUseResult":{"status":"async_launched","taskId":"t","taskType":"local_workflow","workflowName":"parallel-review","runId":"wf_1"},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"wf","content":"Workflow launched in background."}]}}',
  '{"type":"assistant","uuid":"a2","parentUuid":"u2","timestamp":"2026-04-24T12:00:20.000Z","sessionId":"m","message":{"model":"x","role":"assistant","content":[{"type":"tool_use","id":"b1","name":"Bash","input":{}}],"usage":{}}}',
  '{"type":"user","uuid":"u3","parentUuid":"a2","timestamp":"2026-04-24T12:00:30.000Z","sessionId":"m","toolUseResult":{"stdout":"","stderr":"","interrupted":false},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"b1","content":"x"}]}}',
  '{"type":"assistant","uuid":"a3","parentUuid":"u3","timestamp":"2026-04-24T12:02:00.000Z","sessionId":"m","message":{"model":"x","role":"assistant","content":[{"type":"text","text":"收尾"}],"usage":{}}}',
]

/** 手搓一行：默认值给全，用例只覆盖自己关心的字段（与 logView.test.ts 的 rowOf 同一套做法）。 */
const rowOf = (patch: Partial<LogRow>): LogRow => ({
  id: 'r1',
  fullId: 'r1',
  kind: 'tool',
  ts: 0,
  action: 'Bash',
  summary: 'x',
  status: 'ok',
  tokens: null,
  durationMs: 0,
  turn: 0,
  invokedTools: [],
  leadId: null,
  mergedWith: null,
  panels: [],
  ...patch,
})

const summaryOf = (patch: Partial<LogSummary> = {}): LogSummary => ({
  wallMs: 100_000,
  waitUserMs: 10_000,
  localToolMs: 50_000,
  directMs: 30_000,
  delegatedMs: 20_000,
  workflowMs: 0,
  computeMs: 40_000,
  ...patch,
})

const scopeOf = (patch: Partial<LogScope> = {}): LogScope => ({
  rows: [rowOf({})],
  total: 1,
  filterLabel: '未筛选（全部记录）',
  sortLabel: '',
  spanLabel: '01-02 10:02 ~ 01-02 10:05',
  ...patch,
})

/**
 * 表格行的单元格：按**未转义**的 `|` 切开，用来断言逐列内容。
 *
 * 必须跳过 `\|` —— 那是单元格内部的竖线（摘要里是 bash 命令，带竖线是常态）。
 * 用朴素 split 会把它也当分隔符，于是「转义生效了」反而看列数变多，判据正好判反。
 */
const cellsOf = (line: string): string[] => line.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim())

describe('buildLogDigest', () => {
  it('头部写明筛选条件、全量与本次条数、排列方式', () => {
    const text = buildLogDigest(
      scopeOf({ total: 120, sortLabel: '倒序', filterLabel: '类型=工具；状态=失败' }),
      summaryOf(),
    )
    expect(text).toContain('- 筛选条件：类型=工具；状态=失败')
    expect(text).toContain('- 范围：全量 120 条 → 本次分析 1 条')
    expect(text).toContain('- 排列：倒序')
    // 没重排时不写一个「正常」让人猜它到底是什么意思
    expect(buildLogDigest(scopeOf(), summaryOf())).toContain('- 排列：时序（未重排）')
    expect(text).toContain('- 时间范围：01-02 10:02 ~ 01-02 10:05')
  })

  it('耗时分解标注为整会话口径，且与树视图读同一个函数（本地工具取并集，代数不破）', () => {
    const summary = summaryOf()
    const text = buildLogDigest(scopeOf({ total: 7 }), summary)
    expect(text).toContain('整会话耗时分解（**整个会话**的口径，不是筛选后的合计）')
    expect(text).toContain('总耗时 1m40s')
    expect(text).toContain('等用户 10s (10%)')
    // 与 prompt.ts::buildDigest 逐字同源 —— 不是「这一份也算对了」，是**同一段代码**
    for (const line of breakdownLines(summary)) expect(text).toContain(line)
    expect(summary.waitUserMs + summary.localToolMs + summary.computeMs).toBe(summary.wallMs)
    // 三类相加可以大于 localToolMs（并行时同一秒被算几遍），所以它只当明细，不参与任何求和
    expect(text).toContain('本地工具 50s (50%)')
    expect(text).toContain('直接 30s / 委派子agent 20s / workflow 0s')
    expect(text).toContain('模型思考 40s (40%)')
  })

  it('三类相加大于本地工具时，打出来的仍是并集（并行会话不会打出 >100%）', () => {
    // workflow 与直接工具重叠：worked 90s 里只有 60s 是并集
    const summary = summaryOf({ localToolMs: 60_000, directMs: 60_000, delegatedMs: 0, workflowMs: 90_000, wallMs: 120_000, waitUserMs: 0, computeMs: 60_000 })
    const text = buildLogDigest(scopeOf({ total: 1 }), summary)
    expect(text).toContain('本地工具 1m0s (50%)')
    expect(text).not.toContain('本地工具 2m30s')
    // 代数：0 + 60s + 60s = 120s = 总耗时
    expect(summary.waitUserMs + summary.localToolMs + summary.computeMs).toBe(summary.wallMs)
  })

  it('筛选后分布按耗时降序，条数与耗时都是筛选后的口径', () => {
    const rows: LogRow[] = [
      rowOf({ id: 'a', kind: 'tool', durationMs: 3_000 }),
      rowOf({ id: 'b', kind: 'tool', durationMs: 1_000 }),
      rowOf({ id: 'c', kind: 'llm', durationMs: 5_000, tokens: { input: 1_200, output: 40 } }),
    ]
    const text = buildLogDigest(scopeOf({ rows, total: 9 }), summaryOf())
    const dist = text.slice(text.indexOf('## 筛选后分布'), text.indexOf('## 记录表'))
    expect(dist).toContain('| 工具 | 2 | 4s |')
    expect(dist).toContain('| LLM | 1 | 5s |')
    // 耗时长的类型排在前面
    expect(dist.indexOf('LLM')).toBeLessThan(dist.indexOf('工具'))
  })

  it('记录表逐列取自 LogRow：ID/时间/类型/操作/摘要/耗时/token/状态', () => {
    const ts = new Date(2026, 0, 2, 10, 2, 11, 0).getTime()
    const rows: LogRow[] = [
      rowOf({
        id: 'toolu_01Ab3x',
        fullId: 'toolu_01Ab3xKmQ7pR9vTe',
        kind: 'subagent',
        ts,
        action: 'tool_use + Agent · explore',
        summary: '重构认证',
        status: 'error',
        tokens: { input: 4_200, output: 380 },
        durationMs: 62_000,
        mergedWith: 'tool',
      }),
    ]
    const text = buildLogDigest(scopeOf({ rows }), summaryOf())
    const line = text.split('\n').find((l) => l.startsWith('| toolu_01Ab3x'))!
    // 类型列与界面徽章同源（kindLabelOf）、状态列与筛选 chip 同源（LOG_STATUS_LABEL）：
    // 委派那一步写「Agent」、失败写「失败」，而不是机器读的 'subagent' / 'error'
    expect(cellsOf(line)).toEqual(['toolu_01Ab3x', '10:02:11.000', 'Agent', 'tool_use + Agent · explore', '重构认证', '1m2s', '4.2k', '380', '失败'])
  })

  it('摘要里的竖线与换行不会把表格切碎', () => {
    const rows = [rowOf({ summary: 'grep -E "a|b" x\ny', action: 'Bash|Sh' })]
    const text = buildLogDigest(scopeOf({ rows }), summaryOf())
    const line = text.split('\n').find((l) => l.startsWith('| r1'))!
    // 竖线转义、换行压成空格 —— 列数因此仍是 9，不多不少
    expect(cellsOf(line)).toHaveLength(9)
    expect(line).toContain('grep -E "a\\|b" x y')
    expect(line).toContain('Bash\\|Sh')
  })

  it('原本就带反斜杠的输入：转义不会自己抵消（bash 的 `a\\|b` 是最常见的那种）', () => {
    const rows = [rowOf({ summary: 'grep -rn "foo\\|bar" src/', action: 'Bash' })]
    const text = buildLogDigest(scopeOf({ rows }), summaryOf())
    const line = text.split('\n').find((l) => l.startsWith('| r1'))!
    // 反斜杠先被翻倍，竖线才被转义：`foo\|bar` → `foo\\\|bar`，那一行仍是 9 列而不是被切开
    expect(cellsOf(line)).toHaveLength(9)
    expect(line).toContain('foo\\\\\\|bar')
  })

  it('裸 \\r（不带 \\n）也不会劈开表格，且 action 同样被清洗', () => {
    const rows = [rowOf({ summary: 'a\rb', action: 'Agent\rx' })]
    const text = buildLogDigest(scopeOf({ rows }), summaryOf())
    const line = text.split('\n').find((l) => l.startsWith('| r1'))!
    expect(line).not.toContain('\r')
    expect(cellsOf(line)).toHaveLength(9)
    expect(cellsOf(line)[3]).toBe('Agent x')
  })

  it('没有模型那半的行：两个 token 格留空，不是 0', () => {
    const text = buildLogDigest(scopeOf({ rows: [rowOf({ tokens: null })] }), summaryOf())
    const cells = cellsOf(text.split('\n').find((l) => l.startsWith('| r1'))!)
    expect(cells[6]).toBe('')
    expect(cells[7]).toBe('')
  })

  it('一条记录都没有时如实说没有，不编一张空表', () => {
    const text = buildLogDigest(
      scopeOf({ rows: [], total: 0 }),
      { wallMs: 0, waitUserMs: 0, localToolMs: 0, directMs: 0, delegatedMs: 0, workflowMs: 0, computeMs: 0 },
    )
    expect(text).toContain('(筛选后没有记录)')
    expect(text).toContain('(筛选后没有记录：当前筛选条件一条都不匹配)')
    expect(text).not.toContain('| 记录ID |')
    // 整会话总耗时为 0 也不能出 NaN 或除零
    expect(text).not.toContain('NaN')
    expect(text).toContain('总耗时 0s')
    expect(text).toContain('等用户 0s (0%)')
  })

  it('超过上限时按耗时降序截断，并在表头写明被截掉多少条', () => {
    const rows: LogRow[] = Array.from({ length: MAX_DIGEST_ROWS + 5 }, (_, i) => rowOf({ id: `r${i}`, durationMs: i }))
    const text = buildLogDigest(scopeOf({ rows, total: MAX_DIGEST_ROWS + 5 }), summaryOf())
    expect(text).toContain(`## 记录表（共 ${MAX_DIGEST_ROWS + 5} 条，按耗时降序取前 ${MAX_DIGEST_ROWS} 条；其余 5 条未列出）`)
    const body = text.split('\n').filter((l) => l.startsWith('| r'))
    expect(body).toHaveLength(MAX_DIGEST_ROWS)
    // 最慢的几条排在前面，最慢的 r0..r4 被截掉
    expect(body[0].startsWith(`| r${MAX_DIGEST_ROWS + 4} `)).toBe(true)
    expect(text).not.toContain('| r4 |')
    // 头部不能再宣称「排列 时序」而不说截断 —— 表体已经按耗时重排，同一份文档里两句话会打架
    expect(text).toContain('- 排列：时序（未重排）；**超出行数上限**，记录表按耗时降序取最慢的')
  })

  it('正好等于上限时不截断（边界不算超）', () => {
    const rows: LogRow[] = Array.from({ length: MAX_DIGEST_ROWS }, (_, i) => rowOf({ id: `r${i}`, durationMs: i }))
    const text = buildLogDigest(scopeOf({ rows, total: MAX_DIGEST_ROWS }), summaryOf())
    expect(text).toContain(`## 记录表（共 ${MAX_DIGEST_ROWS} 条，全部列出）`)
    expect(text).toContain('- 排列：时序（未重排）')
    expect(text).not.toContain('超出行数上限')
  })

  it('与树视图 digest 打同一个「本地工具」：并行会话下两份报告不会各说一套', () => {
    // workflow 真跑了 90s（[1s,91s]），横跨主线上 20s~30s 那段 Bash —— 并集 90s，相加 100s
    const s = parseLines(wfLines, 'm')
    const wf = s.turns.flatMap((t) => t.toolCalls).find((c) => c.name === 'Workflow')!
    wf.workflowRun = {
      runId: 'wf_1',
      workflowName: 'parallel-review',
      summary: '',
      status: 'completed',
      startTs: Date.parse('2026-04-24T12:00:01.000Z'),
      durationMs: 90_000,
      agentCount: 3,
      totalTokens: null,
      totalToolCalls: null,
      phases: [],
      resultText: '',
      resultTruncated: false,
      logs: [],
    }
    const b = breakdownOf(s)
    // 前提：这个 fixture 确实重叠（否则这条用例什么都没钉住）
    expect(b.localToolMs).toBe(90_000)
    expect(b.directMs + b.delegatedMs + b.workflowMs).toBeGreaterThan(b.localToolMs)

    const logLine = breakdownLines(logSummary(s)).find((l) => l.startsWith('- 本地工具'))!
    const treeLine = buildDigest(s).split('\n').find((l) => l.startsWith('- 本地工具'))!
    expect(logLine).toBe(treeLine)
    expect(logLine).toContain('本地工具 1m30s (75%)')
    // 代数不破：等用户 + 本地工具 + 模型思考 = 总耗时
    expect(b.waitUserMs + b.localToolMs + b.computeMs).toBe(b.wallMs)
  })

  it('接真实解析结果：行数与筛出来的那批一致', () => {
    const s = parseLines(
      [
        '{"type":"user","uuid":"u1","timestamp":"2026-04-24T12:00:00.000Z","sessionId":"m","message":{"role":"user","content":"go"}}',
        '{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-04-24T12:00:01.000Z","sessionId":"m","message":{"model":"x","role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"npm test"}}],"usage":{}}}',
        '{"type":"user","uuid":"u2","parentUuid":"a1","timestamp":"2026-04-24T12:00:04.000Z","sessionId":"m","toolUseResult":{"stdout":"pass","stderr":"","interrupted":false},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"pass"}]}}',
      ],
      'm',
    )
    const rows = buildLogRows(s)
    const text = buildLogDigest(
      { rows, total: rows.length, filterLabel: '未筛选（全部记录）', sortLabel: '', spanLabel: '01-02 10:02 ~ 01-02 10:05' },
      logSummary(s),
    )
    expect(rows).toHaveLength(2) // 开场问答 + Bash
    expect(text).toContain('| a1 |')
    expect(text).toContain('| t1 |')
    expect(text).toContain('npm test')
  })
})
