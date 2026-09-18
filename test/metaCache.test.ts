import { describe, expect, it } from 'vitest'
import {
  META_CACHE_VERSION,
  emptyMetaCache,
  lookupMeta,
  parseMetaCache,
  pruneMetaCache,
  serializeMetaCache,
  storeMeta,
} from '../core/discovery/metaCache'

const META = { cwd: '/tmp/demo', customTitle: '甲', aiTitle: '乙', userPrompt: '提问' }

describe('metaCache', () => {
  it('(path, mtime, size) 三者全同才算命中', () => {
    const cache = emptyMetaCache()
    storeMeta(cache, '/p/a.jsonl', 100, 10, META)
    expect(lookupMeta(cache, '/p/a.jsonl', 100, 10)).toEqual(META)
    expect(lookupMeta(cache, '/p/a.jsonl', 101, 10)).toBeUndefined() // mtime 变
    expect(lookupMeta(cache, '/p/a.jsonl', 100, 11)).toBeUndefined() // size 变
    expect(lookupMeta(cache, '/p/b.jsonl', 100, 10)).toBeUndefined() // 没这条
  })

  it('空元数据也是有效结论（否则没标题的会话每次刷新都要重读）', () => {
    const cache = emptyMetaCache()
    storeMeta(cache, '/p/a.jsonl', 100, 10, {})
    expect(lookupMeta(cache, '/p/a.jsonl', 100, 10)).toEqual({})
  })

  it('序列化 → 解析往返保持命中', () => {
    const cache = emptyMetaCache()
    // 亚毫秒 mtime（stat 给的是浮点）必须原样往返，否则每次刷新都判定失效
    storeMeta(cache, '/p/a.jsonl', 1789208212932.921, 10, META)
    const back = parseMetaCache(serializeMetaCache(cache))
    expect(lookupMeta(back, '/p/a.jsonl', 1789208212932.921, 10)).toEqual(META)
  })

  it('清掉已不在扫描结果里的条目', () => {
    const cache = emptyMetaCache()
    storeMeta(cache, '/p/a.jsonl', 1, 1, META)
    storeMeta(cache, '/p/gone.jsonl', 1, 1, META)
    expect(pruneMetaCache(cache, ['/p/a.jsonl'])).toBe(1)
    expect(lookupMeta(cache, '/p/a.jsonl', 1, 1)).toEqual(META)
    expect(cache.entries['/p/gone.jsonl']).toBeUndefined()
  })

  describe('容错解析（坏输入 → 空缓存，绝不抛出）', () => {
    it('非 JSON / 非对象', () => {
      expect(parseMetaCache('NOT JSON').entries).toEqual({})
      expect(parseMetaCache('[]').entries).toEqual({})
      expect(parseMetaCache('null').entries).toEqual({})
    })

    it('版本不符整体作废', () => {
      expect(parseMetaCache(JSON.stringify({ version: 999, entries: { a: {} } })).entries).toEqual({})
    })

    it('单条形状不对只丢那一条，其余照用', () => {
      const good = { mtimeMs: 1, sizeBytes: 2, meta: META }
      const cache = parseMetaCache(
        JSON.stringify({
          version: 1,
          entries: {
            '/good.jsonl': good,
            '/no-mtime.jsonl': { sizeBytes: 2, meta: META },
            '/nan.jsonl': { mtimeMs: Number.NaN, sizeBytes: 2, meta: META },
            '/bad-meta.jsonl': { mtimeMs: 1, sizeBytes: 2, meta: 'x' },
            '/not-object.jsonl': 7,
          },
        }),
      )
      expect(Object.keys(cache.entries)).toEqual(['/good.jsonl'])
    })
  })
})

describe('hasRecords（空会话判定）在缓存里的往返', () => {
  it('存进去什么样，读出来什么样', () => {
    const cache = emptyMetaCache()
    storeMeta(cache, '/p/empty.jsonl', 1, 2, { hasRecords: false })
    storeMeta(cache, '/p/real.jsonl', 1, 2, { cwd: '/x', hasRecords: true })
    const back = parseMetaCache(serializeMetaCache(cache))
    expect(lookupMeta(back, '/p/empty.jsonl', 1, 2)?.hasRecords).toBe(false)
    expect(lookupMeta(back, '/p/real.jsonl', 1, 2)?.hasRecords).toBe(true)
  })

  it('老缓存（没有这个字段）解析成未知，而不是被当成「空」', () => {
    const legacy = JSON.stringify({
      version: META_CACHE_VERSION,
      entries: { '/p/old.jsonl': { mtimeMs: 1, sizeBytes: 2, meta: { cwd: '/x' } } },
    })
    const cache = parseMetaCache(legacy)
    expect(lookupMeta(cache, '/p/old.jsonl', 1, 2)?.hasRecords).toBeUndefined()
  })
})
