import type { Session, Turn } from '../parser/types'

/**
 * 把会话裁剪到时间窗口 [viewStart, viewEnd]：保留窗口内**完整 turns**。
 *  - turn 的 userMsg / 任意 assistantMsg / 任意 toolCall 落在窗口内 → 保留整个 turn（不裁剪 turn 内部）
 *  - 保留 turn 里的子 agent（childSession）也递归裁剪：startedAt/endedAt 与窗口交集，
 *    避免 breakdown 的 delegated 时长用子 agent 完整时间（横跨窗口 → 虚高）
 *  - 返回新 Session：startedAt/endedAt 设为窗口边界，turns 为窗口内子集
 * 供「按窗口分析」AI 模式使用：analysis 基于窗口内完整 turns，调用天然完整。
 */
export function clipSessionToWindow(session: Session, viewStart: number, viewEnd: number): Session {
  const inWindow = (t: Turn): boolean => {
    if (t.userMsg && t.userMsg.ts >= viewStart && t.userMsg.ts <= viewEnd) return true
    if (t.assistantMsgs.some((a) => a.ts >= viewStart && a.ts <= viewEnd)) return true
    if (t.toolCalls.some((tc) => tc.tsStart >= viewStart && tc.tsStart <= viewEnd)) return true
    return false
  }
  // 递归裁剪子 agent 会话：startedAt/endedAt 与窗口交集，子 turns 也过滤
  const clipChild = (child: Session): Session => {
    const cStart = child.startedAt != null ? Math.max(child.startedAt, viewStart) : viewStart
    const cEnd = child.endedAt != null ? Math.min(child.endedAt, viewEnd) : viewEnd
    return clipSessionToWindow({ ...child }, cStart, cEnd)
  }

  const turns = session.turns.filter(inWindow).map((t) => ({
    ...t,
    toolCalls: t.toolCalls.map((tc) =>
      tc.childSession ? { ...tc, childSession: clipChild(tc.childSession) } : tc,
    ),
  }))
  return {
    ...session,
    startedAt: viewStart,
    endedAt: viewEnd,
    turns,
  }
}