import type { Session, ToolCall, Turn } from '../parser/types'
import { breakdownOf, sessionIntervals, type CategoryIntervals } from '../model/timeBreakdown'
import { classifyTool } from '../model/classify'
import { fmtMs, pct, bar } from '../view/format'
import type { Interval } from '../model/timeline'
import { unionDuration } from '../model/timeline'

/** 节点诊断时传入：父会话中调度该子 agent 的 ToolCall（用于父子时间对账）。 */
export interface DigestOpts {
  parentAgentCall?: ToolCall | null
  /** 父会话总耗时（节点诊断时附"占父总耗时%"概览）。 */
  parentWallMs?: number | null
}

const MINUTE = 60_000

// ────────────────────────── 基础格式化 ──────────────────────────

/** 取耗时最长的 N 个调用（已配对的）。 */
function topSlow(calls: ToolCall[], n: number): ToolCall[] {
  return [...calls]
    .filter((tc) => tc.durationMs != null && tc.durationMs > 0)
    .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
    .slice(0, n)
}

function summarizeInput(tc: ToolCall): string {
  const i = tc.input ?? {}
  if (typeof i.command === 'string') return i.command.replace(/\n/g, ' ').slice(0, 160)
  if (typeof i.file_path === 'string') return i.file_path
  if (typeof i.pattern === 'string') return i.pattern
  if (typeof i.description === 'string') return i.description
  return ''
}

function fmtTokens(n: number | null | undefined): string {
  if (n == null) return ''
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

/** ms epoch → "MM-DD HH:mm"（本地时区，给人看的时间窗）。 */
function fmtTs(ts: number): string {
  const d = new Date(ts)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${mm}-${dd} ${hh}:${mi}`
}

function countSubagents(session: Session): number {
  let n = 0
  const visit = (s: Session): void => {
    for (const t of s.turns) {
      for (const tc of t.toolCalls) {
        if (tc.childSession) {
          n += 1
          visit(tc.childSession)
        }
      }
    }
  }
  visit(session)
  return n
}

/** 子 agent 实际总耗时：优先 childSession，回退父侧 durationMs。 */
function agentWall(tc: ToolCall): number {
  const child = tc.childSession
  if (child?.startedAt != null && child?.endedAt != null) return child.endedAt - child.startedAt
  return tc.durationMs ?? 0
}

/** 调用异常标志（卡住/超时/错误/挂起）。 */
function callFlags(tc: ToolCall): string {
  const f: string[] = []
  const sr = tc.structuredResult
  if (sr?.toolName === 'Bash') {
    if (sr.interrupted) f.push('interrupted')
    if (sr.timedOutAfterMs != null) f.push(`timeout ${fmtMs(sr.timedOutAfterMs)}`)
  }
  if (tc.isError) f.push('error')
  if (tc.tsEnd == null) f.push('UNPAIRED')
  return f.length ? ` [${f.join(',')}]` : ''
}

// ────────────────────────── 区间/分桶工具 ──────────────────────────

/** 区间集合裁剪到 [lo, hi]（用于分桶求各类覆盖）。 */
function clipToIntervals(intervals: Interval[], lo: number, hi: number): Interval[] {
  const out: Interval[] = []
  for (const iv of intervals) {
    const s = Math.max(iv.start, lo)
    const e = Math.min(iv.end, hi)
    if (e > s) out.push({ start: s, end: e })
  }
  return out
}

interface Bucket {
  lo: number
  hi: number
  waitUser: number
  localTool: number
  compute: number
  total: number
}

/** 时序分桶（阶段划分底料）：总耗时等分 N 段，每段各类 unionDuration。自适应段数 5–40。 */
function timeBuckets(session: Session, ci: CategoryIntervals): Bucket[] {
  const start = session.startedAt
  const end = session.endedAt
  if (start == null || end == null || end <= start) return []
  const wall = end - start
  const count = Math.max(5, Math.min(40, Math.round(wall / (30 * MINUTE))))
  const segLen = wall / count
  const out: Bucket[] = []
  for (let i = 0; i < count; i++) {
    const lo = Math.round(start + i * segLen)
    const hi = i === count - 1 ? end : Math.round(start + (i + 1) * segLen)
    const direct = clipToIntervals(ci.direct, lo, hi)
    const delegated = clipToIntervals(ci.delegated, lo, hi)
    out.push({
      lo,
      hi,
      waitUser: unionDuration(clipToIntervals(ci.waitUser, lo, hi)),
      localTool: unionDuration([...direct, ...delegated]),
      compute: unionDuration(clipToIntervals(ci.compute, lo, hi)),
      total: hi - lo,
    })
  }
  return out
}

/** 轮间间隙（带轮次位置）：turn N 最后活动 → turn N+1 用户输入。 */
function turnGaps(session: Session): { from: number; to: number; gapMs: number; start: number; end: number }[] {
  const out: { from: number; to: number; gapMs: number; start: number; end: number }[] = []
  for (let i = 0; i + 1 < session.turns.length; i++) {
    const next = session.turns[i + 1]
    if (next.userMsg == null) continue
    const lastAct = lastActivityMs(session.turns[i])
    if (lastAct == null) continue
    if (next.userMsg.ts > lastAct) {
      out.push({ from: i + 1, to: i + 2, gapMs: next.userMsg.ts - lastAct, start: lastAct, end: next.userMsg.ts })
    }
  }
  return out
}

function lastActivityMs(turn: Turn): number | null {
  let max: number | null = null
  for (const a of turn.assistantMsgs) if (max == null || a.ts > max) max = a.ts
  for (const tc of turn.toolCalls) if (tc.tsEnd != null && (max == null || tc.tsEnd > max)) max = tc.tsEnd
  return max
}

/** 重复 input 分组（指纹 = name + 关键输入），返回 top 5（count>1）。 */
function repeatGroups(calls: ToolCall[]): { label: string; count: number; allError: boolean }[] {
  const map = new Map<string, { label: string; count: number; err: number }>()
  for (const tc of calls) {
    const label = `${tc.name}: ${summarizeInput(tc) || '(无输入)'}`
    const e = map.get(label) ?? { label, count: 0, err: 0 }
    e.count++
    if (tc.isError) e.err++
    map.set(label, e)
  }
  return [...map.values()]
    .filter((g) => g.count > 1)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((g) => ({ label: g.label, count: g.count, allError: g.err === g.count }))
}

/** delegated 区间峰值并行度 + 首次达到峰值的时段。 */
function peakParallel(intervals: Interval[]): { count: number; window: Interval | null } {
  const evts: { t: number; d: number }[] = []
  for (const iv of intervals) {
    if (iv.end > iv.start) {
      evts.push({ t: iv.start, d: 1 })
      evts.push({ t: iv.end, d: -1 })
    }
  }
  if (evts.length === 0) return { count: 0, window: null }
  // 同一时刻先处理结束(-1)再处理开始(+1)：相邻不重叠不计数
  evts.sort((a, b) => (a.t - b.t) || (a.d - b.d))
  let cur = 0
  let max = 0
  let maxStart: number | null = null
  let maxEnd: number | null = null
  for (const e of evts) {
    const prev = cur
    cur += e.d
    if (cur > max) {
      max = cur
      maxStart = e.t
      maxEnd = null
    } else if (maxEnd === null && prev === max && cur < max && maxStart !== null) {
      maxEnd = e.t
    }
  }
  if (maxEnd === null) maxEnd = evts[evts.length - 1].t
  const window = maxStart !== null && maxEnd !== null && maxEnd > maxStart ? { start: maxStart, end: maxEnd } : null
  return { count: max, window }
}

/** 会话 token：子 agent 优先父侧 structuredResult.totalTokens；否则累加 usage。 */
function sessionTokens(session: Session, opts: DigestOpts): number | null {
  const sr = opts.parentAgentCall?.structuredResult
  if (sr?.toolName === 'Agent' && sr.totalTokens != null) return sr.totalTokens
  let sum = 0
  let any = false
  for (const t of session.turns) {
    for (const a of t.assistantMsgs) {
      const u = a.usage
      if (u) {
        sum += (u.input ?? 0) + (u.output ?? 0)
        any = true
      }
    }
  }
  return any ? sum : null
}

// ────────────────────────── 诊断事实（对任意 Session） ──────────────────────────

/** 诊断事实段：只摆事实，不挂模式标签。模式降到模板参考附录。 */
export function buildDiagnosticFacts(session: Session, opts: DigestOpts = {}): string {
  const b = breakdownOf(session)
  const all = session.turns.flatMap((t) => t.toolCalls)
  const lines: string[] = []
  lines.push('## 诊断事实')

  lines.push('- 显著慢调用 top 5:')
  const slow = topSlow(all, 5)
  if (slow.length === 0) lines.push('  (无已配对调用)')
  for (const tc of slow) {
    lines.push(
      `  - ${tc.toolUseId.slice(0, 8)} ${tc.name} ${fmtMs(tc.durationMs ?? 0)}: ${summarizeInput(tc) || '(无输入)'}${callFlags(tc)}`,
    )
  }

  lines.push('- 重复模式 top 5:')
  const reps = repeatGroups(all)
  if (reps.length === 0) lines.push('  (无重复)')
  for (const r of reps) lines.push(`  - ${r.label} ×${r.count}${r.allError ? ' (全失败)' : ''}`)

  const unpaired = session.unmatchedToolUses.filter((b2) => b2.type === 'tool_use')
  lines.push(`- 未配对 tool_use: ${unpaired.length} 个`)
  if (unpaired.length) {
    lines.push(`  (${unpaired.slice(0, 5).map((b2) => (b2.type === 'tool_use' ? b2.id : '')).filter(Boolean).join(', ')})`)
  }

  if (opts.parentAgentCall) {
    const p = opts.parentAgentCall
    const pDur = p.durationMs ?? (p.tsEnd != null ? p.tsEnd - p.tsStart : null)
    const psr = p.structuredResult?.toolName === 'Agent' ? p.structuredResult : null
    const mode = psr?.isAsync ? 'async' : 'sync'
    const gap = pDur != null ? pDur - b.wallMs : null
    lines.push(
      `- 父子对账: 父调度 ${pDur != null ? fmtMs(pDur) : '?'} / 子实际 ${fmtMs(b.wallMs)} / 缺口 ${gap != null ? fmtMs(gap) : '?'} (${mode})`,
    )
  }

  const tok = sessionTokens(session, opts)
  lines.push(
    `- 体量: 步数 ${session.turns.length}${tok != null ? ` / token ${fmtTokens(tok)}` : ''} / 模型思考 ${fmtMs(b.computeMs)} / 本地工具 ${fmtMs(b.localToolMs)}`,
  )
  return lines.join('\n')
}

// ────────────────────────── 厚摘要（统一，对任意 Session） ──────────────────────────

/** 把 agent 运行耗时分解格式化为 markdown 摘要（喂给 claude 分析用）。 */
export function buildDigest(session: Session, opts: DigestOpts = {}): string {
  const b = breakdownOf(session)
  const ci = sessionIntervals(session)
  const all = session.turns.flatMap((t) => t.toolCalls)
  const direct = all.filter((tc) => classifyTool(tc.name) === 'direct')
  const agents = all.filter((tc) => classifyTool(tc.name) === 'delegated')
  const pp = (x: number): string => `${pct(x, b.wallMs)}%`

  const lines: string[] = []
  lines.push('# Agent 运行耗时摘要')
  lines.push(
    `- 总耗时 ${fmtMs(b.wallMs)} | 轮次 ${session.turns.length} | 子agent ${countSubagents(session)} | isSubagent=${session.isSubagent}`,
  )
  if (opts.parentWallMs != null && opts.parentWallMs > 0) {
    lines.push(`- 占父总耗时 ${pct(b.wallMs, opts.parentWallMs)}% ${bar(b.wallMs, opts.parentWallMs, 10)}`)
  }
  lines.push(`- 等用户 ${fmtMs(b.waitUserMs)} (${pp(b.waitUserMs)}) ${bar(b.waitUserMs, b.wallMs, 10)}`)
  lines.push(
    `- 本地工具 ${fmtMs(b.localToolMs)} (${pp(b.localToolMs)}) ${bar(b.localToolMs, b.wallMs, 10)} — 直接 ${fmtMs(b.directMs)} / 委派子agent ${fmtMs(b.delegatedMs)}`,
  )
  lines.push(`- 模型思考 ${fmtMs(b.computeMs)} (${pp(b.computeMs)}) ${bar(b.computeMs, b.wallMs, 10)}`)
  lines.push('')

  // 时序分桶（阶段底料）
  const buckets = timeBuckets(session, ci)
  if (buckets.length) {
    lines.push('## 时序分桶（阶段划分底料）')
    lines.push('| 段 | 时间窗 | 等用户 | 本地工具 | 模型思考 | 段合计 |')
    lines.push('|---|---|---|---|---|---|')
    buckets.forEach((bk, i) => {
      lines.push(
        `| ${i + 1} | ${fmtTs(bk.lo)}~${fmtTs(bk.hi)} | ${fmtMs(bk.waitUser)} | ${fmtMs(bk.localTool)} | ${fmtMs(bk.compute)} | ${fmtMs(bk.total)} |`,
      )
    })
    lines.push('')
  }

  // 轮间间隙 top 5（子 agent 单 prompt，无等用户，跳过）
  if (!session.isSubagent) {
    const gaps = turnGaps(session).sort((a, b2) => b2.gapMs - a.gapMs).slice(0, 5)
    if (gaps.length) {
      lines.push('## 轮间间隙 top 5')
      for (const g of gaps) lines.push(`- 第 ${g.from}→${g.to} 轮: ${fmtMs(g.gapMs)} (${fmtTs(g.start)}~${fmtTs(g.end)})`)
      lines.push('')
    }
  }

  // 错误汇总
  const errCalls = all.filter((tc) => tc.isError)
  if (errCalls.length) {
    const errMs = errCalls.reduce((s, tc) => s + (tc.durationMs ?? 0), 0)
    const byName = new Map<string, number>()
    for (const tc of errCalls) byName.set(tc.name, (byName.get(tc.name) ?? 0) + 1)
    lines.push('## 错误汇总')
    lines.push(`- 错误调用 ${errCalls.length} 次 / 错误耗时 ${fmtMs(errMs)} (${pp(errMs)})`)
    lines.push(`- 按工具: ${[...byName.entries()].map(([n, c]) => `${n} ×${c}`).join(' / ') || '无'}`)
    const failedAgents = agents
      .filter((tc) => tc.isError)
      .sort((a, b2) => agentWall(b2) - agentWall(a))
      .slice(0, 3)
    if (failedAgents.length) {
      lines.push(
        `- 失败子agent top 3: ${failedAgents
          .map((tc) => {
            const sr = tc.structuredResult?.toolName === 'Agent' ? tc.structuredResult : null
            return `${sr?.agentType ?? 'agent'} ${fmtMs(agentWall(tc))}`
          })
          .join(' / ')}`,
      )
    }
    lines.push('')
  }

  // 诊断事实
  lines.push(buildDiagnosticFacts(session, opts))
  lines.push('')

  // 最慢直接工具 top 10
  lines.push('## 最慢直接工具 top 10')
  const slowDirect = topSlow(direct, 10)
  if (slowDirect.length === 0) lines.push('(无)')
  for (const tc of slowDirect) {
    lines.push(`- ${tc.name} ${fmtMs(tc.durationMs ?? 0)}${callFlags(tc)}: ${summarizeInput(tc) || '(无输入)'}`)
  }
  lines.push('')

  // 子 agent 全量表（按耗时降序；>30 截断 + 按类型聚合）
  if (agents.length) {
    lines.push('## 子agent 全量表（按耗时降序）')
    const sorted = [...agents].sort((a, b2) => agentWall(b2) - agentWall(a))
    for (const tc of sorted.slice(0, 30)) lines.push(subagentRow(tc, b.wallMs))
    const rest = sorted.slice(30)
    if (rest.length) {
      const byType = new Map<string, number>()
      for (const tc of rest) {
        const sr = tc.structuredResult?.toolName === 'Agent' ? tc.structuredResult : null
        const t = sr?.agentType ?? 'agent'
        byType.set(t, (byType.get(t) ?? 0) + 1)
      }
      lines.push(
        `- (其余 ${rest.length} 个按类型聚合: ${[...byType.entries()].map(([t, c]) => `${t} ×${c}`).join(' / ')})`,
      )
    }
    lines.push('')
  }

  // 并行度
  if (ci.delegated.length) {
    const pk = peakParallel(ci.delegated)
    lines.push('## 并行度')
    if (pk.count > 1 && pk.window) {
      lines.push(`- 峰值同时活跃子 agent ${pk.count}（${fmtTs(pk.window.start)}~${fmtTs(pk.window.end)}）`)
    } else {
      lines.push(`- 峰值同时活跃子 agent ${pk.count}（无并行）`)
    }
  }

  return lines.join('\n')
}

function subagentRow(tc: ToolCall, parentWall: number): string {
  const sr = tc.structuredResult?.toolName === 'Agent' ? tc.structuredResult : null
  const wall = agentWall(tc)
  const pctStr = parentWall > 0 ? ` (${Math.round((wall / parentWall) * 100)}%)` : ''
  const barStr = parentWall > 0 ? ` ${bar(wall, parentWall, 10)}` : ''
  const tok = fmtTokens(sr?.totalTokens)
  const fail = tc.isError ? ' ✗' : ''
  return `- ${sr?.agentType ?? 'agent'} "${(sr?.description ?? summarizeInput(tc)) || ''}" ${fmtMs(wall)}${pctStr}${barStr}${fail}${tok ? ` tok=${tok}` : ''} agentId=${sr?.agentId ?? tc.toolUseId}`
}

// ────────────────────────── 文件地图（标注排序 + 取证入口） ──────────────────────────

export interface FileMeta {
  lines?: number
  sizeBytes?: number
}

export interface FileMapOpts {
  /** relOf 的基准 = 会话所在目录（projects/<sanitized-cwd>/），主/子文件相对它显示。 */
  projectsRoot: string
  /** 主 transcript 绝对路径；空串 = 未找到（node 模式 agentId 缺失时）。 */
  mainFilePath: string
  /** agentId → 子 transcript 绝对路径（来自 buildAgentIndex，覆盖本会话所有后代）。 */
  agentIndex: Map<string, string>
  /** 可选：由调用方注入的文件元信息（行数/体积）；core 不直接读 fs。 */
  fileMeta?: (absPath: string) => FileMeta | null
}

interface AgentIv {
  start: number
  end: number
  agentIdRaw: string | null
  agentType: string
  desc: string
  wall: number
  isError: boolean
  parentTurn: number
  parentToolUseId: string
  isAsync: boolean
  child: Session | undefined
}

/** 收集 session 的直接委派调用为带标注的 agent 区间（用于文件地图 + 并行组）。 */
function collectAgentIvs(session: Session): AgentIv[] {
  const out: AgentIv[] = []
  for (const turn of session.turns) {
    for (const tc of turn.toolCalls) {
      if (classifyTool(tc.name) !== 'delegated') continue
      const sr = tc.structuredResult?.toolName === 'Agent' ? tc.structuredResult : null
      const child = tc.childSession
      const start = child?.startedAt ?? tc.tsStart
      const end = child?.endedAt ?? tc.tsEnd
      if (start == null || end == null) continue
      out.push({
        start,
        end,
        agentIdRaw: sr?.agentId ?? null,
        agentType: sr?.agentType ?? 'agent',
        desc: sr?.description ?? summarizeInput(tc),
        wall: agentWall(tc),
        isError: tc.isError,
        parentTurn: turn.index,
        parentToolUseId: tc.toolUseId,
        isAsync: sr?.isAsync ?? false,
        child,
      })
    }
  }
  return out
}

/** 时间重叠簇（合并区间法；count≥2 才算并行组）。 */
function parallelGroups(ivs: AgentIv[]): { agentIds: string[]; window: Interval; count: number }[] {
  const sorted = [...ivs].filter((i) => i.end > i.start).sort((a, b) => a.start - b.start)
  const groups: { agentIds: string[]; start: number; end: number }[] = []
  for (const iv of sorted) {
    const last = groups[groups.length - 1]
    const id = iv.agentIdRaw ?? iv.parentToolUseId
    if (last && iv.start < last.end) {
      last.end = Math.max(last.end, iv.end)
      if (!last.agentIds.includes(id)) last.agentIds.push(id)
    } else {
      groups.push({ agentIds: [id], start: iv.start, end: iv.end })
    }
  }
  return groups
    .filter((g) => g.agentIds.length >= 2)
    .map((g) => ({ agentIds: g.agentIds, window: { start: g.start, end: g.end }, count: g.agentIds.length }))
    .sort((a, b) => b.count - a.count || (b.window.end - b.window.start) - (a.window.end - a.window.start))
    .slice(0, 5)
}

function fmtSize(bytes?: number): string {
  if (bytes == null) return ''
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)}MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`
  return `${bytes}B`
}

/** 相对路径（纯字符串；不依赖 node:path，渲染层可用）。归一分隔符后去 root 前缀。 */
function relOf(absPath: string, root: string): string {
  const a = absPath.replace(/\\/g, '/')
  const r = root.replace(/\\/g, '/')
  if (r && a.startsWith(r)) return a.slice(r.length).replace(/^\//, '')
  return a
}

/** 子内最慢调用 + 重复指纹（深挖线索）。 */
function childHints(child: Session | undefined): { slowId: string; slowName: string; slowMs: number; repLabel: string; repCount: number } | null {
  if (!child) return null
  const all = child.turns.flatMap((t) => t.toolCalls)
  const slow = topSlow(all, 1)[0]
  const rep = repeatGroups(all)[0]
  return {
    slowId: slow ? slow.toolUseId.slice(0, 8) : '-',
    slowName: slow?.name ?? '-',
    slowMs: slow?.durationMs ?? 0,
    repLabel: rep?.label ?? '-',
    repCount: rep?.count ?? 0,
  }
}

/**
 * 构建给 claude 的标注排序文件地图（取证用）。
 * 全量紧凑列路径（claude 按需 Read）；rich 标注（父位置/子内最慢/重复）只给 top 5 慢子agent。
 */
export function buildFileMap(session: Session, opts: FileMapOpts): string {
  const b = breakdownOf(session)
  const ivs = collectAgentIvs(session).sort((a, b2) => b2.wall - a.wall)
  const lines: string[] = []
  lines.push('# 文件地图（claude 可按需 Read 深挖；勿整文件读，按 toolUseId grep 定位行）')
  lines.push(`projectsRoot = ${opts.projectsRoot}`)
  lines.push('')

  // 主文件
  const meta = opts.fileMeta?.(opts.mainFilePath) ?? null
  const metaParts = [meta?.lines != null ? `${meta.lines} 行` : '', fmtSize(meta?.sizeBytes)].filter(Boolean)
  const mainRel = opts.mainFilePath ? relOf(opts.mainFilePath, opts.projectsRoot) : '(未找到文件)'
  lines.push('## 主文件')
  lines.push(`- ${mainRel}${metaParts.length ? `（${metaParts.join(' / ')}）` : ''}`)
  lines.push('')

  // 子agent 文件全量（紧凑：路径优先，claude 按需 Read）
  if (ivs.length) {
    lines.push('## 子agent 文件（按耗时降序，全量）')
    for (const iv of ivs) {
      const found = iv.agentIdRaw ? opts.agentIndex.get(iv.agentIdRaw) : undefined
      const p = found ? relOf(found, opts.projectsRoot) : '(未找到文件)'
      const pp = b.wallMs > 0 ? ` (${Math.round((iv.wall / b.wallMs) * 100)}%)` : ''
      const fail = iv.isError ? ' ✗' : ''
      const idDisp = iv.agentIdRaw ?? iv.parentToolUseId
      lines.push(`- ${iv.agentType} ${fmtMs(iv.wall)}${pp}${fail} agentId=${idDisp} → ${p}`)
    }
    lines.push('')
  }

  // 深挖线索（top 5 慢子agent：父位置 + 子内最慢/重复指纹）
  const top5 = ivs.slice(0, 5)
  if (top5.length) {
    lines.push('## 深挖线索（top 5 慢子agent）')
    for (const iv of top5) {
      const found = iv.agentIdRaw ? opts.agentIndex.get(iv.agentIdRaw) : undefined
      const p = found ? relOf(found, opts.projectsRoot) : '(未找到文件)'
      const idDisp = iv.agentIdRaw ?? iv.parentToolUseId
      lines.push(`- ${iv.agentType} "${iv.desc || ''}" agentId=${idDisp} → ${p}`)
      lines.push(`    父调用: turn ${iv.parentTurn} / toolUseId=${iv.parentToolUseId.slice(0, 8)} / ${iv.isAsync ? 'async' : 'sync'}`)
      const h = childHints(iv.child)
      if (h) {
        lines.push(`    子内最慢: ${h.slowId} ${h.slowName} ${fmtMs(h.slowMs)}`)
        if (h.repCount > 1) lines.push(`    子内重复: ${h.repLabel} ×${h.repCount}`)
      }
    }
    lines.push('')
  }

  // 并行组
  const groups = parallelGroups(ivs)
  if (groups.length) {
    lines.push('## 并行组（时间重叠簇，count≥2）')
    for (const g of groups) {
      lines.push(`- [${fmtTs(g.window.start)}~${fmtTs(g.window.end)}] ${g.count} 个: ${g.agentIds.join(', ')}`)
    }
  }

  return lines.join('\n')
}

