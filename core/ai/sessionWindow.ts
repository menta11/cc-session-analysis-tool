import type { Session, Turn } from '../parser/types'

/**
 * 把会话裁剪到时间窗口 [viewStart, viewEnd]：保留窗口内**完整 turns**。
 *  - turn 的 userMsg / 任意 assistantMsg / 任意 toolCall 落在窗口内 → 保留整个 turn（不裁剪 turn 内部）
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
  return {
    ...session,
    startedAt: viewStart,
    endedAt: viewEnd,
    turns: session.turns.filter(inWindow),
  }
}