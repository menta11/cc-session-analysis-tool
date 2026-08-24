import { existsSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { parseJsonl } from '../core/parser/parse'
import { buildAgentIndex } from '../core/discovery/agentIndex'
import { linkSubagents } from '../core/discovery/linkSubagents'
import { buildDigest, buildDiagnosticFacts, buildFileMap } from '../core/ai/prompt'
import { buildAnalyzeRequest } from '../core/ai/analyzeRequest'
import { buildStdin } from '../electron/main/claudeCli'
import type { Session, ToolCall } from '../core/parser/types'

// ─────────────────────────────────────────────────────────────────────────────
// 真实样本烟雾测试 · 模板（路径留空，供下载者自行补充）
// ─────────────────────────────────────────────────────────────────────────────
// 用法：
//   1. 复制本文件为  test/real-sample-digest.smoke.test.ts  （把 .template 换成 test）
//   2. 把下面两个常量换成你本机的真实路径：
//        PROJECTS_ROOT = ~/.claude/projects/<sanitized-cwd>          （目录）
//        BASE          = ~/.claude/projects/<sanitized-cwd>/<sessionId>（不含扩展名）
//      同目录下应有 <sessionId>.jsonl 与 subagents/ 子目录。
//   3. 跑：  npx vitest run test/real-sample-digest.smoke.test.ts
//
// 说明：
//   - 复制出的 *.smoke.test.ts 已被 .gitignore 拦下，不会进版本库，可放心写死本机值。
//   - 样本不存在时整组用 describe.skipIf 自动跳过，CI / 他人机器不报错。
//   - 本模板文件 (.template.ts) 既不被 vitest 收集，也不进 typecheck，纯参考用。
// ─────────────────────────────────────────────────────────────────────────────

// 👇 必填：换成你本机的路径
const PROJECTS_ROOT = 'C:/Users/your-name/.claude/projects/your-sanitized-cwd'
const BASE = 'C:/Users/your-name/.claude/projects/your-sanitized-cwd/your-session-id'
const MAIN = BASE + '.jsonl'

describe.skipIf(!existsSync(MAIN))('real sample — buildDigest smoke', () => {
  const index = buildAgentIndex(BASE)
  const main = parseJsonl(MAIN)
  const { session } = linkSubagents(main, index, (p) => parseJsonl(p, { subagent: true }))

  it('整会话 digest 不崩、含各段、体积有界', () => {
    const d = buildDigest(session)
    expect(d).toContain('总耗时')
    expect(d).toContain('## 时序分桶')
    expect(d).toContain('## 诊断事实')
    expect(d).toContain('## 子agent 全量表')
    expect(d).toContain('## 并行度')
    expect(d.length).toBeGreaterThan(2000)
    expect(d.length).toBeLessThan(100_000)
  })

  it('子 agent 全量表 > 30 触发截断 + 聚合', () => {
    const d = buildDigest(session)
    // 仅当直接子 agent > 30 时才出现截断聚合段；否则跳过该断言
    const agentCount = session.turns.flatMap((t) => t.toolCalls).filter((tc) => tc.childSession).length
    if (agentCount > 30) {
      expect(d).toContain('其余')
      expect(d).toContain('按类型聚合')
    }
  })

  it('诊断事实段含显著慢调用/重复/未配对/体量', () => {
    const f = buildDiagnosticFacts(session)
    expect(f).toContain('显著慢调用')
    expect(f).toContain('重复模式')
    expect(f).toContain('未配对 tool_use')
    expect(f).toContain('体量')
  })

  it('节点诊断：对某直接子 agent 喂 parentAgentCall，含父子对账', () => {
    const agent = session.turns
      .flatMap((t) => t.toolCalls)
      .find((tc) => tc.childSession != null) as ToolCall | undefined
    expect(agent).toBeDefined()
    const child = agent!.childSession as Session
    const dChild = buildDigest(child, { parentAgentCall: agent })
    expect(dChild).toContain('父子对账')
    expect(dChild).toContain('isSubagent=true')
    // 子 agent 单 prompt → 等用户恒 0、无轮间间隙段
    expect(dChild).toContain('等用户 0s')
    expect(dChild).not.toContain('## 轮间间隙')
  })
})

describe.skipIf(!existsSync(MAIN))('real sample — buildFileMap smoke', () => {
  const index = buildAgentIndex(BASE)
  const main = parseJsonl(MAIN)
  const { session } = linkSubagents(main, index, (p) => parseJsonl(p, { subagent: true }))

  it('文件地图不崩、含主文件/子agent文件/深挖线索', () => {
    const m = buildFileMap(session, {
      projectsRoot: PROJECTS_ROOT,
      mainFilePath: MAIN,
      agentIndex: index,
    })
    expect(m).toContain('文件地图')
    expect(m).toContain('## 主文件')
    expect(m).toContain('## 子agent 文件')
    expect(m).toContain('## 深挖线索')
  })
})

describe.skipIf(!existsSync(MAIN))('real sample — buildAnalyzeRequest node smoke', () => {
  const index = buildAgentIndex(BASE)
  const main = parseJsonl(MAIN)
  const { session } = linkSubagents(main, index, (p) => parseJsonl(p, { subagent: true }))

  it('node 模式：聚焦某子 agent，userMessage 含父子对账/占父/isSubagent', () => {
    const agent = session.turns
      .flatMap((t) => t.toolCalls)
      .find((tc) => tc.childSession != null)
    expect(agent).toBeDefined()
    const r = buildAnalyzeRequest(session, {
      kind: 'node',
      projectsRoot: PROJECTS_ROOT,
      mainFilePath: MAIN,
      agentIndex: index,
      focusToolUseId: agent!.toolUseId,
    })
    expect(r.systemPrompt).toContain('角色')
    expect(r.userMessage).toContain('父子对账')
    expect(r.userMessage).toContain('占父总耗时')
    expect(r.userMessage).toContain('isSubagent=true')
  })
})

describe.skipIf(!existsSync(MAIN))('real sample — 端到端组装链路 smoke', () => {
  const index = buildAgentIndex(BASE)
  const main = parseJsonl(MAIN)
  const { session } = linkSubagents(main, index, (p) => parseJsonl(p, { subagent: true }))
  const opts = {
    projectsRoot: PROJECTS_ROOT,
    mainFilePath: MAIN,
    agentIndex: index,
  }

  it('whole：buildAnalyzeRequest → buildStdin 组装出完整提示词', () => {
    const { systemPrompt, userMessage } = buildAnalyzeRequest(session, { kind: 'whole', ...opts })
    expect(systemPrompt).toContain('角色')
    expect(systemPrompt).toContain('质量硬约束')
    expect(userMessage).toContain('# Agent 运行耗时摘要')
    expect(userMessage).toContain('## 时序分桶')
    expect(userMessage).toContain('## 诊断事实')
    expect(userMessage).toContain('# 文件地图')
    const stdin = buildStdin(systemPrompt, userMessage)
    expect(stdin).toContain('角色')
    expect(stdin).toContain('# 待分析数据')
    expect(stdin).toContain('# Agent 运行耗时摘要')
    expect(stdin.indexOf('角色')).toBeLessThan(stdin.indexOf('# Agent 运行耗时摘要'))
    expect(stdin.length).toBeLessThan(60_000)
  })

  it('node：buildStdin 含父子对账 + 占父总耗时', () => {
    const agent = session.turns.flatMap((t) => t.toolCalls).find((tc) => tc.childSession != null)!
    const { systemPrompt, userMessage } = buildAnalyzeRequest(session, {
      kind: 'node',
      ...opts,
      focusToolUseId: agent.toolUseId,
    })
    const stdin = buildStdin(systemPrompt, userMessage)
    expect(stdin).toContain('父子对账')
    expect(stdin).toContain('占父总耗时')
    expect(stdin).toContain('isSubagent=true')
  })
})
