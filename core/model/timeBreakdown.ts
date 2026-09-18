import type { NodeTime, Session, ToolCall, Turn } from '../parser/types'
import { classifyTool } from './classify'
import { clipInterval, unionDuration, type Interval } from './timeline'

export interface CategoryIntervals {
  waitUser: Interval[] // AskUserQuestion + 轮间间隙
  direct: Interval[]
  delegated: Interval[]
  workflow: Interval[]
  compute: Interval[] // 总耗时内"工具/等待覆盖"的补集 = 模型思考时段
}

/**
 * workflow 调用的真实运行区间：run 记录给的开始时刻 + 时长（见 `WorkflowRun`）。
 *
 * 导出为**唯一一份定义**：分解/甘特、树视图、日志行三处都读它，否则同一次运行会算出三个时长。
 * 没有 run 记录或记录里没有开始时刻 → null（调用方退回它自己那个几百毫秒的发起区间）。
 */
export function workflowSpanOf(tc: ToolCall): Interval | null {
  const wf = tc.workflowRun
  if (!wf || wf.startTs === null || wf.durationMs <= 0) return null
  return { start: wf.startTs, end: wf.startTs + wf.durationMs }
}

/**
 * 收集会话各类活动的总耗时区间（甘特时序用）。
 *  - waitUser = AskUserQuestion 区间 + 轮间间隙(等用户输入)。
 *  - compute  = [startedAt, endedAt] 内 (waitUser ∪ direct ∪ delegated ∪ workflow) 的补集。
 */
export function sessionIntervals(session: Session): CategoryIntervals {
  const direct: Interval[] = []
  const delegated: Interval[] = []
  const workflow: Interval[] = []
  const askUser: Interval[] = []
  const start = session.startedAt
  const end = session.endedAt
  // 把区间裁剪到会话范围（窗口）：窗口裁剪后 start/end 是窗口边界，
  // 横跨窗口边界的调用/等待只保留窗口内部分（避免窗口模式虚高）
  const inScope = (iv: Interval): Interval | null =>
    start != null && end != null ? clipInterval(iv, start, end) : iv
  for (const turn of session.turns) {
    for (const tc of turn.toolCalls) {
      const kind = classifyTool(tc.name)
      if (kind === 'delegated') {
        // 用子 agent 实际总耗时（异步后台 agent 的真实运行时长）；无 child 退回父侧调度区间
        const child = tc.childSession
        const iv = child && child.startedAt != null && child.endedAt != null
          ? { start: child.startedAt, end: child.endedAt }
          : tc.tsEnd != null
            ? { start: tc.tsStart, end: tc.tsEnd }
            : null
        if (iv) {
          const c = inScope(iv)
          if (c) delegated.push(c)
        }
      } else if (kind === 'workflow') {
        // 有 run 记录就用它真实的运行区间；没有（本机 84 次已发起的 workflow 里 5 次）退回发起那
        // 几百毫秒 —— 宁可少算，也不拿「发起 → 返回」冒充运行时长
        const iv = workflowSpanOf(tc) ?? (tc.tsEnd != null ? { start: tc.tsStart, end: tc.tsEnd } : null)
        if (iv) {
          const c = inScope(iv)
          if (c) workflow.push(c)
        }
      } else if (tc.tsEnd != null) {
        const iv: Interval = { start: tc.tsStart, end: tc.tsEnd }
        const c = inScope(iv)
        if (c) {
          if (kind === 'direct') direct.push(c)
          else if (kind === 'wait-user') askUser.push(c)
        }
      }
    }
  }
  // 方案A：总耗时一维，每一秒只归一类。等用户让出与"本地工具(含后台 agent 与 workflow)"重叠的部分
  // （人离开但后台 agent/workflow 在跑 → 算它们的，不算空闲）→ 等用户 = 真空闲，sum 严格 = 总耗时。
  // workflow 之间、workflow 与工具之间允许重叠（它在后台跑，主 agent 照常干活），所以并集是**逐类**算的。
  const activity = [...direct, ...delegated, ...workflow]
  // 轮间间隙裁剪到会话范围（窗口）
  const gaps = interTurnGaps(session)
    .map((iv) => inScope(iv))
    .filter((iv): iv is Interval => iv !== null)
  const rawWait = session.isSubagent ? askUser : [...askUser, ...gaps]
  const waitUser = rawWait.flatMap((iv) => complement(activity, iv.start, iv.end))
  const compute = start != null && end != null ? complement([...waitUser, ...activity], start, end) : []
  return { waitUser, direct, delegated, workflow, compute }
}

/**
 * 节点总耗时时间分解（对齐后模型）：wallMs = 等用户 + 本地工具 + compute。
 * 详见模型说明；此处 ms 全部由 sessionIntervals 的区间并集派生，保证与甘特一致。
 *
 * 「本地工具」是**并集**，不是三类相加：workflow 与直接工具、委派与直接工具都可能同时发生
 * （后台在跑、主 agent 也在干活），相加会把同一秒算几遍。于是 `directMs + delegatedMs + workflowMs`
 * 可以大于 `localToolMs` —— 那是真实的并行，不是算错。
 */
export function breakdownOf(session: Session): NodeTime {
  const ci = sessionIntervals(session)
  const wallMs = session.startedAt != null && session.endedAt != null ? session.endedAt - session.startedAt : 0
  const directMs = unionDuration(ci.direct)
  const delegatedMs = unionDuration(ci.delegated)
  const workflowMs = unionDuration(ci.workflow)
  const localToolMs = unionDuration([...ci.direct, ...ci.delegated, ...ci.workflow])
  const waitUserMs = unionDuration(ci.waitUser)
  const computeMs = unionDuration(ci.compute) // 用补集并集，与甘特一致；正确处理异步子 agent 与等用户的时间重叠
  return { wallMs, waitUserMs, localToolMs, directMs, delegatedMs, workflowMs, computeMs }
}

/**
 * 轮间间隙区间：turn N 最后活动 → turn N+1 用户输入。
 *
 * 导出给「日志视图」用：那里的每一段等用户都要成为一行真实记录，而它必须与
 * 甘特/分解用的是同一份区间定义（否则同一段时间在两处对不上）。
 */
export function interTurnGaps(session: Session): Interval[] {
  const out: Interval[] = []
  for (let i = 0; i + 1 < session.turns.length; i++) {
    const next = session.turns[i + 1]
    if (next.userMsg == null) continue
    const lastAct = lastActivityMs(session.turns[i])
    if (lastAct == null) continue
    if (next.userMsg.ts > lastAct) out.push({ start: lastAct, end: next.userMsg.ts })
  }
  return out
}

function lastActivityMs(turn: Turn): number | null {
  let max: number | null = null
  for (const a of turn.assistantMsgs) if (max == null || a.ts > max) max = a.ts
  for (const tc of turn.toolCalls) if (tc.tsEnd != null && (max == null || tc.tsEnd > max)) max = tc.tsEnd
  return max
}

/** 区间集合在 [lo, hi] 内的补集（用于求 compute 时段）。 */
export function complement(intervals: Interval[], lo: number, hi: number): Interval[] {
  if (hi <= lo) return []
  const sorted = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start)
  const out: Interval[] = []
  let cur = lo
  for (const iv of sorted) {
    if (iv.end <= cur) continue
    if (iv.start >= hi) break
    if (iv.start > cur) out.push({ start: cur, end: Math.min(iv.start, hi) })
    cur = Math.max(cur, iv.end)
    if (cur >= hi) break
  }
  if (cur < hi) out.push({ start: cur, end: hi })
  return out
}
