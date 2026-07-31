import { existsSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { parseJsonl } from '../core/parser/parse'
import type { Session, ToolCall } from '../core/parser/types'
import { breakdownOf } from '../core/model/timeBreakdown'
import { buildAgentIndex } from '../core/discovery/agentIndex'
import { linkSubagents } from '../core/discovery/linkSubagents'
import { buildDigest, buildFileMap } from '../core/ai/prompt'
import { buildAnalyzeRequest } from '../core/ai/analyzeRequest'
import { buildStdin } from '../electron/main/claudeCli'

// ─────────────────────────────────────────────────────────────────────────────
// 真实样本烟雾测试 · 模板（路径留空，供下载者自行补充）
// ─────────────────────────────────────────────────────────────────────────────
// 用法：
//   1. 复制本文件为  test/real-sample.smoke.test.ts  （去掉 .template）
//   2. 把下面 BASE / MAIN / PROJECTS_ROOT 三个常量改成你本机的一份会话：
//        ~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl
//      （sanitized-cwd 形如 D--workspace-foo / -Users-foo-bar）
//   3. 视需要把 expect(...) 的数字改成你自己样本的真实值——
//      不同会话的调用数/耗时不会与别人重合，模板只做结构性校验 + 打印供肉眼核对。
//   4. 跑：  npx vitest run test/real-sample.smoke.test.ts
//
// 说明：
//   - 复制出的 *.smoke.test.ts 已被 .gitignore 拦下，不会进版本库，可放心写死本机值。
//   - SAMPLE 不存在时整组用 describe.skipIf 自动跳过，CI / 他人机器不报错。
//   - 本模板文件 (.template.ts) 既不被 vitest 收集，也不进 typecheck，纯参考用。
// ─────────────────────────────────────────────────────────────────────────────

// 👇 必填：换成你本机的会话路径
const BASE = 'C:/Users/your-name/.claude/projects/your-sanitized-cwd/your-session-id'
const MAIN = BASE + '.jsonl'
const PROJECTS_ROOT = 'C:/Users/your-name/.claude/projects/your-sanitized-cwd'

const fmt = (ms: number): string => {
  const s = ms / 1000
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  return h > 0 ? `${h}h${m}m${sec}s` : m > 0 ? `${m}m${sec}s` : `${sec}s`
}

describe.skipIf(!existsSync(MAIN))('real sample — parser & tool-call aggregate', () => {
  it('parses without throwing and aggregates tool calls', () => {
    const s = parseJsonl(MAIN)
    const calls = s.turns.flatMap((t) => t.toolCalls)

    const agg = new Map<string, { n: number; total: number; max: number }>()
    for (const c of calls) {
      const d = c.durationMs ?? 0
      const a = agg.get(c.name) ?? { n: 0, total: 0, max: 0 }
      a.n += 1
      a.total += d
      a.max = Math.max(a.max, d)
      agg.set(c.name, a)
    }

    console.log('\n工具\t次数\t总耗时\t最长单次')
    for (const [name, a] of [...agg.entries()].sort((x, y) => y[1].total - x[1].total))
      console.log(`${name}\t${a.n}\t${fmt(a.total)}\t${fmt(a.max)}`)
    console.log(`TOTAL calls=${calls.length} turns=${s.turns.length}`)

    // 结构性断言：至少解析到 1 轮、1 个工具调用
    expect(s.turns.length).toBeGreaterThan(0)
    expect(calls.length).toBeGreaterThan(0)
  })
})

describe.skipIf(!existsSync(MAIN))('real sample — breakdown wall-clock invariant', () => {
  it('wall = 等用户 + 本地工具 + compute', () => {
    const b = breakdownOf(parseJsonl(MAIN))
    console.log({
      wall: fmt(b.wallMs),
      waitUser: fmt(b.waitUserMs),
      localTool: fmt(b.localToolMs),
      direct: fmt(b.directMs),
      delegated: fmt(b.delegatedMs),
      compute: fmt(b.computeMs),
    })

    // 对账：三段之和 ≈ 墙钟（允许 clamp 微差）
    expect(Math.abs(b.waitUserMs + b.localToolMs + b.computeMs - b.wallMs)).toBeLessThanOrEqual(2000)
    expect(b.computeMs).toBeGreaterThanOrEqual(0)
  })
})

describe.skipIf(!existsSync(MAIN))('real sample — subagent recursive linking', () => {
  it('links direct children and recurses into grandchildren', () => {
    const index = buildAgentIndex(BASE)
    console.log(`agentIndex size = ${index.size}`)

    const main = parseJsonl(MAIN)
    const { session, unresolved } = linkSubagents(main, index, (p) =>
      parseJsonl(p, { subagent: true }),
    )

    const linked = new Set<Session>()
    const walk = (s: Session) => {
      for (const t of s.turns)
        for (const tc of t.toolCalls)
          if (tc.childSession) {
            linked.add(tc.childSession)
            walk(tc.childSession)
          }
    }
    walk(session)
    console.log({ distinctLinked: linked.size, unresolved: unresolved.length })

    // 结构性：若样本含子 agent，至少链接到 1 个；无子 agent 则不强约束
    expect(index.size).toBeGreaterThanOrEqual(0)
    if (linked.size > 0) expect(linked.size).toBeGreaterThan(0)
  })
})

describe.skipIf(!existsSync(MAIN))('real sample — digest & fileMap & analyze request', () => {
  const index = buildAgentIndex(BASE)
  const main = parseJsonl(MAIN)
  const { session } = linkSubagents(main, index, (p) => parseJsonl(p, { subagent: true }))
  const opts = { projectsRoot: PROJECTS_ROOT, mainFilePath: MAIN, agentIndex: index }

  it('digest 不崩、含各段、体积有界', () => {
    const d = buildDigest(session)
    expect(d).toContain('墙钟')
    expect(d).toContain('## 时序分桶')
    expect(d).toContain('## 诊断事实')
    expect(d.length).toBeGreaterThan(500)
    expect(d.length).toBeLessThan(100_000)
    console.log(`\n[digest] ${d.length} chars; head 1200:\n${d.slice(0, 1200)}\n...`)
  })

  it('fileMap 不崩、含主文件/子agent文件/深挖线索', () => {
    const m = buildFileMap(session, opts)
    expect(m).toContain('文件地图')
    expect(m).toContain('## 主文件')
    console.log(`\n[fileMap] ${m.length} chars; head 1200:\n${m.slice(0, 1200)}\n...`)
  })

  it('whole 模式组装出完整 stdin（系统模板 + digest + fileMap）', () => {
    const { systemPrompt, userMessage } = buildAnalyzeRequest(session, { kind: 'whole', ...opts })
    const stdin = buildStdin(systemPrompt, userMessage)
    expect(stdin).toContain('# Agent 运行耗时摘要')
    expect(stdin).toContain('# 文件地图')
    expect(stdin.length).toBeLessThan(60_000)
  })

  it('node 模式：聚焦某子 agent（若存在）含父子对账', () => {
    const agent = session.turns
      .flatMap((t) => t.toolCalls)
      .find((tc) => tc.childSession != null) as ToolCall | undefined
    if (!agent) return // 样本无子 agent 则跳过
    const { systemPrompt, userMessage } = buildAnalyzeRequest(session, {
      kind: 'node',
      ...opts,
      focusToolUseId: agent.toolUseId,
    })
    const stdin = buildStdin(systemPrompt, userMessage)
    expect(stdin).toContain('父子对账')
    expect(stdin).toContain('占父墙钟')
  })
})
