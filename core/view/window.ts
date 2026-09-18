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

/**
 * 拖动窗口的某一端：只动被拖的那一端，另一端**锚定不动**。
 *
 * 为什么不能整体 clamp：整窗 clamp 会在拖左端撞到范围时把右端也一起往里推，
 * 而用户只抓着一个手柄 —— 另一端跟着动会让人以为拖错了对象。
 *
 * `minMs` 是**两个手柄之间的几何下限**（不能叠在一起），调用方按自己的场景给：
 * 统计视图给「窗口小到比例没意义」的下限，逐条视图给「1 像素对应的时长」。
 */
export function dragWindowEdge(
  w: ViewWindow,
  which: 'start' | 'end',
  ts: number,
  bounds: ViewWindow,
  minMs: number,
): ViewWindow {
  const min = Math.max(1, minMs)
  if (which === 'start') {
    const start = Math.min(ts, w.end - min)
    return { start: Math.max(bounds.start, start), end: w.end }
  }
  const end = Math.max(ts, w.start + min)
  return { start: w.start, end: Math.min(bounds.end, end) }
}

/**
 * 以某个时刻为中心的一段窗口（双击选段用），夹到 `bounds` 里。
 *
 * 贴着两头时**只收不缩**（各自夹自己的那一端）：宁可窄一点，也不要把中心那个时刻挤出窗口 ——
 * 双击的落点是用户指着的东西，它必须留在结果里。窗口比 `bounds` 还宽时结果就是 `bounds`。
 * 退化（宽 ≤ 0 或没有交集）返回 null，由调用方决定怎么办。
 */
export function windowAround(ts: number, width: number, bounds: ViewWindow): ViewWindow | null {
  if (!(width > 0) || bounds.end <= bounds.start) return null
  const half = width / 2
  const start = Math.max(bounds.start, ts - half)
  const end = Math.min(bounds.end, ts + half)
  return end > start ? { start, end } : null
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