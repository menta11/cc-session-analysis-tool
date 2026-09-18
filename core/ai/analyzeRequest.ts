import type { Session, ToolCall } from '../parser/types'
import { breakdownOf } from '../model/timeBreakdown'
import { buildDigest, buildFileMap, type FileMeta } from './prompt'
import { getLogSystemPrompt, getSystemPrompt } from './template'
import { clipSessionToWindow } from './sessionWindow'
import { buildLogDigest, type LogScope } from './logDigest'
import type { LogSummary } from '../view/logView'
import type { ViewWindow } from '../view/window'

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
  /** 可选：按时间窗口分析（视图窗口 [start,end]）。存在时基于窗口内完整 turns 构建 digest。 */
  window?: ViewWindow
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
    // 按窗口分析：基于窗口内完整 turns 的 session 视图构建 digest/fileMap
    const scoped = opts.window ? clipSessionToWindow(session, opts.window.start, opts.window.end) : session
    digest = buildDigest(scoped)
    fileMap = buildFileMap(scoped, {
      projectsRoot: opts.projectsRoot,
      mainFilePath: opts.mainFilePath,
      agentIndex: opts.agentIndex,
      fileMeta: opts.fileMeta,
    })
  }

  const userMessage = `${digest}\n\n${fileMap}`
  return { systemPrompt: getSystemPrompt(), userMessage }
}

export interface LogAnalyzeOpts {
  /**
   * 会话本体。**只用来生成文件地图（取证线索）** —— 分析输入是 `scope` 那张筛选后的表，
   * 不是整个会话。之所以还要它：报告里要能指着「这一条去哪个文件、grep 哪个 id」，而
   * 记录 ID → 文件的对应关系在会话树与 agentIndex 里，记录表本身没有。
   */
  session: Session
  scope: LogScope
  /** 整会话五类分解（`logSummary`）。行内标注为整会话口径，与筛选后条数区分开。 */
  summary: LogSummary
  projectsRoot: string
  mainFilePath: string
  agentIndex: Map<string, string>
  fileMeta?: (absPath: string) => FileMeta | null
}

/**
 * 组装「日志视图筛选后记录表」的一次分析调用：systemPrompt 走 log-run 模板，
 * userMessage = 记录表 digest + 整会话文件地图（取证）。
 *
 * 与 `buildAnalyzeRequest` 平级而不是它的一个 kind：两者的**输入根本不是同一种东西**
 * （Session vs 记录表），硬塞进一个 kind 分支会让那个函数的参数形状变成两套语义的并集。
 */
export function buildLogAnalyzeRequest(opts: LogAnalyzeOpts): AnalyzeRequest {
  const digest = buildLogDigest(opts.scope, opts.summary)
  const fileMap = buildFileMap(opts.session, {
    projectsRoot: opts.projectsRoot,
    mainFilePath: opts.mainFilePath,
    agentIndex: opts.agentIndex,
    fileMeta: opts.fileMeta,
  })
  return { systemPrompt: getLogSystemPrompt(), userMessage: `${digest}\n\n${fileMap}` }
}
