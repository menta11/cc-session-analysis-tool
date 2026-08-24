import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

export interface SessionRef {
  project: string // sanitized-cwd 目录名
  sessionId: string
  path: string // .jsonl 绝对路径
  mtimeMs: number
  sizeBytes: number
  /** 从 .jsonl 提取的真实工作目录路径（解码 sanitize 有损的中文等） */
  cwd?: string | null
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
        const { cwd, aiTitle, userPrompt } = await readSessionMeta(full)
        out.push({
          project: proj,
          sessionId: f.replace(/\.jsonl$/, ''),
          path: full,
          mtimeMs: st.mtimeMs,
          sizeBytes: st.size,
          cwd,
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

const META_MAX_LINES = 200
/** 只读文件头提取元数据：cwd/ai-title/首条 user prompt 通常都在前部，整读大文件（百 MB 级）会拖垮扫描。 */
const META_READ_BYTES = 256 * 1024

/**
 * 读取 .jsonl 文件头（前 META_READ_BYTES 字节），提取 cwd（真实路径）、aiTitle（最新会话总结名称）与
 * 第一条 user prompt（剔除 command-message 包裹的命令）。
 * 只看前 META_MAX_LINES 行（ai-title 通常出现在文件前部），全部找到即提前停止。
 * 容错：文件读失败 / 行解析失败 → 返回空对象，绝不抛出。
 * 代价：超长首条 user 消息（>256KB）会被截断丢失 —— 仅影响列表展示标题，可接受。
 */
export async function readSessionMeta(file: string): Promise<{ cwd?: string | null; aiTitle?: string | null; userPrompt?: string | null }> {
  let text: string
  try {
    const fh = await open(file, 'r')
    try {
      const buf = Buffer.alloc(META_READ_BYTES)
      const { bytesRead } = await fh.read(buf, 0, META_READ_BYTES, 0)
      text = buf.subarray(0, bytesRead).toString('utf8')
    } finally {
      await fh.close()
    }
  } catch {
    // 文件读失败（权限、被删等）→ 返回空
    return {}
  }
  let cwd: string | null = null
  let aiTitle: string | null = null
  let userPrompt: string | null = null
  let foundCwd = false
  let foundTitle = false
  let foundPrompt = false
  for (const line of text.split('\n').slice(0, META_MAX_LINES)) {
    if (foundCwd && foundTitle && foundPrompt) break
    if (!line.trim()) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line)
    } catch {
      continue // 单行容错：坏 JSON（含截断的末行）跳过
    }
    if (!foundCwd && typeof obj['cwd'] === 'string') {
      cwd = obj['cwd']
      foundCwd = true
    }
    if (!foundTitle && obj['type'] === 'ai-title' && typeof obj['aiTitle'] === 'string') {
      aiTitle = obj['aiTitle']
      foundTitle = true
    }
    if (!foundPrompt && obj['type'] === 'user') {
      const p = extractUserPrompt(obj)
      if (p) {
        userPrompt = p
        foundPrompt = true
      }
    }
  }
  return {
    cwd: foundCwd ? cwd : undefined,
    aiTitle: foundTitle ? aiTitle : undefined,
    userPrompt: foundPrompt ? userPrompt : undefined,
  }
}

/** 剔除 <command-message>…</command-message> 等 command 标签块，返回用户真实输入文本 */
const COMMAND_TAG_RE = /<command-\w+>[\s\S]*?<\/command-\w+>/g

/**
 * 从 user 事件提取 prompt：取 message.content（字符串或 text 块数组），
 * 剔除 command-message/command-name/command-args 标签包裹的命令元数据。
 */
function extractUserPrompt(obj: Record<string, unknown>): string | null {
  const msg = obj['message']
  if (!msg || typeof msg !== 'object') return null
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
  const cleaned = text.replace(COMMAND_TAG_RE, '').trim()
  return cleaned || null
}
