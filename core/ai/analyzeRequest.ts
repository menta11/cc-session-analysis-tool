import type { Session, ToolCall } from '../parser/types'
import { breakdownOf } from '../model/timeBreakdown'
import { buildDigest, buildFileMap, type FileMeta } from './prompt'
import { getSystemPrompt } from './template'

export interface AnalyzeRequestOpts {
  kind: 'whole' | 'node'
  projectsRoot: string
  mainFilePath: string
  /** agentId → 子 transcript 绝对路径（来自 buildAgentIndex，覆盖本会话所有后代）。 */
  agentIndex: Map<string, string>
  /** node 模式：要诊断的子 agent 调用的 toolUseId（在 session 树中递归定位）。 */
  focusToolUseId?: string
  /** 可选：由调用方注入的文件元信息（行数/体积）。 */
  fileMeta?: (absPath: string) => FileMeta | null
}

export interface AnalyzeRequest {
  systemPrompt: string
  userMessage: string
}

/** 在 session 树中递归定位 toolUseId 对应的调用及其所在（父）会话。 */
function findToolCall(session: Session, toolUseId: string): { tc: ToolCall; parent: Session } | null {
  const walk = (s: Session): { tc: ToolCall; parent: Session } | null => {
    for (const t of s.turns) {
      for (const tc of t.toolCalls) {
        if (tc.toolUseId === toolUseId) return { tc, parent: s }
        if (tc.childSession) {
          const r = walk(tc.childSession)
          if (r) return r
        }
      }
    }
    return null
  }
  return walk(session)
}

/**
 * 组装一次 claude 分析调用：systemPrompt（角色+模板+约束，走 --append-system-prompt）
 * + userMessage（digest + fileMap，走 stdin）。
 * - whole：整会话 digest + 全量文件地图。
 * - node：聚焦某子 agent —— 递归定位 child + parentAgentCall，digest 含父子对账/占父%，
 *   fileMap 为该 child 的子地图（孙 agent）。
 */
export function buildAnalyzeRequest(session: Session, opts: AnalyzeRequestOpts): AnalyzeRequest {
  let digest: string
  let fileMap: string

  if (opts.kind === 'node') {
    if (!opts.focusToolUseId) throw new Error('node 模式必须提供 focusToolUseId')
    const found = findToolCall(session, opts.focusToolUseId)
    if (!found || !found.tc.childSession) {
      throw new Error(`focus toolUseId ${opts.focusToolUseId} 未找到子 agent 会话（可能非 Agent 调用或未链接）`)
    }
    const { tc, parent } = found
    const child = tc.childSession as Session
    const childAgentId = tc.structuredResult?.toolName === 'Agent' ? tc.structuredResult.agentId : null
    const childFilePath = childAgentId ? opts.agentIndex.get(childAgentId) ?? '' : ''
    digest = buildDigest(child, { parentAgentCall: tc, parentWallMs: breakdownOf(parent).wallMs })
    fileMap = buildFileMap(child, {
      projectsRoot: opts.projectsRoot,
      mainFilePath: childFilePath,
      agentIndex: opts.agentIndex,
      fileMeta: opts.fileMeta,
    })
  } else {
    digest = buildDigest(session)
    fileMap = buildFileMap(session, {
      projectsRoot: opts.projectsRoot,
      mainFilePath: opts.mainFilePath,
      agentIndex: opts.agentIndex,
      fileMeta: opts.fileMeta,
    })
  }

  const userMessage = `${digest}\n\n${fileMap}`
  return { systemPrompt: getSystemPrompt(), userMessage }
}
