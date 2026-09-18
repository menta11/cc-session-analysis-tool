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

/** ms epoch → "HH:MM:SS.mmm"（本地时区，日志表的时刻列）。 */
export function fmtClock(ts: number): string {
  const d = new Date(ts)
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

export const MS_PER_SECOND = 1000
export const MS_PER_MINUTE = 60 * MS_PER_SECOND

/**
 * 单条记录的耗时量级：毫秒级 / 秒级 / 分钟级（含小时，一小时也还是「分钟级往上」）。
 *
 * 与 `fmtDuration` 共用同一组边界，颜色档位才与印出来的单位一致 —— 这是两处唯一的真相，
 * 谁都不许自己写 1000 / 60000。
 */
export type DurationScale = 'ms' | 's' | 'm'

export function durationScale(ms: number): DurationScale {
  if (!ms || ms < MS_PER_SECOND) return 'ms'
  return ms < MS_PER_MINUTE ? 's' : 'm'
}

/** 一个单位等于多少毫秒（筛选阈值换算是它唯一的用武之地）。 */
export function unitToMs(unit: DurationScale): number {
  return unit === 'ms' ? 1 : unit === 's' ? MS_PER_SECOND : MS_PER_MINUTE
}

/**
 * 单条记录的耗时：亚秒给 ms、秒级给两位小数、十几秒给一位小数、更长走 fmtMs。
 *
 * 与 `fmtMs` 分工不同：`fmtMs` 表达「一段总耗时的量级」（1h2m3s 够了），这里表达
 * 「这一条比那一条慢多少」，亚秒的差别必须看得见，所以秒级以下不取整。
 */
export function fmtDuration(ms: number): string {
  if (!ms || ms < 0) return '0ms'
  if (ms < MS_PER_SECOND) return `${Math.round(ms)}ms`
  const s = ms / MS_PER_SECOND
  // 分档按**取整后**的值判：9.999s 的两位小数写法是 "10.00s"，那已经该按一位小数表达了，
  // 否则同一个数会同时出现 "10.00s" 与 "10.1s" 两种粒度
  const two = s.toFixed(2)
  if (Number(two) < 10) return `${two}s`
  // 59.95 = 一位小数的进位边界：59.96 写出来是 "60.0s"，那已经不是秒级的样子了（同上面那条注释）
  if (s < 59.95) return `${s.toFixed(1)}s`
  return fmtMs(ms)
}

/** token 数 → 紧凑写法（1.2k / 340 / 1.4M）。 */
export function fmtTokens(n: number): string {
  if (!n || n < 0) return '0'
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** 部分/整体 → 一位小数百分比（8.3%）—— 占比条与列都按它对齐。 */
export function fmtPct1(part: number, whole: number): string {
  return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '0.0%'
}

/**
 * 模型名收短：去掉日期后缀（`claude-sonnet-4-5-20250929` → `claude-sonnet-4-5`）。
 * 日期对「这一步是谁在跑」没有信息量，却吃掉三分之一列宽。
 */
export function shortModel(model: string | null | undefined): string {
  return (model ?? '').replace(/-20\d{6}$/, '')
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
/** 标题取用顺序：用户改名 > AI 摘要 > 首条提问；都没有则返回 null（由调用方决定降级成什么） */
function pickTitle(s: {
  customTitle?: string | null
  aiTitle?: string | null
  userPrompt?: string | null
}): string | null {
  if (s.customTitle) return s.customTitle
  if (s.aiTitle) return s.aiTitle
  if (s.userPrompt) return s.userPrompt.length > 40 ? `${s.userPrompt.slice(0, 40)}…` : s.userPrompt
  return null
}

/** 会话标题（无标题时降级成会话 ID）：用于「当前打开的是哪个会话」——那里 ID 就是身份 */
export function sessionDisplayTitle(s: {
  sessionId: string
  customTitle?: string | null
  aiTitle?: string | null
  userPrompt?: string | null
}): string {
  return pickTitle(s) ?? `${s.sessionId.slice(0, 12)}…`
}

/** 列表行标题：名称本身，还是「没有名称、拿会话 ID 顶上」的降级值 */
export interface SessionRowLabel {
  text: string
  isSessionId: boolean
}

/**
 * 列表行标题：有名称用名称，没有则降级成**完整会话 ID**。
 *
 * 为什么不留空：读不到名称的会话（user 事件全是 skill 注入 / tool_result，也没有 ai-title
 * 事件，实测 `~/.claude/projects/D--workspace-test/` 7 条里 6 条如此）**是数据的真实状态**，
 * 但留空会让这一行没有身份 —— 副标题只有时间与大小，同一秒写入的多条会话无法区分，搜索框
 * 按 ID 筛出来也对不上是哪条。
 *
 * 为什么返回结构而不是只返回文案：调用方要按「是名称还是 ID」换排版（ID 是 36 字符定长串，
 * 要小一号字号 + 单行省略），单独再调一次「是不是降级」会让同一判据出现两个来源。
 */
export function sessionRowLabel(s: {
  sessionId: string
  customTitle?: string | null
  aiTitle?: string | null
  userPrompt?: string | null
}): SessionRowLabel {
  const title = pickTitle(s)
  return title === null ? { text: s.sessionId, isSessionId: true } : { text: title, isSessionId: false }
}
