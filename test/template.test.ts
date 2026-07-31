import { describe, it, expect } from 'vitest'
import { getSystemPrompt } from '../core/ai/template'

describe('template (agent-run.md)', () => {
  it('加载非空', () => {
    expect(getSystemPrompt().length).toBeGreaterThan(500)
  })

  it('体积 < 2KB（--append-system-prompt 的 argv 限制）', () => {
    expect(getSystemPrompt().length).toBeLessThan(2048)
  })

  it('含角色 / 输出格式 / 质量硬约束', () => {
    const t = getSystemPrompt()
    expect(t).toContain('角色')
    expect(t).toContain('输出格式')
    expect(t).toContain('质量硬约束')
  })

  it('关键事件按阶段 + 分桶求和约束', () => {
    const t = getSystemPrompt()
    expect(t).toContain('阶段')
    expect(t).toContain('分桶求和')
  })

  it('常见模式仅供参考、勿强行归类（开放式诊断）', () => {
    const t = getSystemPrompt()
    expect(t).toContain('仅供参考')
    expect(t).toContain('勿强行归类')
  })
})
