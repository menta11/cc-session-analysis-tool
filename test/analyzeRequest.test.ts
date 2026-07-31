import { describe, it, expect } from 'vitest'
import { parseLines } from '../core/parser/parse'
import { buildAnalyzeRequest } from '../core/ai/analyzeRequest'

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
