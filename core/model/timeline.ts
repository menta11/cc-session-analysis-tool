export interface Interval {
  start: number
  end: number
}

/** 区间裁剪到 [lo, hi]，无交集返回 null。 */
export function clipInterval(iv: Interval, lo: number, hi: number): Interval | null {
  if (iv.end <= iv.start || hi <= lo) return null
  const start = Math.max(iv.start, lo)
  const end = Math.min(iv.end, hi)
  if (end <= start) return null
  return { start, end }
}

/**
 * `a` 减去 `b` 覆盖的部分（最多切出两段）。
 *
 * 与 `unionDuration` 配对使用：要算「a 的覆盖里去掉 b 覆盖的那一段还剩多少」，先把差集算出来
 * 再取并集，不能两个并集相减 —— 相减在 a、b 多次交错时会算错。
 */
export function subtractInterval(a: Interval, b: Interval): Interval[] {
  if (b.end <= a.start || b.start >= a.end) return [a]
  const out: Interval[] = []
  if (a.start < b.start) out.push({ start: a.start, end: b.start })
  if (b.end < a.end) out.push({ start: b.end, end: a.end })
  return out
}

/**
 * 时间线合并：对区间集合取并集，返回总覆盖时长（ms）。
 * 关键作用：并行子 agent 的调度区间重叠时，取并集而非求和，避免"并行虚高"。
 */
export function unionDuration(intervals: Interval[]): number {
  const valid = intervals.filter((iv) => iv.end > iv.start)
  if (valid.length === 0) return 0

  // 按起点排序后线性合并
  const sorted = [...valid].sort((a, b) => a.start - b.start)
  let total = 0
  let curStart = sorted[0].start
  let curEnd = sorted[0].end
  for (let i = 1; i < sorted.length; i++) {
    const { start, end } = sorted[i]
    if (start <= curEnd) {
      // 重叠或相邻 → 扩展当前段
      curEnd = Math.max(curEnd, end)
    } else {
      total += curEnd - curStart
      curStart = start
      curEnd = end
    }
  }
  total += curEnd - curStart
  return total
}
