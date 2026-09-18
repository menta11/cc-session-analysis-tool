import { describe, it, expect } from 'vitest'
import { parseLines } from '../core/parser/parse'
import { buildAnalyzeRequest, buildLogAnalyzeRequest } from '../core/ai/analyzeRequest'
import { buildLogRows, logSummary } from '../core/view/logView'

const lines = [
  '{"type":"user","uuid":"u1","timestamp":"2026-04-24T12:00:00.000Z","sessionId":"m","message":{"role":"user","content":"go"}}',
  '{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-04-24T12:00:01.000Z","sessionId":"m","message":{"model":"x","role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"npm test"}}],"usage":{}}}',
  '{"type":"user","uuid":"u2","parentUuid":"a1","timestamp":"2026-04-24T12:00:04.000Z","sessionId":"m","toolUseResult":{"stdout":"pass","stderr":"","interrupted":false},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"pass"}]}}',
  '{"type":"assistant","uuid":"a2","parentUuid":"u2","timestamp":"2026-04-24T12:00:04.000Z","sessionId":"m","message":{"model":"x","role":"assistant","content":[{"type":"tool_use","id":"t2","name":"Agent","input":{"description":"重构认证"}}],"usage":{}}}',
  '{"type":"user","uuid":"u3","parentUuid":"a2","timestamp":"2026-04-24T12:00:34.000Z","sessionId":"m","toolUseResult":{"agentId":"c","agentType":"general-purpose","totalDurationMs":30000,"totalTokens":2000,"description":"重构认证"},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t2","content":"done"}]}}',
]

const session = parseLines(lines, 'm')
const agentIndex = new Map<string, string>([['c', '/fake/root/subagents/agent-c.jsonl']])

describe('buildAnalyzeRequest — whole', () => {
  it('systemPrompt 取自模板、userMessage 含 digest + fileMap', () => {
    const r = buildAnalyzeRequest(session, {
      kind: 'whole',
      projectsRoot: '/fake/root',
      mainFilePath: '/fake/root/main.jsonl',
      agentIndex,
    })
    expect(r.systemPrompt).toContain('角色') // 来自 agent-run.md
    expect(r.userMessage).toContain('# Agent 运行耗时摘要') // digest
    expect(r.userMessage).toContain('# 文件地图') // fileMap
    expect(r.userMessage).toContain('subagents/agent-c.jsonl')
  })
})

describe('buildAnalyzeRequest — window 模式', () => {
  it('window 存在时基于窗口内 turns 构建 digest（只含窗口内轮次）', () => {
    const r = buildAnalyzeRequest(session, {
      kind: 'whole',
      projectsRoot: '/fake/root',
      mainFilePath: '/fake/root/main.jsonl',
      agentIndex,
      window: { start: session.startedAt!, end: session.startedAt! + 5000 },
    })
    const digest = r.userMessage.split('# 文件地图')[0]
    // 窗口只覆盖第一个 turn（t1 Bash，agent t2 在 4s-34s 不在窗口内）
    expect(digest).toContain('轮次 1')
    expect(digest).toContain('总耗时 5s')
  })

  it('无 window 时行为不变（整会话）', () => {
    const r = buildAnalyzeRequest(session, {
      kind: 'whole',
      projectsRoot: '/fake/root',
      mainFilePath: '/fake/root/main.jsonl',
      agentIndex,
    })
    expect(r.userMessage).toContain('subagents/agent-c.jsonl')
  })
})

describe('buildAnalyzeRequest — node 错误路径', () => {
  it('缺少 focusToolUseId 抛错', () => {
    expect(() =>
      buildAnalyzeRequest(session, {
        kind: 'node',
        projectsRoot: '/fake/root',
        mainFilePath: '/fake/root/main.jsonl',
        agentIndex,
      }),
    ).toThrow()
  })

  it('focusToolUseId 不存在抛错', () => {
    expect(() =>
      buildAnalyzeRequest(session, {
        kind: 'node',
        projectsRoot: '/fake/root',
        mainFilePath: '/fake/root/main.jsonl',
        agentIndex,
        focusToolUseId: '不存在的id',
      }),
    ).toThrow()
  })

  it('focusToolUseId 指向非 Agent 调用（t1 Bash，无 childSession）抛错', () => {
    expect(() =>
      buildAnalyzeRequest(session, {
        kind: 'node',
        projectsRoot: '/fake/root',
        mainFilePath: '/fake/root/main.jsonl',
        agentIndex,
        focusToolUseId: 't1',
      }),
    ).toThrow()
  })
})

describe('buildLogAnalyzeRequest — 日志视图筛选后的记录表', () => {
  const rows = buildLogRows(session)
  const opts = {
    session,
    scope: {
      rows,
      total: rows.length,
      filterLabel: '类型=工具',
      sortLabel: '',
      spanLabel: '04-24 12:00 ~ 12:01',
    },
    summary: logSummary(session),
    projectsRoot: '/fake/root',
    mainFilePath: '/fake/root/main.jsonl',
    agentIndex,
  }

  it('systemPrompt 取自 log-run 模板（与树视图那份不是同一个）', () => {
    const r = buildLogAnalyzeRequest(opts)
    expect(r.systemPrompt).toContain('会话记录分析') // 来自 log-run.md
    // 口径段是这份模板独有的：整会话 vs 筛选后两个数不许混着说
    expect(r.systemPrompt).toContain('禁止自行从时间戳重算')
    expect(r.systemPrompt).not.toBe(buildAnalyzeRequest(session, { kind: 'whole', ...opts }).systemPrompt)
  })

  it('userMessage = 记录表 digest + 文件地图（取证线索来自会话，不是记录表）', () => {
    const r = buildLogAnalyzeRequest(opts)
    expect(r.userMessage).toContain('# 会话记录摘要（筛选后的记录表）')
    expect(r.userMessage).toContain('# 文件地图')
    expect(r.userMessage).toContain('subagents/agent-c.jsonl')
    // 记录表里是筛出来的行，不是整个会话的分桶
    expect(r.userMessage).toContain('| t1 |')
    expect(r.userMessage).not.toContain('## 时序分桶')
  })

  it('筛选后一条都没有时不抛错：仍然给出一份说得通的提示词', () => {
    const r = buildLogAnalyzeRequest({
      ...opts,
      scope: { rows: [], total: rows.length, filterLabel: '状态=失败', sortLabel: '', spanLabel: '(无记录)' },
    })
    expect(r.userMessage).toContain('本次分析 0 条')
    expect(r.userMessage).toContain('(筛选后没有记录)')
    // 夹具漏字段会直接印进提示词（`- 时间范围：undefined`），钉住它别再退回去
    expect(r.userMessage).not.toContain('undefined')
  })
})
