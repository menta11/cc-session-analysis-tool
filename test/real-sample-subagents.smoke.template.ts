import { existsSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { parseJsonl } from '../core/parser/parse'
import type { Session } from '../core/parser/types'
import { buildAgentIndex } from '../core/discovery/agentIndex'
import { linkSubagents } from '../core/discovery/linkSubagents'

// ─────────────────────────────────────────────────────────────────────────────
// 真实样本烟雾测试 · 模板（路径留空，供下载者自行补充）
// ─────────────────────────────────────────────────────────────────────────────
// 用法：
//   1. 复制本文件为  test/real-sample-subagents.smoke.test.ts  （把 .template 换成 test）
//   2. 把下面 BASE 换成你本机的一份真实会话（不含扩展名）：
//        ~/.claude/projects/<sanitized-cwd>/<sessionId>
//      同目录下应有 <sessionId>.jsonl 与 subagents/ 子目录。
//   3. 跑：  npx vitest run test/real-sample-subagents.smoke.test.ts
//
// 说明：
//   - 复制出的 *.smoke.test.ts 已被 .gitignore 拦下，不会进版本库，可放心写死本机值。
//   - BASE 不存在时整组用 describe.skipIf 自动跳过，CI / 他人机器不报错。
//   - 本模板文件 (.template.ts) 既不被 vitest 收集，也不进 typecheck，纯参考用。
// ─────────────────────────────────────────────────────────────────────────────

// 👇 必填：换成你本机的会话路径（不含扩展名）
const BASE = 'C:/Users/your-name/.claude/projects/your-sanitized-cwd/your-session-id'
const MAIN = BASE + '.jsonl'

const countDepth = (s: Session, d: number): number => {
  let m = d
  for (const t of s.turns) for (const tc of t.toolCalls) if (tc.childSession) m = Math.max(m, countDepth(tc.childSession, d + 1))
  return m
}

describe.skipIf(!existsSync(MAIN))('real sample — subagent recursive tree', () => {
  it('links direct children and recurses into grandchildren', () => {
    const index = buildAgentIndex(BASE)
    expect(index.size).toBeGreaterThan(0)

    const main = parseJsonl(MAIN)
    const { session, unresolved } = linkSubagents(main, index, (p) => parseJsonl(p, { subagent: true }))

    const directLinked = session.turns.flatMap((t) => t.toolCalls).filter((tc) => tc.childSession).length

    const linked = new Set<Session>()
    const walk = (s: Session): void => {
      for (const t of s.turns) for (const tc of t.toolCalls) if (tc.childSession) { linked.add(tc.childSession); walk(tc.childSession) }
    }
    walk(session)

    const depth = countDepth(session, 0)
    console.log({ directLinked, totalDistinctLinked: linked.size, unresolved: unresolved.length, maxDepth: depth })

    expect(directLinked).toBeGreaterThan(0)
    expect(linked.size).toBeGreaterThan(0)
    expect(depth).toBeGreaterThanOrEqual(1) // 至少链接到一层子
  })
})
