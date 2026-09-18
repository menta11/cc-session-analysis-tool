import { describe, it, expect } from 'vitest'
import {
  durationScale,
  fmtClock,
  fmtDuration,
  fmtMs,
  fmtPct1,
  fmtTokens,
  sessionDisplayTitle,
  sessionRowLabel,
  shortModel,
  timeBucketLabel,
  fmtRelative,
} from '../core/view/format'

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

describe('sessionRowLabel (列表行：有名称用名称，没有则降级成完整 sessionId)', () => {
  const ID = '2872a403-212a-451b-9cc0-cd4007f39ee6'
  const base = { sessionId: ID, userPrompt: null, aiTitle: null, customTitle: null }

  it('有名称时用名称，且标记为非降级', () => {
    expect(sessionRowLabel({ ...base, customTitle: '用户改名' })).toEqual({
      text: '用户改名',
      isSessionId: false,
    })
    expect(sessionRowLabel({ ...base, aiTitle: 'AI摘要' }).text).toBe('AI摘要')
    expect(sessionRowLabel({ ...base, userPrompt: '首条提问' }).text).toBe('首条提问')
  })

  it('无名称时降级成完整 sessionId（不截断、不留空）', () => {
    expect(sessionRowLabel(base)).toEqual({ text: ID, isSessionId: true })
  })

  it('降级判定与文案同源：text 等于 sessionId 的那次，isSessionId 必为真', () => {
    // 反例探针：把「降级」写成对文案的二次猜测（如 text === sessionId）会在
    // customTitle 恰好等于 sessionId 时判错。这里钉住「由一次判定同时产出两者」。
    expect(sessionRowLabel({ ...base, customTitle: ID })).toEqual({ text: ID, isSessionId: false })
  })
})

describe('日志视图用的格式化', () => {
  it('单条记录耗时：亚秒给 ms、十秒内两位小数、一分钟内一位小数、更长走 fmtMs', () => {
    expect(fmtDuration(0)).toBe('0ms')
    expect(fmtDuration(88)).toBe('88ms')
    expect(fmtDuration(999)).toBe('999ms')
    expect(fmtDuration(1000)).toBe('1.00s')
    expect(fmtDuration(1420)).toBe('1.42s')
    expect(fmtDuration(9999)).toBe('10.0s')
    expect(fmtDuration(12_400)).toBe('12.4s')
    expect(fmtDuration(59_900)).toBe('59.9s')
    expect(fmtDuration(60_000)).toBe(fmtMs(60_000))
    expect(fmtDuration(411_000)).toBe('6m51s')
  })

  it('量级分档的边界与印出来的单位一致（颜色档位读的就是它）', () => {
    expect(durationScale(0)).toBe('ms')
    expect(durationScale(999)).toBe('ms')
    expect(durationScale(1000)).toBe('s')
    expect(durationScale(59_999)).toBe('s')
    expect(durationScale(60_000)).toBe('m')
    expect(durationScale(4_950_000)).toBe('m')
  })

  it('每一档印出来的写法都落在自己的单位上（颜色不可能与数字矛盾）', () => {
    const samples = [0, 1, 88, 999, 1000, 1420, 9999, 12_400, 59_000, 59_999, 60_000, 411_000, 4_950_000]
    for (const ms of samples) {
      const text = fmtDuration(ms)
      // 从文本回推单位：ms 结尾是毫秒；含 h/m 是分钟级往上；否则是秒
      const printed = text.endsWith('ms') ? 'ms' : /[hm]/.test(text) ? 'm' : 's'
      expect({ ms, printed, scale: durationScale(ms) }).toEqual({ ms, printed, scale: printed })
    }
  })

  it('token 数：千进 k、百万进 M', () => {
    expect(fmtTokens(0)).toBe('0')
    expect(fmtTokens(340)).toBe('340')
    expect(fmtTokens(1200)).toBe('1.2k')
    expect(fmtTokens(12_100)).toBe('12.1k')
    expect(fmtTokens(1_400_000)).toBe('1.4M')
  })

  it('占比：一位小数，分母为 0 时给 0.0%（不产生 NaN）', () => {
    expect(fmtPct1(1000, 205_000)).toBe('0.5%')
    expect(fmtPct1(17_100, 205_000)).toBe('8.3%')
    expect(fmtPct1(1, 0)).toBe('0.0%')
  })

  it('模型名去掉日期后缀（列宽只有 128px）', () => {
    expect(shortModel('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5')
    expect(shortModel('claude-opus-4')).toBe('claude-opus-4')
    expect(shortModel('<synthetic>')).toBe('<synthetic>')
    expect(shortModel(null)).toBe('')
  })

  it('时刻：HH:MM:SS.mmm，且按本地时区推进（不含时区假设）', () => {
    const t = new Date(2026, 3, 24, 12, 0, 1, 120).getTime()
    expect(fmtClock(t)).toBe('12:00:01.120')
    // 跨一小时 → 小时位 +1（按 Date 自身推进，避免把测试绑死在某个时区）
    expect(fmtClock(t + 3_600_000)).toBe('13:00:01.120')
  })
})
