/** ms → 人话时长（1h2m3s / 2m3s / 3s）。 */
export function fmtMs(ms: number): string {
  if (!ms || ms < 0) return '0s'
  const s = ms / 1000
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  return h > 0 ? `${h}h${m}m${sec}s` : m > 0 ? `${m}m${sec}s` : `${sec}s`
}

/** 部分/整体 → 整数百分比。 */
export function pct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0
}

/** 文本横条（█），按 part/whole 填充 width 格。 */
export function bar(part: number, whole: number, width = 20): string {
  if (whole <= 0) return ''
  const filled = Math.round((part / whole) * width)
  return '█'.repeat(Math.max(0, Math.min(width, filled)))
}

/** 相对当前时间的人话（刚刚 / N分钟前 / Nh前 / 昨天 / N天前 / 超一周给日期）。 */
export function fmtRelative(ms: number, now: number = Date.now()): string {
  if (!ms || ms < 0) return '-'
  const diff = now - ms
  if (diff < 0) return '刚刚'
  if (diff < 60_000) return '刚刚'
  const m = Math.floor(diff / 60_000)
  if (m < 60) return `${m}分钟前`
  const h = Math.floor(diff / 3_600_000)
  if (h < 24) return `${h}小时前`
  const d = Math.floor(diff / 86_400_000)
  if (d === 1) return '昨天'
  if (d < 7) return `${d}天前`
  const dt = new Date(ms)
  return `${dt.getMonth() + 1}-${dt.getDate()}`
}

/** 字节 → 人话（48 KB / 1.2 MB）。 */
export function fmtSize(bytes: number): string {
  if (!bytes || bytes < 0) return '-'
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${Math.round(kb)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

/** ms epoch → "MM-DD HH:mm"（本地时区，给人看的时间窗/刻度）。 */
export function fmtTs(ts: number): string {
  const d = new Date(ts)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${mm}-${dd} ${hh}:${mi}`
}

/** 时间线分桶标签：今天 / 昨天 / 本周 / 本月 / 更早（按本地自然日切天，非 24h 滚动窗口）。 */
export function timeBucketLabel(tsMs: number, nowMs: number = Date.now()): string {
  const startOfDay = (t: number): number => {
    const d = new Date(t)
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  }
  const dayDiff = Math.round((startOfDay(nowMs) - startOfDay(tsMs)) / 86_400_000)
  if (dayDiff <= 0) return '今天'
  if (dayDiff === 1) return '昨天'
  if (dayDiff < 7) return '本周'
  const ts = new Date(tsMs)
  const now = new Date(nowMs)
  if (ts.getFullYear() === now.getFullYear() && ts.getMonth() === now.getMonth()) return '本月'
  return '更早'
}

/** 会话显示标题四级降级：customTitle（用户显式命名）→ aiTitle（AI 摘要）→ 首条 user prompt（截断 40 字）→ sessionId 前 12 位 */
export function sessionDisplayTitle(s: {
  sessionId: string
  customTitle?: string | null
  aiTitle?: string | null
  userPrompt?: string | null
}): string {
  if (s.customTitle) return s.customTitle
  if (s.aiTitle) return s.aiTitle
  if (s.userPrompt) return s.userPrompt.length > 40 ? `${s.userPrompt.slice(0, 40)}…` : s.userPrompt
  return `${s.sessionId.slice(0, 12)}…`
}
