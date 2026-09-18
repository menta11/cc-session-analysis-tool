/**
 * 会话元数据缓存 —— 把「每个会话读最多 8MB 头部」的代价从**每次刷新**降到**只在文件变化时**。
 *
 * 为什么需要它：本机 1185 个会话合计 1.02 GB，补齐阶段要把约 1 GB 文本经 IPC 送进渲染进程，
 * 实测主线程阻塞累计 17.3 秒、单次最长 1028 ms。
 * 而这里缓存的东西每个会话只有几百字节（标题 / cwd / 首条提问）。
 *
 * 纯逻辑、无 IO：读盘与写盘由宿主（`src/api/tauri.ts`）负责，本模块只做命中判定与容错解析。
 * 失效键是 **(path, mtimeMs, sizeBytes)** —— 三者任一变化即视为失效重读；这也是不引入 TTL 的原因：
 * 会话文件是追加写，mtime/size 变了就说明内容变了。
 */

/** 从头部提取出的元数据（`readSessionMeta` 的返回形状） */
export interface SessionMeta {
  cwd?: string | null
  customTitle?: string | null
  aiTitle?: string | null
  userPrompt?: string | null
  /**
   * 有没有可分析的记录（见 `scan.ts::hasAssistantRecord`）；`false` 的行不进左栏。
   *
   * 放在缓存里是顺手的收益：判定过一次的会话，之后每次启动都不用再读文件就能隐藏
   * —— 缓存键是 (path, mtimeMs, sizeBytes)，文件一变这条结论就跟着失效重判。
   * 老缓存没有这个字段 → 解析出来是 undefined（未知），只是不隐藏，不会误隐藏。
   */
  hasRecords?: boolean
}

export interface MetaCacheEntry {
  mtimeMs: number
  sizeBytes: number
  meta: SessionMeta
}

export interface MetaCache {
  version: number
  /** 键是会话文件绝对路径 */
  entries: Record<string, MetaCacheEntry>
}

/** 结构变更时 +1：老缓存整体作废（宁可重读一遍，也不要读到形状不符的旧值） */
export const META_CACHE_VERSION = 1

export function emptyMetaCache(): MetaCache {
  return { version: META_CACHE_VERSION, entries: {} }
}

/** 命中则返回元数据，未命中/键不匹配返回 undefined（调用方据此决定是否读文件） */
export function lookupMeta(
  cache: MetaCache,
  path: string,
  mtimeMs: number,
  sizeBytes: number,
): SessionMeta | undefined {
  const hit = cache.entries[path]
  if (!hit) return undefined
  if (hit.mtimeMs !== mtimeMs || hit.sizeBytes !== sizeBytes) return undefined
  return hit.meta
}

export function storeMeta(
  cache: MetaCache,
  path: string,
  mtimeMs: number,
  sizeBytes: number,
  meta: SessionMeta,
): void {
  cache.entries[path] = { mtimeMs, sizeBytes, meta }
}

/** 丢掉已不在扫描结果里的条目（会话被删/挪走），返回清掉的条数 —— 缓存不随时间无限长 */
export function pruneMetaCache(cache: MetaCache, livePaths: Iterable<string>): number {
  const live = new Set(livePaths)
  let removed = 0
  for (const path of Object.keys(cache.entries)) {
    if (!live.has(path)) {
      delete cache.entries[path]
      removed++
    }
  }
  return removed
}

/**
 * 解析缓存文件。**永不抛出**（与仓库对不可信输入的一贯约定）：坏 JSON / 版本不符 → 空缓存；
 * 单条形状不对 → 只丢那一条，其余照用。缓存坏掉的最坏后果是重读一遍文件，不值得让扫描失败。
 */
export function parseMetaCache(text: string): MetaCache {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return emptyMetaCache()
  }
  if (!isRecord(raw) || raw['version'] !== META_CACHE_VERSION || !isRecord(raw['entries'])) {
    return emptyMetaCache()
  }
  const cache = emptyMetaCache()
  for (const [path, entry] of Object.entries(raw['entries'])) {
    if (!isRecord(entry)) continue
    const { mtimeMs, sizeBytes, meta } = entry
    if (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs)) continue
    if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes)) continue
    if (!isRecord(meta)) continue
    cache.entries[path] = { mtimeMs, sizeBytes, meta: meta as SessionMeta }
  }
  return cache
}

export function serializeMetaCache(cache: MetaCache): string {
  return JSON.stringify(cache)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
