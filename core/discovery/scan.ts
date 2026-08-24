import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

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
}

/**
 * 扫描 ~/.claude/projects/<project>/<sessionId>.jsonl，返回所有顶层会话（按 mtime 倒序）。
 * 同名目录（子产物/subagents）与非 .jsonl 文件自动跳过。
 *
 * 全异步（fs/promises）且逐文件让出事件循环：在 Electron 主进程跑时不会阻塞
 * 窗口事件/IPC/内嵌 proxy —— 几百个会话（数百 MB）的全量扫描曾把主进程冻住数秒。
 */
export async function scanProjects(root: string): Promise<SessionRef[]> {
  const out: SessionRef[] = []
  let projects: string[]
  try {
    projects = (await readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return out
  }
  for (const proj of projects) {
    const pdir = join(root, proj)
    let entries: string[]
    try {
      entries = await readdir(pdir)
    } catch {
      continue
    }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue
      const full = join(pdir, f)
      try {
        const st = await stat(full)
        if (!st.isFile()) continue
        const { cwd, customTitle, aiTitle, userPrompt } = await readSessionMeta(full)
        out.push({
          project: proj,
          sessionId: f.replace(/\.jsonl$/, ''),
          path: full,
          mtimeMs: st.mtimeMs,
          sizeBytes: st.size,
          cwd,
          customTitle,
          aiTitle,
          userPrompt,
        })
      } catch {
        // 单文件读 stat 失败，跳过
      }
      // 每个文件让出事件循环，主进程保持响应
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/** 默认 ~/.claude/projects（无 Electron 依赖；主进程可用 app.getPath('home') 覆盖）。 */
export function defaultProjectsRoot(): string {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  return join(home, '.claude', 'projects')
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
 * 流式读取 .jsonl（逐行 readline，天然处理 2.4MB 巨型行），提取 cwd（真实路径）、customTitle（用户显式命名）、
 * aiTitle（AI 总结名称）与第一条 user prompt（剔除 command-message 包裹的命令）。
 * 双预算确保尽力而为：
 *   1) 字节预算 META_MAX_BYTES —— 防百 MB 级文件整读拖垮扫描；
 *   2) 候选行配额 META_MAX_LINES —— 只统计真实事件行，attachment 等系统噪音不占名额。
 * 一级预算耗尽仍未找齐 → 返回已找到部分（标题降级到 sessionId 可辨认），绝不抛出。
 * 容错：文件读失败 / 行解析失败 → 返回空对象，绝不抛出。
 */
export async function readSessionMeta(
  file: string,
): Promise<{ cwd?: string | null; customTitle?: string | null; aiTitle?: string | null; userPrompt?: string | null }> {
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
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  try {
    for await (const line of rl) {
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
    // 文件读失败（权限、被删等）→ 返回空
    return {}
  } finally {
    rl.close()
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
