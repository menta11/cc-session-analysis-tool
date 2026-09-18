import { fsBridge } from '../fsBridge'
import { lookupMeta, type MetaCache, type SessionMeta } from './metaCache'
import { joinPath } from '../paths'
import { yieldToHost } from '../yield'

export interface SessionRef {
  project: string // sanitized-cwd 目录名
  sessionId: string
  path: string // .jsonl 绝对路径
  mtimeMs: number
  sizeBytes: number
  /** 从 .jsonl 提取的真实工作目录路径（解码 sanitize 有损的中文等） */
  cwd?: string | null
  /** 用户显式命名的标题（custom-title / agent-name 事件，用户意图 > AI 摘要） */
  customTitle?: string | null
  /** 从 .jsonl 的 ai-title 事件提取的会话总结名称（最新一条） */
  aiTitle?: string | null
  /** 第一条 user 消息的 prompt 文本（剔除 command-message 包裹的命令），无则 undefined */
  userPrompt?: string | null
  /**
   * 这份 transcript 有没有可分析的记录（= 有没有 assistant 记录）。
   * `false` 才会被左栏隐藏，`undefined` = 还没判定（照常显示，绝不因为「没读到」把行藏掉）。
   */
  hasRecords?: boolean
}

/** 启动时愿意整读的文件上限：超过它就不读，留待按需判定（见 hasAssistantRecord 的说明） */
export const SMALL_SESSION_BYTES = 64 * 1024

/** 每处理这么多文件让出一次事件循环：让出太密在浏览器里会被定时器最小间隔夹取拖慢扫描 */
const YIELD_EVERY_FILES = 25

/**
 * 纯函数：这份 transcript 里有没有 assistant 记录。
 *
 * 为什么由它来定义「空会话」：日志视图/树视图的一切行都源自 assistant 消息（模型响应）与它发出的
 * 工具调用，没有 assistant 行 → 一条记录都没有。本机 1189 个顶层会话实测：**无 assistant ⟺ 0 条记录，
 * 零例外**；那些文件里只有 mode / permission-mode / file-history-snapshot / last-prompt / attachment
 * 这类记账事件（1189 个里 316 个是这种，占 27%），打开就是一张空表，不该占左栏一行。
 *
 * 容错方向是「宁可漏判」：marker 出现在附件文本里会判成「有记录」（多显示一行，无害），
 * 而真实会话不可能没有 assistant 行。
 */
export function hasAssistantRecord(text: string): boolean {
  return /"type"\s*:\s*"assistant"/.test(text)
}

/**
 * 三态判定：`true` 有记录 / `false` 确定没有 / `undefined` 判不了（未知）。
 *
 * `false` 是**结论**，必须有整份内容才敢下 —— 只有 `sizeBytes ≤ headCapBytes`（此时那次头部读
 * 一定覆盖整份：字节数 ≥ UTF-16 码元数，按码元计的读取上限对字节只会更宽）且全文没有 assistant 行
 * 才算空会话；否则一律 `undefined`，留给调用方保守处理。
 */
export function classifyHasRecords(
  text: string,
  sizeBytes: number,
  headCapBytes: number,
): boolean | undefined {
  // 「读不到」不是「没有」：两个宿主桥的读失败语义不一致（Node 桥吞掉错误返回空串，Tauri 抛错），
  // 所以按「非空文件却一个字节都没读到」来识别失败 —— 与宿主无关，也不依赖异常口径。
  // （空文件 size=0 不走这条：那确实是「没有记录」。）
  if (text === '' && sizeBytes > 0) return undefined
  if (hasAssistantRecord(text)) return true
  return sizeBytes <= headCapBytes ? false : undefined
}

/**
 * 读小文件的头部（≤ SMALL_SESSION_BYTES 的文件等于整读）。失败返回 null = 读不到，**不是**「没有」：
 * 权限错、文件刚被删都会走到这里，把它当结论会平白藏掉一行。
 */
async function readSmallHead(file: string): Promise<string | null> {
  try {
    return await fsBridge().readHead(file, SMALL_SESSION_BYTES)
  } catch {
    return null
  }
}

/**
 * 扫描 `~/.claude/projects/<project>/<sessionId>.jsonl`，返回所有顶层会话的**骨架**
 * （按 mtime 倒序）。同名目录（子产物/subagents）与非 .jsonl 文件自动跳过。
 *
 * **本函数不读任何文件内容**，只 `read_dir` + `stat`（本机 1185 个会话实测 82 ms）。标题、
 * cwd、首条提问这些需要读文件才有的字段留空，由 `metaLoader.ts` 按「谁被看见读谁」补齐 ——
 * 读文件内容的代价（单文件最多 8MB）不该在启动时一次性付出：本机全量补齐实测累计阻塞主线程
 * 117.7 秒、单次最长 5.69 秒。
 *
 * 全异步（fs/promises）且**按批**让出事件循环（见 `YIELD_EVERY_FILES`）：几百个会话（数百 MB）
 * 的全量扫描曾把宿主冻住数秒。让出的实现必须落在 `core/yield.ts` —— 裸用 Node 专有全局
 * （`setImmediate`）会让整个扫描在 WebView 里 reject（见该文件与对应 bug 单）。
 */
export async function scanProjects(root: string, cache?: MetaCache): Promise<SessionRef[]> {
  const out: SessionRef[] = []
  let projects: string[]
  try {
    projects = (await fsBridge().readDir(root))
      .filter((d) => d.isDir)
      .map((d) => d.name)
  } catch {
    return out
  }
  let processed = 0
  for (const proj of projects) {
    const pdir = joinPath(root, proj)
    let entries: string[]
    try {
      entries = (await fsBridge().readDir(pdir)).map((e) => e.name)
    } catch {
      continue
    }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue
      const full = joinPath(pdir, f)
      try {
        const st = await fsBridge().stat(full)
        if (!st.isFile) continue
        const ref: SessionRef = {
          project: proj,
          sessionId: f.replace(/\.jsonl$/, ''),
          path: full,
          mtimeMs: st.mtimeMs,
          sizeBytes: st.size,
        }
        // 判定「有没有记录」：缓存里已有结论就直接用（键是 path+mtime+size，文件没变才算数），
        // 否则小文件整读一次（≤64KB）。大文件一个字不读，留待行被看见时的元数据读去判。
        // 于是：第一次启动读 9 MB 抹掉 79% 的空行；之后每次启动，判过的连头都不用读。
        const cached = cache ? lookupMeta(cache, full, st.mtimeMs, st.size) : undefined
        if (cached?.hasRecords !== undefined) {
          ref.hasRecords = cached.hasRecords
        } else if (st.size <= SMALL_SESSION_BYTES) {
          const head = await readSmallHead(full)
          ref.hasRecords = head === null ? undefined : classifyHasRecords(head, st.size, SMALL_SESSION_BYTES)
        }
        out.push(ref)
      } catch {
        // 单文件读 stat 失败，跳过
      }
      // 每处理一批文件让出一次事件循环，宿主保持响应（批大小见 YIELD_EVERY_FILES）
      processed++
      if (processed % YIELD_EVERY_FILES === 0) await yieldToHost()
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/** 候选行配额：只统计非噪音事件行（user/assistant/标题事件），噪音不占名额 */
const META_MAX_LINES = 500
/** 字节总预算：新版超大会话（巨型 tool_result / hook_success，单行可达 2.4MB）会把标题推到文件深处，256KB 远远不够 */
const META_MAX_BYTES = 8 * 1024 * 1024
/** 系统噪音事件：不占行配额，跳过不解析（对应 parse.ts 的 SKIP_TYPES 语义，另含 file-history-delta） */
const NOISE_TYPES = new Set([
  'system',
  'progress',
  'permission-mode',
  'mode',
  'queue-operation',
  'last-prompt',
  'attachment',
  'file-history-snapshot',
  'file-history-delta',
])

/**
 * 读取 .jsonl 头部并提取 cwd（真实路径）、customTitle（用户显式命名）、
 * aiTitle（AI 总结名称）与第一条 user prompt（剔除 command-message 包裹的命令）。
 * 双预算确保尽力而为：
 *   1) 字节预算 META_MAX_BYTES —— 防百 MB 级文件整读拖垮扫描；
 *   2) 候选行配额 META_MAX_LINES —— 只统计真实事件行，attachment 等系统噪音不占名额。
 * 一级预算耗尽仍未找齐 → 返回已找到部分（标题降级到 sessionId 可辨认），绝不抛出。
 * 容错：文件读失败 / 行解析失败 → 返回空对象，绝不抛出。
 */
export async function readSessionMeta(file: string): Promise<SessionMeta> {
  let text: string
  try {
    // syscall 走 FsBridge（Node→node:fs，Tauri→IPC）。readHead 保证返回**行对齐前缀**，
    // 所以下面的逐行解析拿不到半行，与改造前的流式 readline 语义等价。
    text = await fsBridge().readHead(file, META_MAX_BYTES)
  } catch {
    return {} // 文件读失败（权限、被删等）→ 返回空，绝不抛出
  }
  const meta = extractSessionMeta(text)
  // 顺带判定「有没有记录」：文本已经在手里，判一次是零成本的字符串扫描。这个是**结论**，
  // 所以要么整份在手（size ≤ 字节预算）要么就不给答案 —— 未知时连字段都不写，
  // 免得 spread 时用 undefined 盖掉扫描阶段已经判好的值。
  let sizeBytes: number
  try {
    sizeBytes = (await fsBridge().stat(file)).size
  } catch {
    return meta
  }
  const flag = classifyHasRecords(text, sizeBytes, META_MAX_BYTES)
  return flag === undefined ? meta : { ...meta, hasRecords: flag }
}

/**
 * 纯函数：从 .jsonl 文本**前缀**提取 cwd / customTitle / aiTitle / 第一条 user prompt。
 * 不碰 fs，可独立单测；文件 I/O 由上面的 `readSessionMeta` 经 FsBridge 完成。
 * 双预算与噪音过滤语义与原实现逐字一致（见上方 META_MAX_* / NOISE_TYPES 说明）。
 */
export function extractSessionMeta(text: string): SessionMeta {
  let cwd: string | null = null
  let customTitle: string | null = null
  let aiTitle: string | null = null
  let userPrompt: string | null = null
  let foundCwd = false
  let foundCustomTitle = false
  let foundAiTitle = false
  let foundPrompt = false
  const allFound = (): boolean => foundCwd && foundCustomTitle && foundAiTitle && foundPrompt

  let bytesRead = 0
  let candidateLines = 0
  // 遍历来源由 FsBridge.readHead 提供的行对齐前缀（不再是 readline 流）。
  // 保留 try 形状，使下面的逐行逻辑与改造**逐字相同**。
  try {
    for (const line of text.split('\n')) {
      if (allFound()) break
      bytesRead += line.length + 1 // 粗略字节（UTF-16 计数偏大，作为安全上界）
      if (bytesRead > META_MAX_BYTES) break
      if (!line.trim()) continue
      // 行首探测：顶层 type 几乎总在行首 256 字符内（parentUuid/isSidechain 均极短），
      // 巨型 attachment 行命中后直接跳过 —— 省掉 2.4MB 行的 JSON.parse 成本
      const headType = /"type"\s*:\s*"([^"]*)"/.exec(line.slice(0, 256))?.[1]
      if (headType && NOISE_TYPES.has(headType)) continue // 系统噪音：不占配额、不解析
      candidateLines++
      if (candidateLines > META_MAX_LINES) break

      let obj: Record<string, unknown>
      try {
        obj = JSON.parse(line)
      } catch {
        continue // 单行容错：坏 JSON 跳过（已占配额，防全坏行文件无限扫描）
      }
      // 探测影子外（顶层 type 位于 256 字符后）的噪音行：不占配额
      if (typeof obj['type'] === 'string' && NOISE_TYPES.has(obj['type'] as string)) {
        candidateLines--
        continue
      }
      if (!foundCwd && typeof obj['cwd'] === 'string') {
        cwd = obj['cwd']
        foundCwd = true
      }
      // 用户显式命名（custom-title / agent-name 事件，字段 customTitle / agentName），与 ai-title 相互独立收集
      if (!foundCustomTitle && obj['type'] === 'custom-title') {
        const t = obj['customTitle']
        if (typeof t === 'string' && t.trim() !== '') {
          customTitle = t
          foundCustomTitle = true
        }
      }
      if (!foundCustomTitle && obj['type'] === 'agent-name') {
        const t = obj['agentName']
        if (typeof t === 'string' && t.trim() !== '') {
          customTitle = t
          foundCustomTitle = true
        }
      }
      if (!foundAiTitle && obj['type'] === 'ai-title' && typeof obj['aiTitle'] === 'string') {
        aiTitle = obj['aiTitle']
        foundAiTitle = true
      }
      // 跳过 isMeta 系统注入的 user 事件（caveat / system-reminder / 图片粘贴通知等）：
      // 它们不是真实提问，混进来会把降级标题污染成系统文案
      if (!foundPrompt && obj['type'] === 'user' && obj['isMeta'] !== true) {
        const p = extractUserPrompt(obj)
        if (p) {
          userPrompt = p
          foundPrompt = true
        }
      }
    }
  } catch {
    // 已无 fs 操作；此 catch 只兜逻辑异常 → 落到下方返回"已找到的部分"，绝不抛出
  }
  return {
    cwd: foundCwd ? cwd : undefined,
    customTitle: foundCustomTitle ? customTitle : undefined,
    aiTitle: foundAiTitle ? aiTitle : undefined,
    userPrompt: foundPrompt ? userPrompt : undefined,
  }
}

/** 剔除 <command-message>…</command-message> 等 command 标签块，返回用户真实输入文本 */
const COMMAND_TAG_RE = /<command-\w+>[\s\S]*?<\/command-\w+>/g
/** 系统注入标签块（caveat / local-command 输出 / system-reminder / task-notification）整体剔除 */
const SYSTEM_TAG_RE = [
  /<local-command-\w+>[\s\S]*?<\/local-command-\w+>/g,
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<task-notification>[\s\S]*?<\/task-notification>/g,
]

/**
 * 从 user 事件提取 prompt：取 message.content（字符串或 text 块数组），
 * 剔除 command-message/command-name/command-args 标签包裹的命令元数据，
 * 以及 local-command-* / system-reminder / task-notification 系统注入块。
 */
function extractUserPrompt(obj: Record<string, unknown>): string | null {
  const msg = obj['message']
  if (!msg || typeof msg !== 'object') return null
  if (obj['isMeta'] === true) return null // 双保险：事件级 isMeta 直接跳过
  const content = (msg as { content?: unknown }).content
  let text = ''
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    for (const b of content) {
      if (b && typeof b === 'object' && (b as { type?: string }).type === 'text' && typeof (b as { text?: unknown }).text === 'string') {
        text += (b as { text: string }).text
      }
    }
  }
  const cleaned = text
    .replace(COMMAND_TAG_RE, '')
    .replace(SYSTEM_TAG_RE[0], '')
    .replace(SYSTEM_TAG_RE[1], '')
    .replace(SYSTEM_TAG_RE[2], '')
    .trim()
  return cleaned || null
}
