import type { Session, ToolCall } from '../parser/types'
import { breakdownOf, sessionIntervals, type CategoryIntervals } from '../model/timeBreakdown'
import { classifyTool } from '../model/classify'

/** 类别配色（Okabe-Ito 色盲友好，引用 CSS 变量以便随明/暗主题切换）。 */
export const CATEGORY_COLORS = {
  waitUser: 'var(--cat-wait)',
  direct: 'var(--cat-direct)',
  delegated: 'var(--cat-delegated)',
  compute: 'var(--cat-compute)',
}

export interface Segment {
  start: number
  end: number
  color: string
}

export type NodeKind = 'root' | 'waitUser' | 'localTool' | 'direct' | 'toolBucket' | 'delegated' | 'agent' | 'compute'

export interface TreeNode {
  id: string
  kind: NodeKind
  label: string
  ms: number
  /** 归一基准（顶层会话总耗时），用于占比/横条。 */
  wallMs: number
  /** 主色（占比横条用）。 */
  color: string
  count?: number
  children?: TreeNode[]
  /** Agent 节点：有 childSession 时可展开（递归）。 */
  expandable?: boolean
  /** toolBucket 详情：桶内的调用。 */
  calls?: ToolCall[]
  /** agent 节点详情：对应的 Agent 调用。 */
  call?: ToolCall
  /** agent 节点：展开用的子会话。 */
  childSession?: Session
  /** 甘特时段（绝对 ts，渲染按 root 总耗时归一）。 */
  segments?: Segment[]
}

const seg = (iv: { start: number; end: number }, color: string): Segment => ({ start: iv.start, end: iv.end, color })

/** Agent 调用的"实际运行区间"：优先子 agent 总耗时（异步后台的真实时长），否则父侧调度区间。 */
function childWallOf(tc: ToolCall): { start: number; end: number } | null {
  const c = tc.childSession
  if (c && c.startedAt != null && c.endedAt != null) return { start: c.startedAt, end: c.endedAt }
  if (tc.tsEnd != null) return { start: tc.tsStart, end: tc.tsEnd }
  return null
}

/**
 * 把 Session 转成显示树：root → 等用户 / 本地工具(direct[Bash/other] + delegated[agent…递归]) / compute。
 * 每个节点带 主色 + 甘特 segments（总耗时区间），纯数据变换便于单测。
 */
export function buildTreeNode(session: Session): TreeNode {
  const b = breakdownOf(session)
  const ci = sessionIntervals(session)
  const wall = b.wallMs
  const gray = CATEGORY_COLORS.waitUser
  const green = CATEGORY_COLORS.compute

  return {
    id: 'root',
    kind: 'root',
    label: rootLabel(session),
    ms: wall,
    wallMs: wall,
    color: '#1F2937',
    children: [
      {
        id: 'waitUser',
        kind: 'waitUser',
        label: '等用户（轮间间隙+AskUserQuestion）',
        ms: b.waitUserMs,
        wallMs: wall,
        color: gray,
        count: allCalls(session).filter((tc) => classifyTool(tc.name) === 'wait-user').length,
        segments: ci.waitUser.map((iv) => seg(iv, gray)),
      },
      buildLocalToolNode(session, b, ci, wall),
      {
        id: 'compute',
        kind: 'compute',
        label: 'LLM(think+output)',
        ms: b.computeMs,
        wallMs: wall,
        color: green,
        segments: ci.compute.map((iv) => seg(iv, green)),
      },
    ],
  }
}

function buildLocalToolNode(session: Session, b: ReturnType<typeof breakdownOf>, ci: CategoryIntervals, wall: number): TreeNode {
  const directCalls = allCalls(session).filter((tc) => classifyTool(tc.name) === 'direct')
  const agentCalls = allCalls(session)
    .filter((tc) => classifyTool(tc.name) === 'delegated')
    .sort((a, x) => (x.durationMs ?? 0) - (a.durationMs ?? 0))

  const delegatedChildren: TreeNode[] = agentCalls.map((tc, i) => {
    const iv = childWallOf(tc)
    return {
      id: `agent-${i}`,
      kind: 'agent' as const,
      label: agentLabel(tc),
      ms: iv ? iv.end - iv.start : (tc.durationMs ?? 0),
      wallMs: wall,
      color: CATEGORY_COLORS.delegated,
      expandable: !!tc.childSession,
      call: tc,
      childSession: tc.childSession,
      segments: iv ? [seg(iv, CATEGORY_COLORS.delegated)] : undefined,
    }
  })

  return {
    id: 'localTool',
    kind: 'localTool',
    label: '本地工具',
    ms: b.localToolMs,
    wallMs: wall,
    color: '#374151',
    segments: [
      ...ci.direct.map((iv) => seg(iv, CATEGORY_COLORS.direct)),
      ...ci.delegated.map((iv) => seg(iv, CATEGORY_COLORS.delegated)),
    ],
    children: [
      {
        id: 'direct',
        kind: 'direct',
        label: '直接工具',
        ms: b.directMs,
        wallMs: wall,
        color: CATEGORY_COLORS.direct,
        count: directCalls.length,
        children: bucketDirect(directCalls, wall),
        segments: ci.direct.map((iv) => seg(iv, CATEGORY_COLORS.direct)),
      },
      {
        id: 'delegated',
        kind: 'delegated',
        label: '委派 Agent ★',
        ms: b.delegatedMs,
        wallMs: wall,
        color: CATEGORY_COLORS.delegated,
        count: agentCalls.length,
        children: delegatedChildren,
        segments: ci.delegated.map((iv) => seg(iv, CATEGORY_COLORS.delegated)),
      },
    ],
  }
}

/** 直接工具按名分桶：Bash 单独，其余合并为 other。 */
function bucketDirect(calls: ToolCall[], wall: number): TreeNode[] {
  const groups = new Map<string, ToolCall[]>()
  for (const tc of calls) {
    const key = tc.name === 'Bash' ? 'Bash' : 'other'
    const arr = groups.get(key) ?? []
    arr.push(tc)
    groups.set(key, arr)
  }
  return [...groups.entries()].map(([name, cs]) => ({
    id: `bucket-${name}`,
    kind: 'toolBucket' as const,
    label: name,
    ms: cs.reduce((a, tc) => a + (tc.durationMs ?? 0), 0),
    wallMs: wall,
    color: CATEGORY_COLORS.direct,
    count: cs.length,
    calls: cs,
    segments: cs.filter((tc) => tc.tsEnd != null).map((tc) => seg({ start: tc.tsStart, end: tc.tsEnd! }, CATEGORY_COLORS.direct)),
  }))
}

function agentLabel(tc: ToolCall): string {
  const sr = tc.structuredResult
  const agentType = sr?.toolName === 'Agent' ? sr.agentType : null
  const desc = sr?.toolName === 'Agent' ? sr.description : null
  if (agentType && desc) return `${agentType} · ${truncate(desc, 32)}`
  if (agentType) return agentType
  if (desc) return truncate(desc, 32)
  return tc.name
}

function rootLabel(session: Session): string {
  const sid = session.sessionId.slice(0, 8)
  const cwd = session.cwd ? lastPathSeg(session.cwd) : ''
  return cwd ? `${sid} · ${cwd}` : sid
}

function allCalls(session: Session): ToolCall[] {
  return session.turns.flatMap((t) => t.toolCalls)
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

function lastPathSeg(p: string): string {
  const segs = p.replace(/\\/g, '/').split('/')
  return segs[segs.length - 1] || p
}
