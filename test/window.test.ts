import { describe, it, expect } from 'vitest'
import {
  clampWindow,
  dragWindowEdge,
  windowAround,
  zoomWindow,
  snapToSegmentBoundary,
  pxPerMs,
  windowDuration,
} from '../core/view/window'

describe('windowDuration', () => {
  it('returns window span', () => {
    expect(windowDuration({ start: 1000, end: 5000 })).toBe(4000)
  })
})

describe('clampWindow', () => {
  it('clamps out-of-range window to session bounds', () => {
    const w = clampWindow({ start: -100, end: 99999 }, 0, 10000, 100)
    expect(w.start).toBe(0)
    expect(w.end).toBe(10000)
  })

  it('enforces minimum width', () => {
    const w = clampWindow({ start: 5000, end: 5010 }, 0, 10000, 1000)
    expect(w.end - w.start).toBeGreaterThanOrEqual(1000)
  })

  it('keeps valid window unchanged', () => {
    const w = clampWindow({ start: 2000, end: 8000 }, 0, 10000, 100)
    expect(w).toEqual({ start: 2000, end: 8000 })
  })
})

describe('zoomWindow', () => {
  it('factor>1 narrows window around pivot', () => {
    const w = zoomWindow({ start: 0, end: 10000 }, 4000, 1.2, 0, 10000, 100)
    // 窗口变窄 1/1.2，pivot 4000 保持相对位置
    expect(w.end - w.start).toBeLessThan(10000)
    // pivot 在窗口内的相对位置不变
    const before = 4000 / 10000
    const after = (4000 - w.start) / (w.end - w.start)
    expect(after).toBeCloseTo(before)
  })

  it('factor<1 widens window', () => {
    const w = zoomWindow({ start: 2000, end: 8000 }, 4000, 1 / 1.2, 0, 10000, 100)
    expect(w.end - w.start).toBeGreaterThan(6000)
  })

  it('clamps to session bounds', () => {
    const w = zoomWindow({ start: 0, end: 10000 }, 5000, 1.2, 0, 10000, 100)
    expect(w.start).toBeGreaterThanOrEqual(0)
    expect(w.end).toBeLessThanOrEqual(10000)
  })

  it('enforces min width', () => {
    const w = zoomWindow({ start: 0, end: 10000 }, 5000, 100, 0, 10000, 5000)
    expect(w.end - w.start).toBeGreaterThanOrEqual(5000)
  })
})

describe('snapToSegmentBoundary', () => {
  it('snaps to nearest boundary', () => {
    const boundaries = [1000, 3000, 7000]
    expect(snapToSegmentBoundary(1500, boundaries)).toBe(1000)
    expect(snapToSegmentBoundary(2500, boundaries)).toBe(3000)
    expect(snapToSegmentBoundary(5100, boundaries)).toBe(7000)
  })

  it('clamps to first/last boundary', () => {
    const boundaries = [1000, 3000, 7000]
    expect(snapToSegmentBoundary(0, boundaries)).toBe(1000)
    expect(snapToSegmentBoundary(99999, boundaries)).toBe(7000)
  })

  it('returns original when no boundaries', () => {
    expect(snapToSegmentBoundary(1234, [])).toBe(1234)
  })
})

describe('pxPerMs', () => {
  it('computes pixels per millisecond', () => {
    expect(pxPerMs({ start: 0, end: 10000 }, 1000)).toBe(0.1)
  })
})
describe('dragWindowEdge', () => {
  const bounds = { start: 0, end: 1000 }

  it('拖左端只改左端，右端锚定不动', () => {
    expect(dragWindowEdge({ start: 100, end: 800 }, 'start', 300, bounds, 10)).toEqual({ start: 300, end: 800 })
  })

  it('拖右端只改右端', () => {
    expect(dragWindowEdge({ start: 100, end: 800 }, 'end', 500, bounds, 10)).toEqual({ start: 100, end: 500 })
  })

  it('被拖的那一端越过另一端时留出最小宽度（两个手柄不叠在一起）', () => {
    expect(dragWindowEdge({ start: 100, end: 800 }, 'start', 900, bounds, 50)).toEqual({ start: 750, end: 800 })
    expect(dragWindowEdge({ start: 100, end: 800 }, 'end', 0, bounds, 50)).toEqual({ start: 100, end: 150 })
  })

  it('夹在范围内，另一端仍不动', () => {
    expect(dragWindowEdge({ start: 100, end: 800 }, 'start', -50, bounds, 10)).toEqual({ start: 0, end: 800 })
    expect(dragWindowEdge({ start: 100, end: 800 }, 'end', 5000, bounds, 10)).toEqual({ start: 100, end: 1000 })
  })

  it('minMs 给 0 或负数也至少留 1ms：两端不允许重合', () => {
    expect(dragWindowEdge({ start: 100, end: 800 }, 'start', 800, bounds, 0)).toEqual({ start: 799, end: 800 })
    expect(dragWindowEdge({ start: 100, end: 800 }, 'end', 100, bounds, -5)).toEqual({ start: 100, end: 101 })
  })
})

describe('windowAround — 以某点为中心取一段', () => {
  const bounds = { start: 0, end: 10_000 }

  it('中间：左右各一半', () => {
    expect(windowAround(5000, 1000, bounds)).toEqual({ start: 4500, end: 5500 })
  })

  it('贴左端只收不收拢中心：宁可窄，也不把那个时刻挤出窗口', () => {
    expect(windowAround(100, 1000, bounds)).toEqual({ start: 0, end: 600 })
  })

  it('贴右端同理', () => {
    expect(windowAround(9900, 1000, bounds)).toEqual({ start: 9400, end: 10_000 })
  })

  it('窗口比边界还宽 = 整个边界', () => {
    expect(windowAround(5000, 99_999, bounds)).toEqual(bounds)
  })

  it('边界落在范围外：夹进来后仍包含它', () => {
    const w = windowAround(50, 200, bounds)
    expect(w).toEqual({ start: 0, end: 150 })
  })

  it('退化输入返回 null（宽度 ≤ 0 / 边界为空）', () => {
    expect(windowAround(5000, 0, bounds)).toBeNull()
    expect(windowAround(5000, -1, bounds)).toBeNull()
    expect(windowAround(5000, 100, { start: 10, end: 10 })).toBeNull()
  })
})
