import { readdirSync, readFileSync, statSync } from 'node:fs'
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
 */
export function scanProjects(root: string): SessionRef[] {
  const out: SessionRef[] = []
  let projects: string[]
  try {
    projects = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return out
  }
  for (const proj of projects) {
    const pdir = join(root, proj)
    let entries: string[]
    try {
      entries = readdirSync(pdir)
    } catch {
      continue
    }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue
      const full = join(pdir, f)
      try {
        const st = statSync(full)
        if (!st.isFile()) continue
        const { cwd, aiTitle, userPrompt } = readSessionMeta(full)
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

/**
 * 读取 .jsonl 前若干行，提取 cwd（真实路径）、aiTitle（最新会话总结名称）与
 * 第一条 user prompt（剔除 command-message 包裹的命令）。
 * 只读前 META_MAX_LINES 行（ai-title 通常出现在文件前部），全部找到即提前停止。
 * 容错：文件读失败 / 行解析失败 → 返回空对象，绝不抛出。
 */
export function readSessionMeta(file: string): { cwd?: string | null; aiTitle?: string | null; userPrompt?: string | null } {
  let cwd: string | null = null
  let aiTitle: string | null = null
  let userPrompt: string | null = null
  let foundCwd = false
  let foundTitle = false
  let foundPrompt = false
  try {
    const content = readFileSync(file, 'utf8')
    for (const line of content.split('\n').slice(0, META_MAX_LINES)) {
      if (foundCwd && foundTitle && foundPrompt) break
      if (!line.trim()) continue
      let obj: Record<string, unknown>
      try {
        obj = JSON.parse(line)
      } catch {
        continue // 单行容错：坏 JSON 跳过
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
  } catch {
    // 文件读失败（权限、被删等）→ 返回空，不抛出
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
