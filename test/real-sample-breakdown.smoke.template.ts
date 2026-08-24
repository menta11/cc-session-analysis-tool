import { existsSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { parseJsonl } from '../core/parser/parse'
import { breakdownOf } from '../core/model/timeBreakdown'

// ─────────────────────────────────────────────────────────────────────────────
// 真实样本烟雾测试 · 模板（路径留空，供下载者自行补充）
// ─────────────────────────────────────────────────────────────────────────────
// 用法：
//   1. 复制本文件为  test/real-sample-breakdown.smoke.test.ts  （把 .template 换成 test）
//   2. 把下面 MAIN 换成你本机的一份真实会话 transcript：
//        ~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl
//   3. 跑：  npx vitest run test/real-sample-breakdown.smoke.test.ts
//
// 说明：
//   - 复制出的 *.smoke.test.ts 已被 .gitignore 拦下，不会进版本库，可放心写死本机值。
//   - MAIN 不存在时整组用 describe.skipIf 自动跳过，CI / 他人机器不报错。
//   - 本模板文件 (.template.ts) 既不被 vitest 收集，也不进 typecheck，纯参考用。
// ─────────────────────────────────────────────────────────────────────────────

// 👇 必填：换成你本机的会话路径
const MAIN = 'C:/Users/your-name/.claude/projects/your-sanitized-cwd/your-session-id.jsonl'

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
