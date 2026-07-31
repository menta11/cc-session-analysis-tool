import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface SessionRef {
  project: string // sanitized-cwd 目录名
  sessionId: string
  path: string // .jsonl 绝对路径
  mtimeMs: number
  sizeBytes: number
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
        out.push({
          project: proj,
          sessionId: f.replace(/\.jsonl$/, ''),
          path: full,
          mtimeMs: st.mtimeMs,
          sizeBytes: st.size,
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
