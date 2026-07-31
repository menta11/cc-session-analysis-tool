export interface Interval {
  start: number
  end: number
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
