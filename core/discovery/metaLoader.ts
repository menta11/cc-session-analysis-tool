import type { SessionRef } from './scan'
import { lookupMeta, pruneMetaCache, storeMeta, type MetaCache, type SessionMeta } from './metaCache'
import { yieldToHost } from '../yield'

/**
 * 会话元数据的**按需**加载器 —— 谁被看见，才读谁。
 *
 * 为什么不再启动时全读（原来那版就是全读，被实测否掉）：本机 1185 个会话合计 1.02 GB，
 * 一次全量补齐要让渲染进程吞下约 1 GB 文本，实测累计主线程阻塞 117.7 秒、单次最长 5.69 秒。
 * 而列表首屏只需要十几行 ——
 * 启动成本应该跟**看得见的行数**成正比，而不是跟会话总数成正比。
 *
 * 四条不变量：
 *   - **幂等**：同一 path 重复请求只读一次（行在滚动中反复进出视口是常态）。
 *   - **命中即不读**：`(path, mtimeMs, sizeBytes)` 命中缓存直接出结果（见 `metaCache.ts`）。
 *   - **失败不落缓存**：读失败（IPC 错、文件被删）既不入缓存也不无限重试，该行保持骨架即可 ——
 *     把失败当结论缓存下来会让标题永久空着。
 *   - **每一次 request 都有且只有一次回应**（成功给带元数据的行，失败给原样的骨架）。
 *     消费方是「谁被看见才请谁」的列表：它请完就等着，没有回应时只能一直等 ——
 *     dev 热更新后左栏永久转圈就是这么来的。
 *
 * 并发刻意保持串行 + 按批让出：读一件小事却把主线程占满，正是要修的病灶。
 */

/** 每读这么多条让出一次事件循环（同 scan 的理由：浏览器定时器有最小间隔夹取） */
const YIELD_EVERY_READS = 8
/** 攒够这么多结果就回调一次（太小=频繁 setState，太大=标题一批批地跳） */
const EMIT_BATCH = 16

/** 文件版本：会话是**追加写**的，同一 path 的 mtime/size 变了就该重读而不是回放旧结果。 */
const versionOf = (ref: SessionRef): string => `${ref.mtimeMs}:${ref.sizeBytes}`

export interface MetaLoader {
  /** 请求某会话的元数据。同步返回，结果经 `onLoaded` 送达。 */
  request(ref: SessionRef): void
  /**
   * 告知本次扫描的**全部**会话路径：只用于清理缓存里已不存在的条目（缓存不随时间无限长）。
   * 不调用就不清理 —— 清理是可选的卫生动作，不是正确性前提。
   */
  setScope(paths: Iterable<string>): void
  /** 等待队列排空（测试与收尾用） */
  idle(): Promise<void>
  /** 已真正发起的文件读取次数（测试与性能探针用） */
  readCount(): number
}

export interface MetaLoaderOptions {
  /** 读一个文件的元数据（宿主注入：Tauri 走 IPC、测试注入假实现） */
  read: (path: string) => Promise<SessionMeta>
  /**
   * 每一次 `request` 的回应都从这里出来（成功 = 带元数据；失败 = 原样的骨架），
   * 每攒够一批（或队列排空）回调一次。消费方按 path 收账 —— 「谁还没回应」就是它自己的待办。
   */
  onLoaded: (refs: SessionRef[]) => void
  /** 读缓存（异步：宿主读盘）。失败应自行降级为空缓存，不得抛出。 */
  loadCache?: () => Promise<MetaCache>
  /** 缓存变脏时回调（宿主自己去抖后落盘）。不传则不启用缓存。 */
  persistCache?: (cache: MetaCache) => void
}

export function createMetaLoader(opts: MetaLoaderOptions): MetaLoader {
  /** path → 已经答过的行（含元数据）与它对应的文件版本：重复请求原地回放，不再读盘 */
  const answered = new Map<string, { version: string; ref: SessionRef }>()
  /** path → 读失败时的文件版本：同一版不重试（不把队列堵住），但仍然给消费方一个回应 */
  const failed = new Map<string, string>()
  /** 已入队或正在读（完成后即删，不随会话数增长） */
  const queued = new Set<string>()
  const queue: SessionRef[] = []
  let batch: SessionRef[] = []
  let cache: MetaCache | null = null
  let scope: string[] | null = null
  let draining: Promise<void> | null = null
  let reads = 0

  const emit = (): void => {
    if (batch.length === 0) return
    const out = batch
    batch = []
    opts.onLoaded(out)
  }

  /** 缓存只在第一次需要时读，且全程复用（每次请求都读盘等于把省下的 IO 又还回去） */
  const ensureCache = async (): Promise<MetaCache | null> => {
    if (!opts.loadCache) return null
    if (cache === null) cache = await opts.loadCache()
    return cache
  }

  const drain = async (): Promise<void> => {
    const store = await ensureCache()
    while (queue.length > 0) {
      const ref = queue.shift() as SessionRef
      const version = versionOf(ref)
      const hit = store ? lookupMeta(store, ref.path, ref.mtimeMs, ref.sizeBytes) : undefined
      let meta: SessionMeta | null = hit ?? null
      if (!meta) {
        try {
          reads++
          meta = await opts.read(ref.path)
        } catch (err) {
          // 失败不当结论：不入缓存、标记为已处理（避免同一 path 反复重试把队列堵住）。
          // 但**必须回一声**：不回的话，等着这条标题的消费方会一直等下去。
          failed.set(ref.path, version)
          queued.delete(ref.path)
          console.error('[metaLoader] 读取会话元数据失败：', ref.path, err)
          batch.push(ref)
          if (batch.length >= EMIT_BATCH) emit()
          continue
        }
        if (store) storeMeta(store, ref.path, ref.mtimeMs, ref.sizeBytes, meta)
      }
      const merged = { ...ref, ...meta }
      answered.set(ref.path, { version, ref: merged })
      queued.delete(ref.path)
      batch.push(merged)
      if (batch.length >= EMIT_BATCH) emit()
      if (reads % YIELD_EVERY_READS === 0) await yieldToHost()
    }
    emit()
    persist()
  }

  /** 落盘前顺手清理失效条目（只在拿到 scope 后做，且只在真的读过/写过之后做） */
  const persist = (): void => {
    if (!cache || !opts.persistCache) return
    if (scope) pruneMetaCache(cache, scope)
    opts.persistCache(cache)
  }

  const start = (): void => {
    if (draining) return
    draining = drain().finally(() => {
      draining = null
      // 排空期间又有新请求进来（滚动继续）→ 再起一轮
      if (queue.length > 0) start()
    })
  }

  return {
    request(ref) {
      const version = versionOf(ref)
      const prior = answered.get(ref.path)
      // 同一版文件已经读过：原地回放。**这条不能少** —— 消费方可能已经把结果丢了
      // （重扫把列表换成骨架、dev 热更新重建了列表），它再问一次时若无人应答，
      // 「等着这批标题」的转圈指示器就永远不会停。
      if (prior !== undefined && prior.version === version) {
        opts.onLoaded([prior.ref])
        return
      }
      if (failed.get(ref.path) === version) {
        // 同一版文件读过一遍且失败：不重试，但同样要回一声（原样的骨架 = 这一行没有元数据可给）
        opts.onLoaded([ref])
        return
      }
      // 正在读的路径不重复入队：那一次回应到达时消费方按 path 收账，不会漏
      if (queued.has(ref.path)) return
      queued.add(ref.path)
      queue.push(ref)
      start()
    },
    setScope(paths) {
      scope = [...paths]
    },
    async idle() {
      while (draining) await draining
    },
    readCount: () => reads,
  }
}
