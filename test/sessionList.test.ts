import { describe, expect, it } from 'vitest'
import type { SessionRef } from '../core/discovery/scan'
import { isBucketOpen, mergeSessionRefs, visibleSessions } from '../core/view/sessionList'

function ref(path: string, mtimeMs: number, extra: Partial<SessionRef> = {}): SessionRef {
  return { project: '-tmp-demo', sessionId: path.split('/').pop() ?? path, path, mtimeMs, sizeBytes: 1, ...extra }
}

describe('mergeSessionRefs', () => {
  it('按 path 覆盖：后到的补齐项顶掉先到的骨架', () => {
    const skeleton = [ref('/p/a.jsonl', 100), ref('/p/b.jsonl', 200)]
    const hydrated = [ref('/p/a.jsonl', 100, { cwd: '/tmp/demo', customTitle: '甲' })]
    const out = mergeSessionRefs(skeleton, hydrated)
    expect(out).toHaveLength(2)
    expect(out.find((s) => s.path === '/p/a.jsonl')?.customTitle).toBe('甲')
    // 未被覆盖的条目原样保留
    expect(out.find((s) => s.path === '/p/b.jsonl')?.cwd).toBeUndefined()
  })

  it('始终按 mtime 倒序，与推送顺序无关', () => {
    const prev = [ref('/p/old.jsonl', 10)]
    const incoming = [ref('/p/new.jsonl', 300), ref('/p/mid.jsonl', 200)]
    expect(mergeSessionRefs(prev, incoming).map((s) => s.path)).toEqual([
      '/p/new.jsonl',
      '/p/mid.jsonl',
      '/p/old.jsonl',
    ])
  })

  it('骨架与补齐混杂的批也能收敛成同一份快照', () => {
    const skeleton = [ref('/p/a.jsonl', 100), ref('/p/b.jsonl', 200)]
    const afterFirstBatch = mergeSessionRefs(skeleton, [ref('/p/b.jsonl', 200, { cwd: '/tmp/demo' })])
    const afterSecond = mergeSessionRefs(afterFirstBatch, [ref('/p/a.jsonl', 100, { cwd: '/tmp/demo' })])
    expect(afterSecond.map((s) => s.path)).toEqual(['/p/b.jsonl', '/p/a.jsonl'])
    expect(afterSecond.every((s) => s.cwd === '/tmp/demo')).toBe(true)
  })

  it('空推送不改动既有列表（首次加载前 prev 为空也不抛）', () => {
    expect(mergeSessionRefs([], [])).toEqual([])
    const prev = [ref('/p/a.jsonl', 100)]
    expect(mergeSessionRefs(prev, [])).toEqual(prev)
  })
})

describe('visibleSessions', () => {
  it('已知「没有记录」的不显示，其余（有记录 / 还没判定）照常显示', () => {
    const refs = [
      ref('/p/empty-a.jsonl', 300, { hasRecords: false }),
      ref('/p/real.jsonl', 200, { hasRecords: true }),
      ref('/p/unknown.jsonl', 100),
    ]
    expect(visibleSessions(refs).map((s) => s.path)).toEqual(['/p/real.jsonl', '/p/unknown.jsonl'])
  })

  it('未判定（undefined）绝不当成「空」——判不出来就照常显示，保持原顺序', () => {
    const refs = [ref('/p/a.jsonl', 2), ref('/p/b.jsonl', 1)]
    expect(visibleSessions(refs)).toEqual(refs)
  })
})

describe('isBucketOpen', () => {
  it('没点过就用调用方给的默认值（视图传「只展开第一组」）', () => {
    expect(isBucketOpen({}, 'first', true)).toBe(true)
    expect(isBucketOpen({}, 'other', false)).toBe(false)
  })

  it('用户点过就按点过的：展开过的默认收起的组要留着展开，收起过的默认展开的组要留着收起', () => {
    expect(isBucketOpen({ other: true }, 'other', false)).toBe(true)
    expect(isBucketOpen({ first: false }, 'first', true)).toBe(false)
  })

  it('分组之间互不影响', () => {
    const open = { '-tmp-a': false, '-tmp-b': true }
    expect(isBucketOpen(open, '-tmp-a', true)).toBe(false)
    expect(isBucketOpen(open, '-tmp-b', false)).toBe(true)
    expect(isBucketOpen(open, '-tmp-c', false)).toBe(false)
  })
})
