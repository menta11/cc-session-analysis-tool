import { describe, it, expect } from 'vitest'
import { parseLines } from '../core/parser/parse'
import { buildDigest, buildDiagnosticFacts, type DigestOpts } from '../core/ai/prompt'
import type { ToolCall } from '../core/parser/types'

const lines = [
  '{"type":"user","uuid":"u1","timestamp":"2026-04-24T12:00:00.000Z","sessionId":"m","message":{"role":"user","content":"go"}}',
  '{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-04-24T12:00:01.000Z","sessionId":"m","message":{"model":"x","role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"npm test"}}],"usage":{}}}',
  '{"type":"user","uuid":"u2","parentUuid":"a1","timestamp":"2026-04-24T12:00:04.000Z","sessionId":"m","toolUseResult":{"stdout":"pass","stderr":"","interrupted":false},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"pass"}]}}',
  '{"type":"assistant","uuid":"a2","parentUuid":"u2","timestamp":"2026-04-24T12:00:04.000Z","sessionId":"m","message":{"model":"x","role":"assistant","content":[{"type":"tool_use","id":"t2","name":"Agent","input":{"description":"重构认证"}}],"usage":{}}}',
  '{"type":"user","uuid":"u3","parentUuid":"a2","timestamp":"2026-04-24T12:00:34.000Z","sessionId":"m","toolUseResult":{"agentId":"c","agentType":"general-purpose","totalDurationMs":30000,"totalTokens":2000,"description":"重构认证"},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t2","content":"done"}]}}',
]

function buildSession(): ReturnType<typeof parseLines> {
  return parseLines(lines, 'm')
}

function findAgentCall(s: ReturnType<typeof parseLines>): ToolCall {
  const all = s.turns.flatMap((t) => t.toolCalls)
  const a = all.find((tc) => tc.name === 'Agent')
  if (!a) throw new Error('fixture missing Agent call')
  return a
}

describe('buildDigest', () => {
  it('含概览/三类分解/时序分桶/诊断事实/子agent全量表', () => {
    const s = buildSession()
    const d = buildDigest(s)
    expect(d).toContain('总耗时')
    expect(d).toContain('等用户')
    expect(d).toContain('本地工具')
    expect(d).toContain('模型思考') // 口径改名，不再是 LLM(think+output)
    expect(d).toContain('时序分桶')
    expect(d).toContain('诊断事实')
    expect(d).toContain('子agent 全量表')
  })

  it('保留关键事件内容（Bash 命令 / 子agent 描述）', () => {
    const d = buildDigest(buildSession())
    expect(d).toContain('npm test') // 最慢直接工具
    expect(d).toContain('重构认证') // 子agent 全量表 + 诊断事实
  })

  it('isSubagent 时跳过轮间间隙段', () => {
    const d = buildDigest(buildSession())
    // 主会话 fixture 无间隙，但仍非 subagent → 不应出现"轮间间隙"标题（无 gap）
    // 这里仅断言 subagent 标记存在
    expect(d).toContain('isSubagent=false')
  })

  it('诊断事实中显著慢调用按耗时降序，Agent 在 Bash 前', () => {
    const d = buildDigest(buildSession())
    const agentIdx = d.indexOf('Agent 30s')
    const bashIdx = d.indexOf('Bash 3s')
    expect(agentIdx).toBeGreaterThan(-1)
    expect(bashIdx).toBeGreaterThan(-1)
    expect(agentIdx).toBeLessThan(bashIdx) // Agent 30s 更慢，排在显著慢调用前
  })
})

describe('buildDiagnosticFacts', () => {
  it('含显著慢调用/重复模式/未配对/体量', () => {
    const f = buildDiagnosticFacts(buildSession())
    expect(f).toContain('显著慢调用')
    expect(f).toContain('重复模式')
    expect(f).toContain('未配对 tool_use')
    expect(f).toContain('体量')
    expect(f).not.toContain('父子对账') // 无 parentAgentCall
  })

  it('传入 parentAgentCall 时出现父子对账', () => {
    const s = buildSession()
    const opts: DigestOpts = { parentAgentCall: findAgentCall(s) }
    const f = buildDiagnosticFacts(s, opts)
    expect(f).toContain('父子对账')
    expect(f).toContain('sync') // fixture 的 Agent 非 async
  })

  it('token 取自父侧 structuredResult.totalTokens', () => {
    const s = buildSession()
    const f = buildDiagnosticFacts(s, { parentAgentCall: findAgentCall(s) })
    expect(f).toContain('token 2k') // 2000 → 2k
  })
})
