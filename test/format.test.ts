import { describe, it, expect } from 'vitest'
import { timeBucketLabel, fmtRelative } from '../core/view/format'

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
