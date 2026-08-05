import { describe, it, expect } from 'vitest'
import { clampWindow, zoomWindow, snapToSegmentBoundary, pxPerMs, windowDuration } from '../core/view/window'

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