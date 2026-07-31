import { describe, it, expect } from 'vitest'
import { classifyTool } from '../core/model/classify'
import { unionDuration } from '../core/model/timeline'

describe('classifyTool', () => {
  it.each([
    ['Bash', 'direct'],
    ['Edit', 'direct'],
    ['Read', 'direct'],
    ['Grep', 'direct'],
    ['Glob', 'direct'],
    ['Write', 'direct'],
    ['WebFetch', 'direct'], // 除 Agent/Task/AskUserQuestion 外都是 direct
    ['Agent', 'delegated'],
    ['Task', 'delegated'], // 旧版工具名
    ['AskUserQuestion', 'wait-user'],
  ])('classifies %s as %s', (name, kind) => {
    expect(classifyTool(name)).toBe(kind)
  })
})

describe('unionDuration', () => {
  it('sums non-overlapping intervals', () => {
    expect(unionDuration([{ start: 0, end: 10 }, { start: 20, end: 30 }])).toBe(20)
  })

  it('merges overlapping intervals without double-counting', () => {
    expect(unionDuration([{ start: 0, end: 100 }, { start: 50, end: 150 }])).toBe(150)
  })

  it('merges fully-overlapping (parallel) intervals to the span', () => {
    expect(unionDuration([{ start: 0, end: 100 }, { start: 0, end: 100 }])).toBe(100)
  })

  it('merges adjacent intervals (touching) into one', () => {
    expect(unionDuration([{ start: 0, end: 50 }, { start: 50, end: 100 }])).toBe(100)
  })

  it('returns 0 for empty input', () => {
    expect(unionDuration([])).toBe(0)
  })

  it('ignores invalid intervals (end <= start)', () => {
    expect(unionDuration([{ start: 10, end: 10 }, { start: 20, end: 5 }, { start: 0, end: 10 }])).toBe(10)
  })
})
