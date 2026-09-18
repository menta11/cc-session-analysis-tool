import type { Session, ToolCall } from '../parser/types'
import { breakdownOf, sessionIntervals, workflowSpanOf, type CategoryIntervals } from '../model/timeBreakdown'
import { classifyTool } from '../model/classify'
import { WORKFLOW_STATUS_COMPLETED } from '../parser/workflowRun'
import { clipInterval, unionDuration } from '../model/timeline'

/** 类别配色（Okabe-Ito 色盲友好，引用 CSS 变量以便随明/暗主题切换）。 */
export const CATEGORY_COLORS = {
  waitUser: 'var(--cat-wait)',
  direct: 'var(--cat-direct)',
  delegated: 'var(--cat-delegated)',
  workflow: 'var(--cat-workflow)',
  compute: 'var(--cat-compute)',
}

export interface Segment {
  start: number
  end: number
  color: string
}

export type NodeKind = 'root' | 'waitUser' | 'localTool' | 'direct' | 'toolBucket' | 'delegated' | 'agent' | 'workflow' | 'compute'

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

/**
 * 「派出去的那个东西」实际跑了的区间：workflow 用 run 记录，委派用子 agent 总耗时（异步后台的
 * 真实时长），都取不到才退回父侧调度区间。
 *
 * 导出给日志视图：委派/workflow 记录那一行的耗时必须与树/甘特同源，否则同一次运行在两处显示
 * 两个时长（父侧调度区间 vs 真实运行区间，异步场景差三个数量级）。
 */
export function childWallOf(tc: ToolCall): { start: number; end: number } | null {
  const wf = workflowSpanOf(tc)
  if (wf) return wf
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

/**
 * 把树裁剪到视图窗口 [viewStart, viewEnd]：
 *  - 节点 segments 裁剪到窗口（clipInterval），ms = 裁剪后各段并集时长
 *  - 节点 wallMs = 窗口时长（统一基准，占比/横条用）
 *  - calls（toolBucket 详情）按窗口裁剪：只保留 tsStart 落在窗口内的调用
 * 返回新树，不改原树。纯函数，可单测。
 */
export function clipTreeToWindow(tree: TreeNode, viewStart: number, viewEnd: number): TreeNode {
  const clipSegs = (segs: Segment[] | undefined): Segment[] | undefined => {
    if (!segs) return undefined
    const clipped: Segment[] = []
    for (const s of segs) {
      const c = clipInterval(s, viewStart, viewEnd)
      if (c) clipped.push({ ...c, color: s.color })
    }
    return clipped.length > 0 ? clipped : undefined
  }

  const clip = (n: TreeNode): TreeNode => {
    const hasSegs = !!n.segments
    const segs = clipSegs(n.segments)
    // 根节点无 segments，ms 语义 = 窗口总时长；其余节点 = 裁剪后段并集
    const ms = n.kind === 'root' ? viewEnd - viewStart : segs ? unionDuration(segs) : 0
    // count 重算为窗口内段数（节点原本有 segments 才重算，裁剪后为空则 0）
    const count = hasSegs && n.count != null ? (segs ? segs.length : 0) : n.count
    // calls 按窗口裁剪：tsStart 落在窗口内才保留（详情面板与统计一致）
    const calls = n.calls ? n.calls.filter((tc) => tc.tsStart >= viewStart && tc.tsStart <= viewEnd) : undefined
    return {
      ...n,
      ms,
      wallMs: viewEnd - viewStart,
      count,
      segments: segs,
      calls,
      children: n.children ? n.children.map(clip) : undefined,
    }
  }

  return clip(tree)
}

function buildLocalToolNode(session: Session, b: ReturnType<typeof breakdownOf>, ci: CategoryIntervals, wall: number): TreeNode {
  const directCalls = allCalls(session).filter((tc) => classifyTool(tc.name) === 'direct')
  const agentCalls = allCalls(session)
    .filter((tc) => classifyTool(tc.name) === 'delegated')
    .sort((a, x) => (x.durationMs ?? 0) - (a.durationMs ?? 0))
  const workflowCalls = allCalls(session)
    .filter((tc) => classifyTool(tc.name) === 'workflow')
    .sort((a, x) => (x.workflowRun?.durationMs ?? 0) - (a.workflowRun?.durationMs ?? 0))

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

  /**
   * workflow 那一支：一次调用一个节点（= 一次运行），它下面再挂这一跑的子 agent。
   *
   * 子 agent 用 `children` 而不是 `childSession`：一次运行背后是一整套（本机 3–7 个），
   * 而 `expandable`/`childSession` 那套是单数的（见 `src/components/TimeTree.tsx` 的 ChildTree）。
   * 每个子 agent 自己仍是 `expandable`，展开就是它那份分解树 —— 与钻取普通 Agent 一模一样。
   */
  const workflowChildren: TreeNode[] = workflowCalls.map((tc, i) => {
    const iv = childWallOf(tc)
    return {
      id: `workflow-${i}`,
      kind: 'workflow' as const,
      label: workflowLabel(tc),
      ms: iv ? iv.end - iv.start : (tc.durationMs ?? 0),
      wallMs: wall,
      color: CATEGORY_COLORS.workflow,
      call: tc,
      children: (tc.childSessions ?? []).map((child, j) => workflowAgentNode(child, j, wall)),
      segments: iv ? [seg(iv, CATEGORY_COLORS.workflow)] : undefined,
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
      ...ci.workflow.map((iv) => seg(iv, CATEGORY_COLORS.workflow)),
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
      {
        id: 'workflow',
        kind: 'workflow',
        label: 'workflow',
        ms: b.workflowMs,
        wallMs: wall,
        color: CATEGORY_COLORS.workflow,
        count: workflowCalls.length,
        children: workflowChildren,
        segments: ci.workflow.map((iv) => seg(iv, CATEGORY_COLORS.workflow)),
      },
    ],
  }
}

/** 一次 workflow 运行的节点名：名字 + 子 agent 个数，不正常时带上状态。 */
function workflowLabel(tc: ToolCall): string {
  const run = tc.workflowRun
  const parts = [workflowNameOf(tc)]
  if (run && run.agentCount > 0) parts.push(`${run.agentCount} 个子 agent`)
  if (run && run.status !== '' && run.status !== WORKFLOW_STATUS_COMPLETED) parts.push(run.status)
  return parts.join(' · ')
}

/** 运行的名字：优先 run 记录里的 workflowName，退回回执里那个，再退回工具名 */
function workflowNameOf(tc: ToolCall): string {
  const fromRun = tc.workflowRun?.workflowName
  if (fromRun) return fromRun
  const sr = tc.structuredResult
  const fromResult = sr !== null && sr.toolName === 'Workflow' ? sr.workflowName : null
  return fromResult || tc.name
}

/** workflow 子 agent 的节点名：它收到的第一行 prompt（workflow 派活时那就是它的任务说明）。 */
function workflowAgentNode(child: Session, i: number, wall: number): TreeNode {
  const span =
    child.startedAt != null && child.endedAt != null ? { start: child.startedAt, end: child.endedAt } : null
  return {
    id: `workflow-agent-${i}`,
    kind: 'agent',
    label: subagentLabel(child, i),
    ms: span ? span.end - span.start : 0,
    wallMs: wall,
    color: CATEGORY_COLORS.workflow,
    expandable: true,
    childSession: child,
    segments: span ? [seg(span, CATEGORY_COLORS.workflow)] : undefined,
  }
}

/**
 * 子 agent 的名字：它收到的第一行 prompt。
 *
 * workflow 给每个子 agent 派活时，第一行写的就是「你是…专家」—— meta.json 里的 `agentType`
 * （`zcode:doc-reviewer`）要额外读一个文件才拿得到，而这一行本来就在会话里。
 * 导出：树（`workflowAgentNode`）与日志视图的子表标题共用一份，免得两处各写一遍。
 */
export function subagentLabel(s: Session, i: number): string {
  const line = (s.turns.find((t) => t.userMsg != null)?.userMsg?.text ?? '').split('\n')[0].trim()
  return line === '' ? `子 agent ${i + 1}` : `#${i + 1} ${truncate(line, 32)}`
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

export interface ToolPath {
  /** 树上有这个调用的节点（工具桶，或委派它的 agent 节点） */
  node: TreeNode
  /** 从根的子节点起、逐层的下标路径 —— 展开到该节点所需的全部祖先 */
  path: number[]
}

/**
 * 在树里找「包含该 tool_use_id 的节点」及展开它所需的下标路径。
 *
 * 日志视图的「在树视图定位」用它：日志是按记录平的，树是按类别收的，同一条调用在两边
 * 位置完全不同，必须有这么一次显式换算。返回下标而不是节点 id，因为 id 只在同一棵树内唯一
 * （子 agent 展开后又是 `direct`、`bucket-Bash`），按下标走才落得准。
 */
export function findToolPath(tree: TreeNode, toolUseId: string): ToolPath | null {
  const kids = tree.children ?? []
  for (let i = 0; i < kids.length; i++) {
    const node = kids[i]
    if (node.calls?.some((tc) => tc.toolUseId === toolUseId)) return { node, path: [i] }
    if (node.call?.toolUseId === toolUseId) return { node, path: [i] }
    if (node.childSession) {
      // 子 agent 的树挂在 agent 节点下（渲染时由 ChildTree 接手），路径要接在它后面
      const inner = findToolPath(buildTreeNode(node.childSession), toolUseId)
      if (inner) return { node: inner.node, path: [i, ...inner.path] }
    }
    const deep = findToolPath(node, toolUseId)
    if (deep) return { node: deep.node, path: [i, ...deep.path] }
  }
  return null
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
