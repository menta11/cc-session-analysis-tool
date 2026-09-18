import { existsSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { parseJsonl } from '../core/parser/parse'
import { breakdownOf } from '../core/model/timeBreakdown'

// ── 模板（不会被 vitest 收录；仅作范例）──────────────────────────────────
// 用法：复制本文件为 real-sample-breakdown.smoke.test.ts（去掉 .template），把下面 MAIN
// 换成你本机的真实会话 transcript 路径：
//   ~/.claude/projects/<project>/<sessionId>.jsonl
// 样本不存在时自动跳过。
// ──────────────────────────────────────────────────────────────────────

const MAIN = '<your-local-sample>.jsonl'

const fmt = (ms: number): string => {
  const s = ms / 1000
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  return h > 0 ? `${h}h${m}m${sec}s` : m > 0 ? `${m}m${sec}s` : `${sec}s`
}

describe.skipIf(!existsSync(MAIN))('real sample — main-session breakdown (对齐后模型)', () => {
  it('wall = 等用户 + 本地工具 + compute（含轮间间隙）', () => {
    const b = breakdownOf(parseJsonl(MAIN))
    console.log({
      wall: fmt(b.wallMs),
      waitUser: fmt(b.waitUserMs),
      localTool: fmt(b.localToolMs),
      direct: fmt(b.directMs),
      delegated: fmt(b.delegatedMs),
      compute: fmt(b.computeMs),
    })

    // 等用户 ≥ 0
    expect(b.waitUserMs).toBeGreaterThanOrEqual(0)
    // 直接工具 ≥ 0
    expect(b.directMs).toBeGreaterThanOrEqual(0)
    // Agent 委派合并后 ≤ sum（并行不膨胀）
    expect(b.delegatedMs).toBeGreaterThanOrEqual(0)
    // compute 派生 ≥ 0
    expect(b.computeMs).toBeGreaterThanOrEqual(0)
    // 对账：等用户 + 本地工具 + compute ≈ 总耗时（允许 clamp 微差）
    const sum = b.waitUserMs + b.localToolMs + b.computeMs
    expect(Math.abs(sum - b.wallMs)).toBeLessThanOrEqual(2000)
  })
})
