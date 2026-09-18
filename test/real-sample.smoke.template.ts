import { existsSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { parseJsonl } from '../core/parser/parse'

// ── 模板（不会被 vitest 收录；仅作范例）──────────────────────────────────
// 用法：复制本文件为 real-sample.smoke.test.ts（去掉 .template），把下面 SAMPLE
// 换成你本机的真实会话 transcript：
//   ~/.claude/projects/<project>/<sessionId>.jsonl
// 样本不存在时用 skipIf 自动跳过，CI / 他人机器不会报错。
// ──────────────────────────────────────────────────────────────────────

const SAMPLE = '<your-local-sample>.jsonl'

const fmt = (ms: number): string => {
  const s = ms / 1000
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  return h > 0 ? `${h}h${m}m${sec}s` : m > 0 ? `${m}m${sec}s` : `${sec}s`
}

describe.skipIf(!existsSync(SAMPLE))('real sample — cross-check vs prototype', () => {
  it('matches prototype tool-call counts and durations', () => {
    const s = parseJsonl(SAMPLE)
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

    const rows = [...agg.entries()].sort((a, b) => b[1].total - a[1].total)
    console.log('\n工具\t次数\t总耗时\t最长单次')
    for (const [name, a] of rows) console.log(`${name}\t${a.n}\t${fmt(a.total)}\t${fmt(a.max)}`)
    console.log(`TOTAL calls=${calls.length} turns=${s.turns.length}`)

    // 结构性匹配原型（计数必须一致；耗时允许 ±3s 容差应对边界差异）——按你的样本调参
    // expect(calls.length).toBe(<expected-total>)
    // expect(agg.get('Agent')?.n).toBe(<expected-agent-count>)
    // expect(agg.get('Bash')?.n).toBe(<expected-bash-count>)

    // Agent 结构化结果带 agentId（为子 agent 链接铺路）
    const agentWithId = calls.filter((c) => {
      const sr = c.structuredResult
      return sr !== null && sr.toolName === 'Agent' && sr.agentId !== null
    })
    expect(agentWithId.length).toBeGreaterThan(0)
  })
})
