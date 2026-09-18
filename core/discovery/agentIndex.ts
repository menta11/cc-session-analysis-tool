import { fsBridge } from '../fsBridge'
import { joinPath } from '../paths'

const AGENT_FILE = /^agent-(.+)\.jsonl$/

/**
 * 扫描会话目录，建立 agentId → 子 transcript 路径 的索引。
 * 候选目录（按优先级）：subagents/（首选）、agents/（回退）、subagents/workflows/<runId>/（Workflow 子 agent）。
 * 同名 agentId 以先扫到的为准（subagents/ 优先），与 CSD subagent-discovery 一致。
 * 不读文件内容，只按文件名 agent-<id>.jsonl 直对应（已实测 100% 可靠）。
 *
 * 为什么是 async：目录列举经 `FsBridge`（见 core/fsBridge.ts）—— 它在 Node 侧是 node:fs、
 * 在 Tauri 渲染层是异步 IPC，所以统一取异步形状。
 */
export async function buildAgentIndex(sessionDir: string): Promise<Map<string, string>> {
  const index = new Map<string, string>()

  const scanDir = async (dir: string): Promise<void> => {
    let entries: string[]
    try {
      entries = (await fsBridge().readDir(dir)).map((e) => e.name)
    } catch {
      return
    }
    for (const f of entries) {
      const m = AGENT_FILE.exec(f)
      if (!m) continue
      const id = m[1]
      if (!index.has(id)) index.set(id, joinPath(dir, f))
    }
  }

  // 1) subagents/ 优先，2) agents/ 回退
  await scanDir(joinPath(sessionDir, 'subagents'))
  await scanDir(joinPath(sessionDir, 'agents'))

  // 3) Workflow 子 agent：subagents/workflows/<runId>/agent-*.jsonl
  const wfRoot = joinPath(sessionDir, 'subagents', 'workflows')
  try {
    for (const runId of (await fsBridge().readDir(wfRoot)).map((e) => e.name)) {
      await scanDir(joinPath(wfRoot, runId))
    }
  } catch {
    // 无 workflows 目录，忽略
  }

  return index
}
