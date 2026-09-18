import { existsSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { parseJsonl } from '../core/parser/parse'
import type { Session } from '../core/parser/types'
import { buildAgentIndex } from '../core/discovery/agentIndex'
import { linkSubagents } from '../core/discovery/linkSubagents'

// ── 模板（不会被 vitest 收录；仅作范例）──────────────────────────────────
// 用法：复制本文件为 real-sample-subagents.smoke.test.ts（去掉 .template），把下面 BASE
// 换成你本机的真实会话 transcript 路径（不含扩展名）：
//   ~/.claude/projects/<project>/<sessionId>
// 同目录下应有 <sessionId>.jsonl 与 subagents/ 子目录。样本不存在时自动跳过。
// ──────────────────────────────────────────────────────────────────────

const BASE = '<your-local-sample>'
const MAIN = BASE + '.jsonl'

const countDepth = (s: Session, d: number): number => {
  let m = d
  for (const t of s.turns) for (const tc of t.toolCalls) if (tc.childSession) m = Math.max(m, countDepth(tc.childSession, d + 1))
  return m
}

describe.skipIf(!existsSync(MAIN))('real sample — subagent recursive tree', () => {
  it('links direct children and recurses into grandchildren', async () => {
    const index = await buildAgentIndex(BASE)
    expect(index.size).toBeGreaterThan(0)

    const main = parseJsonl(MAIN)
    const { session, unresolved } = await linkSubagents(main, index, (p) => parseJsonl(p, { subagent: true }))

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
