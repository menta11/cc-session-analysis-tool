import { describe, it, expect } from 'vitest'
import { timeBucketLabel, fmtRelative, sessionDisplayTitle } from '../core/view/format'

// 固定 now: 2026-08-14 15:00 本地时间, 避免测试随真实时间漂移
const NOW = new Date(2026, 7, 14, 15, 0, 0).getTime()
const at = (dayOffset: number, hour = 10): number => new Date(2026, 7, 14 + dayOffset, hour).getTime()

describe('timeBucketLabel', () => {
  it('今天: 同自然日内 (含凌晨, 虽已超 24h 滚动窗口)', () => {
    expect(timeBucketLabel(at(0, 0), NOW)).toBe('今天')
    expect(timeBucketLabel(at(0, 14), NOW)).toBe('今天')
  })

  it('昨天: 自然日前一天', () => {
    expect(timeBucketLabel(at(-1, 23), NOW)).toBe('昨天')
  })

  it('本周: 2-6 天前', () => {
    expect(timeBucketLabel(at(-2), NOW)).toBe('本周')
    expect(timeBucketLabel(at(-6), NOW)).toBe('本周')
  })

  it('本月: 同月更早 / 更早: 跨月', () => {
    expect(timeBucketLabel(at(-10), NOW)).toBe('本月')
    expect(timeBucketLabel(new Date(2026, 6, 20).getTime(), NOW)).toBe('更早')
  })

  it('未来时间归入今天', () => {
    expect(timeBucketLabel(at(0, 23), NOW)).toBe('今天')
  })
})

describe('fmtRelative (回归)', () => {
  it('边界值不崩溃', () => {
    expect(fmtRelative(0)).toBe('-')
    expect(fmtRelative(NOW + 1000, NOW)).toBe('刚刚')
  })
})

describe('sessionDisplayTitle (四级降级: customTitle → aiTitle → userPrompt → sessionId)', () => {
  const base = { sessionId: 'abcd1234efgh5678', userPrompt: null, aiTitle: null, customTitle: null }

  it('优先 customTitle（用户显式重命名）', () => {
    expect(sessionDisplayTitle({ ...base, customTitle: '用户改名', aiTitle: 'AI摘要' })).toBe('用户改名')
  })

  it('无 customTitle 时用 aiTitle（AI 自动命名）', () => {
    expect(sessionDisplayTitle({ ...base, aiTitle: 'AI摘要' })).toBe('AI摘要')
  })

  it('无标题时用首条 user prompt，超 40 字截断', () => {
    const long = '这是一条很长很长的用户提问，用来验证四十字截断逻辑是否正常工作，确保它确实超过四十个字符以验证截断'
    expect(long.length).toBeGreaterThan(40)
    expect(sessionDisplayTitle({ ...base, userPrompt: long })).toBe(`${long.slice(0, 40)}…`)
    expect(sessionDisplayTitle({ ...base, userPrompt: '短提问' })).toBe('短提问')
  })

  it('都没有时回退 sessionId 前 12 位', () => {
    expect(sessionDisplayTitle(base)).toBe('abcd1234efgh…')
  })
})
