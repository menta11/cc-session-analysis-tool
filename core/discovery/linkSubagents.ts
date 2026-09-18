import type { Session, ToolCall } from '../parser/types'

/**
 * 解析子 transcript 的策略（依赖注入，便于单测与懒加载）。
 *
 * 允许返回 Promise：Tauri 渲染层没有同步 fs（只有异步 IPC），子 transcript 只能异步读。
 * 同步实现（`parseJsonl`、测试里的假实现）照旧可用 —— `await` 对非 Promise 是恒等操作。
 */
export type ParseChild = (path: string) => Session | Promise<Session>

/** 派发子 agent 的工具名（新版 Agent，旧版 Task）。 */
const DISPATCH_TOOLS = new Set(['Agent', 'Task'])

/** 异步 agent 不带结构化 agentId 时，从 tool_result 文本兜底抽取（CSD 来源 2）。 */
const ASYNC_AGENT_ID_RE = /agentId:\s*([\w-]+)/

export interface LinkResult {
  session: Session
  /** 解析失败/缺 agentId/索引未命中的 Agent 调用（诊断用，不阻断）。 */
  unresolved: ToolCall[]
}

/**
 * 递归把子 agent transcript 挂到对应 Agent 调用的 childSession。
 * 链接键：优先 structuredResult.agentId；取不到则从 tool_result 文本正则兜底（async agent）。
 * 递归：解析到的子 session 自身的 Agent 调用会继续链接孙 agent（自动拾取嵌套子 agent）。
 * 用 agentId 缓存避免重复解析与循环。
 */
export async function linkSubagents(
  session: Session,
  index: Map<string, string>,
  parseChild: ParseChild,
): Promise<LinkResult> {
  const unresolved: ToolCall[] = []
  const cache = new Map<string, Session>()

  const link = async (s: Session): Promise<void> => {
    for (const turn of s.turns) {
      for (const tc of turn.toolCalls) {
        if (!DISPATCH_TOOLS.has(tc.name)) continue
        const agentId = resolveAgentId(tc)
        const childPath = agentId ? index.get(agentId) : undefined
        if (!agentId || !childPath) {
          unresolved.push(tc)
          continue
        }
        let child = cache.get(agentId)
        if (!child) {
          try {
            child = await parseChild(childPath)
          } catch {
            unresolved.push(tc)
            continue
          }
          cache.set(agentId, child)
          await link(child) // 递归到孙 agent
        }
        tc.childSession = child
      }
    }
  }

  await link(session)
  return { session, unresolved }
}

function resolveAgentId(tc: ToolCall): string | null {
  const sr = tc.structuredResult
  if (sr && sr.toolName === 'Agent' && sr.agentId) return sr.agentId
  if (tc.result) {
    const m = ASYNC_AGENT_ID_RE.exec(tc.result)
    if (m) return m[1]
  }
  return null
}
