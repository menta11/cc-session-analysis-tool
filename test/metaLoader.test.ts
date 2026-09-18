import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyMetaCache, storeMeta, type MetaCache } from '../core/discovery/metaCache'
import { createMetaLoader, type MetaLoader } from '../core/discovery/metaLoader'
import { readSessionMeta, scanProjects, type SessionRef } from '../core/discovery/scan'
import { installCountingFsBridge, restoreNodeFsBridge, type FsCounters } from './support/fsCounters'

const FIXTURE = fileURLToPath(new URL('./fixtures/scan-projects', import.meta.url))

afterEach(() => restoreNodeFsBridge())

interface Harness {
  loader: MetaLoader
  counters: FsCounters
  loaded: SessionRef[][]
  persisted: MetaCache[]
}

/**
 * 用真实扫描出的骨架 + 真实 readSessionMeta 装配 loader（只把「计数」这层换成探针）。
 *
 * 计数桥**装在扫描之后**：扫描现在自己会读小文件的头（判定空会话，见 scan.ts），那是它的职责，
 * 有专门的用例在 scan.test.ts 里钉；这里要数的只是「loader 读了谁」。
 */
async function harness(opts: { cache?: MetaCache } = {}): Promise<Harness & { skeleton: SessionRef[] }> {
  const skeleton = await scanProjects(FIXTURE)
  const counters = installCountingFsBridge()
  const loaded: SessionRef[][] = []
  const persisted: MetaCache[] = []
  const loader = createMetaLoader({
    read: (path) => readSessionMeta(path),
    onLoaded: (refs) => loaded.push(refs),
    loadCache: async () => opts.cache ?? emptyMetaCache(),
    persistCache: (cache) => persisted.push(cache),
  })
  return { loader, counters, loaded, persisted, skeleton }
}

const names = (paths: string[]): string[] => paths.map((p) => p.split('/').pop() ?? p)

describe('metaLoader：谁被看见才读谁', () => {
  it('只读被请求的行，未被请求的一个都不读', async () => {
    const h = await harness()
    expect(h.counters.readHeads).toEqual([]) // 一行都没被看见之前，loader 不读任何东西

    h.loader.request(h.skeleton[0])
    await h.loader.idle()

    expect(names(h.counters.readHeads)).toEqual([`${h.skeleton[0].sessionId}.jsonl`])
    expect(h.loaded.flat().map((r) => r.path)).toEqual([h.skeleton[0].path])
    expect(h.loaded.flat()[0].cwd).toBeDefined()
  })

  it('重复请求同一行只读一次（滚动中反复进出视口是常态）', async () => {
    const h = await harness()
    h.loader.request(h.skeleton[0])
    h.loader.request(h.skeleton[0])
    h.loader.request(h.skeleton[0])
    await h.loader.idle()
    expect(h.counters.readHeads).toHaveLength(1)
    expect(h.loader.readCount()).toBe(1)
  })

  it('读完后再次请求不再读，但仍要回一声（把结果原地回放给换了列表的消费方）', async () => {
    const h = await harness()
    h.loader.request(h.skeleton[0])
    await h.loader.idle()
    expect(h.loaded.flat()).toHaveLength(1)

    h.loader.request(h.skeleton[0])
    await h.loader.idle()

    expect(h.loader.readCount()).toBe(1) // 不回读
    // 但必须有第二次回应：消费方（列表）可能已经把上一次的结果丢了（重扫/重建），
    // 它再问一次时若没人应答，「等着这批标题」的转圈指示器就永远不会停
    expect(h.loaded.flat()).toHaveLength(2)
    expect(h.loaded.flat()[1].cwd).toBe(h.loaded.flat()[0].cwd)
  })

  it('文件被追加写之后（版本变了）重读，不回放旧结果', async () => {
    const h = await harness()
    h.loader.request(h.skeleton[0])
    await h.loader.idle()
    expect(h.loader.readCount()).toBe(1)

    // 同一条会话被追加写：mtime/size 变了 → 这一版没读过，得再读一次
    const grown = { ...h.skeleton[0], mtimeMs: h.skeleton[0].mtimeMs + 1000, sizeBytes: h.skeleton[0].sizeBytes + 64 }
    h.loader.request(grown)
    await h.loader.idle()
    expect(h.loader.readCount()).toBe(2)
  })

  it('缓存命中：一次文件读都不发生，但结果照样回调', async () => {
    const first = await harness()
    first.loader.request(first.skeleton[0])
    await first.loader.idle()
    const cached = first.persisted[0]
    expect(cached).toBeDefined()

    const warm = await harness({ cache: cached })
    warm.loader.request(warm.skeleton[0])
    await warm.loader.idle()
    expect(warm.counters.readHeads).toEqual([])
    expect(warm.loaded.flat()[0].cwd).toBe(first.loaded.flat()[0].cwd)
  })

  it('每一个 request 都有回应：回应的 path 集合 = 请求的 path 集合', async () => {
    const h = await harness()
    for (const ref of h.skeleton) h.loader.request(ref)
    await h.loader.idle()
    // 每个被请求的行都要有结果，且回调批次加起来等于请求数
    expect(h.loaded.flat()).toHaveLength(h.skeleton.length)
    expect(new Set(h.loaded.flat().map((r) => r.path))).toEqual(new Set(h.skeleton.map((r) => r.path)))
    expect(h.loaded.every((batch) => batch.length > 0)).toBe(true)
  })

  it('读失败：不入缓存、不重复重试，但要回一声（原样的骨架）', async () => {
    const skeleton = await scanProjects(FIXTURE)
    const counters = installCountingFsBridge() // 计数只统计 loader 的读（扫描自己会读小文件头）
    const loaded: SessionRef[][] = []
    const persisted: MetaCache[] = []
    const cache = emptyMetaCache()
    const boom = vi.fn(async () => {
      throw new Error('IPC 炸了')
    })
    const loader = createMetaLoader({
      read: boom,
      onLoaded: (refs) => loaded.push(refs),
      loadCache: async () => cache,
      persistCache: (c) => persisted.push(c),
    })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    loader.request(skeleton[0])
    loader.request(skeleton[0]) // 重复请求不应触发第二次读
    await loader.idle()

    expect(boom).toHaveBeenCalledTimes(1)
    // 失败不当结论：回的是原样的骨架（没有元数据），也不落缓存
    expect(loaded.flat().map((r) => r.path)).toEqual([skeleton[0].path])
    expect(loaded.flat()[0].cwd).toBeUndefined()
    expect(Object.keys(persisted[0]?.entries ?? {})).toEqual([])
    expect(counters.readHeads).toEqual([])

    // 失败之后同一版文件再被请求：不重试，但仍然给个回应（否则等它的人永远在等）
    loader.request(skeleton[0])
    await loader.idle()
    expect(boom).toHaveBeenCalledTimes(1)
    expect(loaded.flat()).toHaveLength(2)
    spy.mockRestore()
  })

  it('setScope 后落盘前清掉已不存在的会话', async () => {
    const cache = emptyMetaCache()
    storeMeta(cache, '/stale/gone.jsonl', 1, 1, { cwd: '/gone' })
    const h = await harness({ cache })
    h.loader.setScope(h.skeleton.map((s) => s.path))
    h.loader.request(h.skeleton[0])
    await h.loader.idle()
    const saved = h.persisted.at(-1)
    expect(saved?.entries['/stale/gone.jsonl']).toBeUndefined()
    expect(Object.keys(saved?.entries ?? {}).length).toBeGreaterThan(0)
  })

  it('不同会话各读各的，读的集合恰好等于请求的集合', async () => {
    const h = await harness()
    const wanted = [h.skeleton[0], h.skeleton[2]]
    for (const ref of wanted) h.loader.request(ref)
    await h.loader.idle()
    expect(new Set(h.counters.readHeads)).toEqual(new Set(wanted.map((r) => r.path)))
  })
})

describe('metaLoader：真实临时目录下的端到端', () => {
  it('滚动到哪读到哪（模拟：先请求前两行，再请求其余）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'metaLoader-'))
    const proj = join(root, '-tmp-demo')
    mkdirSync(proj)
    for (let i = 0; i < 5; i++) {
      writeFileSync(
        join(proj, `s${i}.jsonl`),
        `{"type":"user","cwd":"/tmp/demo","message":{"role":"user","content":"第${i}条"}}`,
        'utf8',
      )
    }
    const skeleton = await scanProjects(root)
    const counters = installCountingFsBridge() // 计数只统计 loader 的读（扫描自己会读小文件头）
    const loaded: SessionRef[][] = []
    const loader = createMetaLoader({ read: (p) => readSessionMeta(p), onLoaded: (r) => loaded.push(r) })

    for (const ref of skeleton.slice(0, 2)) loader.request(ref)
    await loader.idle()
    expect(counters.readHeads).toHaveLength(2)

    for (const ref of skeleton.slice(2)) loader.request(ref)
    await loader.idle()
    expect(counters.readHeads).toHaveLength(5)
    expect(loaded.flat().every((r) => r.cwd === '/tmp/demo')).toBe(true)
  })
})

describe('metaLoader：空会话判定顺路带回', () => {
  it('缓存里已判定的「无记录」直接带到行上，不用再读文件', async () => {
    const first = await harness()
    const target = first.skeleton[0]
    const cache = emptyMetaCache()
    storeMeta(cache, target.path, target.mtimeMs, target.sizeBytes, { cwd: '/x', hasRecords: false })

    const h = await harness({ cache })
    const before = h.counters.readHeads.length
    h.loader.request(h.skeleton[0])
    await h.loader.idle()
    expect(h.counters.readHeads.length).toBe(before) // 命中缓存 → 0 次读
    expect(h.loaded.flat()[0].hasRecords).toBe(false) // 左栏据此隐藏这一行
  })

  it('真读一次也会带上判定结果（写进缓存，下次启动即知）', async () => {
    const h = await harness()
    const target = h.skeleton.find((s) => s.sessionId === 'sess-2')
    expect(target).toBeDefined()
    h.loader.request(target as SessionRef)
    await h.loader.idle()
    const row = h.loaded.flat().find((r) => r.path === (target as SessionRef).path)
    expect(row?.hasRecords).toBe(false)
    // 落盘的缓存里也带着这条结论
    const stored = h.persisted.at(-1)?.entries[(target as SessionRef).path]
    expect(stored?.meta.hasRecords).toBe(false)
  })
})
