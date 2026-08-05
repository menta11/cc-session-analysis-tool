import type { NodeTime, Session, Turn } from '../parser/types'
import { classifyTool } from './classify'
import { clipInterval, unionDuration, type Interval } from './timeline'

export interface CategoryIntervals {
  waitUser: Interval[] // AskUserQuestion + 轮间间隙
  direct: Interval[]
  delegated: Interval[]
  compute: Interval[] // 总耗时内"工具/等待覆盖"的补集 = 模型思考时段
}

/**
 * 收集会话各类活动的总耗时区间（甘特时序用）。
 *  - waitUser = AskUserQuestion 区间 + 轮间间隙(等用户输入)。
 *  - compute  = [startedAt, endedAt] 内 (waitUser ∪ direct ∪ delegated) 的补集。
 */
export function sessionIntervals(session: Session): CategoryIntervals {
  const direct: Interval[] = []
  const delegated: Interval[] = []
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
  // 方案A：总耗时一维，每一秒只归一类。等用户让出与"本地工具(含后台 agent)"重叠的部分
  // （人离开但后台 agent 在跑 → 算委派，不算空闲）→ 等用户 = 真空闲，sum 严格 = 总耗时。
  const activity = [...direct, ...delegated]
  // 轮间间隙裁剪到会话范围（窗口）
  const gaps = interTurnGaps(session)
    .map((iv) => inScope(iv))
    .filter((iv): iv is Interval => iv !== null)
  const rawWait = session.isSubagent ? askUser : [...askUser, ...gaps]
  const waitUser = rawWait.flatMap((iv) => complement(activity, iv.start, iv.end))
  const compute = start != null && end != null ? complement([...waitUser, ...activity], start, end) : []
  return { waitUser, direct, delegated, compute }
}

/**
 * 节点总耗时时间分解（对齐后模型）：wallMs = 等用户 + 本地工具 + compute。
 * 详见模型说明；此处 ms 全部由 sessionIntervals 的区间并集派生，保证与甘特一致。
 */
export function breakdownOf(session: Session): NodeTime {
  const ci = sessionIntervals(session)
  const wallMs = session.startedAt != null && session.endedAt != null ? session.endedAt - session.startedAt : 0
  const directMs = unionDuration(ci.direct)
  const delegatedMs = unionDuration(ci.delegated)
  const localToolMs = unionDuration([...ci.direct, ...ci.delegated])
  const waitUserMs = unionDuration(ci.waitUser)
  const computeMs = unionDuration(ci.compute) // 用补集并集，与甘特一致；正确处理异步子 agent 与等用户的时间重叠
  return { wallMs, waitUserMs, localToolMs, directMs, delegatedMs, computeMs }
}

/** 轮间间隙区间：turn N 最后活动 → turn N+1 用户输入。 */
function interTurnGaps(session: Session): Interval[] {
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
