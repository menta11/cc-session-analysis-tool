import { describe, expect, it } from 'vitest'
import { WORKFLOW_STATUS_COMPLETED, parseWorkflowRun, workflowRunPath } from '../core/parser/workflowRun'
import { extractStructuredResult } from '../core/parser/toolResult'

/** run 记录的最小真实形状（字段名照抄本机 cc 写出来的那份） */
const run = (patch: Record<string, unknown> = {}): string =>
  JSON.stringify({
    runId: 'wf_f5f91388-276',
    workflowName: 'parallel-review',
    summary: '多专家并行评审',
    status: 'completed',
    startTime: 1_789_443_876_061,
    durationMs: 263_398,
    agentCount: 3,
    totalTokens: 12_345,
    totalToolCalls: 42,
    phases: [{ title: 'Review', detail: 'N 专家并行评审' }],
    logs: ['Review: status=failed score=79.5/90', '提示: 第 1 位回报的专家名与配置不一致'],
    result: { status: 'failed', passed: false, score: 79.5 },
    ...patch,
  })

describe('parseWorkflowRun', () => {
  it('解出耗时/状态/体量/阶段/日志/结果', () => {
    const r = parseWorkflowRun('wf_f5f91388-276', run())
    expect(r).not.toBeNull()
    expect(r?.workflowName).toBe('parallel-review')
    expect(r?.summary).toBe('多专家并行评审')
    expect(r?.status).toBe('completed')
    expect(r?.startTs).toBe(1_789_443_876_061)
    expect(r?.durationMs).toBe(263_398)
    expect(r?.agentCount).toBe(3)
    expect(r?.totalTokens).toBe(12_345)
    expect(r?.totalToolCalls).toBe(42)
    expect(r?.phases).toEqual(['Review'])
    expect(r?.logs).toHaveLength(2)
    expect(r?.resultText).toContain('"score": 79.5')
    expect(r?.resultTruncated).toBe(false)
  })

  it('runId 用调用方给的那个（文件名比文件里的字段可信）', () => {
    expect(parseWorkflowRun('wf_from_name', run({ runId: 'wf_stale' }))?.runId).toBe('wf_from_name')
  })

  it('字段缺失给 0/null，不猜也不抛（脚本版本之间会加字段）', () => {
    const r = parseWorkflowRun('wf_x', JSON.stringify({ runId: 'wf_x' }))
    expect(r).toEqual({
      runId: 'wf_x',
      workflowName: '',
      summary: '',
      status: '',
      startTs: null,
      durationMs: 0,
      agentCount: 0,
      totalTokens: null,
      totalToolCalls: null,
      phases: [],
      resultText: '',
      resultTruncated: false,
      logs: [],
    })
  })

  it('坏 JSON / 不是对象 → null（调用方按「没有 run 记录」处理）', () => {
    expect(parseWorkflowRun('wf_x', '{ not json')).toBeNull()
    expect(parseWorkflowRun('wf_x', '[1,2]')).toBeNull()
    expect(parseWorkflowRun('wf_x', '')).toBeNull()
  })

  it('result 是字符串时原样用（不再套一层引号），超长截断并标出来', () => {
    expect(parseWorkflowRun('wf_x', run({ result: '一句话结论' }))?.resultText).toBe('一句话结论')
    const big = parseWorkflowRun('wf_x', run({ result: 'x'.repeat(9_000) }))
    expect(big?.resultTruncated).toBe(true)
    expect(big?.resultText).toContain('已截断')
    // 截断后仍然带着「原始多长」这个信息，否则读的人不知道丢了多少
    expect(big?.resultText).toContain('9000')
  })

  it('非法值不写进结果（NaN/负数时长按 0 处理，数组里混的非字符串丢掉）', () => {
    const r = parseWorkflowRun('wf_x', run({ durationMs: 'soon', logs: ['ok', 42, null], phases: [{ detail: 'x' }, { title: 'P' }] }))
    expect(r?.durationMs).toBe(0)
    expect(r?.logs).toEqual(['ok'])
    expect(r?.phases).toEqual(['P'])
  })
})

describe('workflowRunPath', () => {
  it('run 记录在 <会话目录>/workflows/<runId>.json', () => {
    expect(workflowRunPath('/p/sess', 'wf_1')).toBe('/p/sess/workflows/wf_1.json')
  })
})

describe('extractStructuredResult 的 Workflow 分支', () => {
  it('从发起回执里取出 runId（没有它就没有后面的一切）', () => {
    const sr = extractStructuredResult('Workflow', {
      status: 'async_launched',
      taskId: 'wmhixvg1p',
      taskType: 'local_workflow',
      workflowName: 'parallel-review',
      runId: 'wf_f5f91388-276',
      scriptPath: 'D:\\wf\\parallel-review.js',
    })
    expect(sr).toEqual({
      toolName: 'Workflow',
      runId: 'wf_f5f91388-276',
      taskId: 'wmhixvg1p',
      workflowName: 'parallel-review',
      scriptPath: 'D:\\wf\\parallel-review.js',
      status: 'async_launched',
    })
    expect(WORKFLOW_STATUS_COMPLETED).toBe('completed')
  })

  it('发起就失败的那种回执（没有 runId）→ 字段为 null，不是崩', () => {
    const sr = extractStructuredResult('Workflow', 'Error: scriptPath must be a script path')
    expect(sr).toBeNull() // 非对象一律 null，与其它工具同一条口径
  })
})
