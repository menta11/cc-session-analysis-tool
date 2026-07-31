import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const AGENT_FILE = /^agent-(.+)\.jsonl$/

/**
 * 扫描会话目录，建立 agentId → 子 transcript 路径 的索引。
 * 候选目录（按优先级）：subagents/（首选）、agents/（回退）、subagents/workflows/<runId>/（Workflow 子 agent）。
 * 同名 agentId 以先扫到的为准（subagents/ 优先），与 CSD subagent-discovery 一致。
 * 不读文件内容，只按文件名 agent-<id>.jsonl 直对应（已实测 100% 可靠）。
 */
export function buildAgentIndex(sessionDir: string): Map<string, string> {
  const index = new Map<string, string>()

  const scanDir = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const f of entries) {
      const m = AGENT_FILE.exec(f)
      if (!m) continue
      const id = m[1]
      if (!index.has(id)) index.set(id, join(dir, f))
    }
  }

  // 1) subagents/ 优先，2) agents/ 回退
  scanDir(join(sessionDir, 'subagents'))
  scanDir(join(sessionDir, 'agents'))

  // 3) Workflow 子 agent：subagents/workflows/<runId>/agent-*.jsonl
  const wfRoot = join(sessionDir, 'subagents', 'workflows')
  try {
    for (const runId of readdirSync(wfRoot)) {
      scanDir(join(wfRoot, runId))
    }
  } catch {
    // 无 workflows 目录，忽略
  }

  return index
}
