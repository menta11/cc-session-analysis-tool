/** 视图窗口 = 甘特图当前显示的时间范围 [start, end]（绝对 ms epoch）。 */
export interface ViewWindow {
  start: number
  end: number
}

/** 窗口时长（ms）。 */
export function windowDuration(w: ViewWindow): number {
  return Math.max(0, w.end - w.start)
}

/** 把窗口 clamp 到会话范围 [lo, hi]，保持窗口宽度（不小于 minMs）。 */
export function clampWindow(w: ViewWindow, lo: number, hi: number, minMs: number): ViewWindow {
  const span = Math.max(minMs, windowDuration(w))
  let start = w.start
  let end = w.end
  if (end - start < span) end = start + span
  if (start < lo) {
    start = lo
    end = Math.min(hi, start + span)
  }
  if (end > hi) {
    end = hi
    start = Math.max(lo, end - span)
  }
  return { start, end }
}

/**
 * ctrl+滚轮缩放：以焦点时间点 pivot 为中心缩放窗口。
 * factor > 1 = 放大（窗口变窄），factor < 1 = 缩小（窗口变宽）。
 * pivot 在窗口内的相对位置保持不变。
 */
export function zoomWindow(
  w: ViewWindow,
  pivot: number,
  factor: number,
  lo: number,
  hi: number,
  minMs: number,
): ViewWindow {
  const span = windowDuration(w)
  if (span <= 0) return clampWindow(w, lo, hi, minMs)
  const ratio = Math.min(w.end, Math.max(w.start, pivot))
  const rel = (ratio - w.start) / span // pivot 在窗口内的相对位置 [0,1]
  const newSpan = Math.max(minMs, span / factor)
  let start = ratio - rel * newSpan
  let end = start + newSpan
  // clamp 到会话边界
  if (start < lo) {
    start = lo
    end = Math.min(hi, start + newSpan)
  }
  if (end > hi) {
    end = hi
    start = Math.max(lo, end - newSpan)
  }
  return { start, end }
}

/** 把时间戳吸附到最近的边界（段边界或 turn 边界），无边界时原样返回。 */
export function snapToSegmentBoundary(ts: number, boundaries: number[]): number {
  if (boundaries.length === 0) return ts
  const sorted = [...boundaries].sort((a, b) => a - b)
  let best = sorted[0]
  let bestDist = Math.abs(ts - sorted[0])
  for (const b of sorted) {
    const d = Math.abs(ts - b)
    if (d < bestDist) {
      best = b
      bestDist = d
    }
  }
  return best
}

/** 像素比：窗口宽度 / 像素宽（px per ms）。 */
export function pxPerMs(w: ViewWindow, pxWidth: number): number {
  const span = windowDuration(w)
  return span > 0 ? pxWidth / span : 0
}