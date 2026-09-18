import { useEffect, useRef, useState } from 'react'
import type { Session } from '../../core/parser/types'
import { buildTreeNode, clipTreeToWindow, type Segment, type TreeNode } from '../../core/view/treeView'
import { clampWindow, dragWindowEdge, snapToSegmentBoundary, type ViewWindow } from '../../core/view/window'
import { fmtMs, fmtTs, pct } from '../../core/view/format'
import { Chevron } from './icons'

/** 复制文本到剪贴板，返回是否成功（WebView 支持 navigator.clipboard） */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** 收集树中所有甘特段的边界（排序去重），供滑块吸附。 */
function allSegmentBoundaries(tree: TreeNode): number[] {
  const set = new Set<number>()
  const walk = (n: TreeNode): void => {
    for (const s of n.segments ?? []) {
      set.add(s.start)
      set.add(s.end)
    }
    for (const c of n.children ?? []) walk(c)
  }
  walk(tree)
  return [...set].sort((a, b) => a - b)
}

/** 只保留落在 [lo, hi] 内的边界（滑块吸附用「可视区内」的边界）。 */
function boundariesInRange(boundaries: number[], lo: number, hi: number): number[] {
  return boundaries.filter((b) => b >= lo && b <= hi)
}

const GANTT_W = 320
const GANTT_MIN = 200
const GANTT_MAX = 720
const COL_BAR = 96
const COL_DUR = 64
const COL_PCT = 48
const CHEVRON = 16
const GRID_BG = 'linear-gradient(to right, var(--border-subtle) 1px, transparent 1px)'
const MIN_WINDOW = 1000 // 最小窗口 1s

export function TimeTree(props: {
  session: Session
  onSelect: (n: TreeNode) => void
  selectedId?: string
  viewWindow?: ViewWindow | null
  onWindowChange?: (w: ViewWindow) => void
  /**
   * 逐层下标的「初始展开路径」（由 `findToolPath` 算好）。
   *
   * 只作**初始**状态用：`open` 仍是各行自己的 state，用户随时能收起 —— 否则「定位」会把
   * 沿途节点钉死成常开。它由日志视图的「在树视图定位」设置，那时的树是刚挂载的（日志视图
   * 与树视图互斥渲染），初始 state 正好吃到这份路径。
   */
  revealPath?: number[]
}): JSX.Element {
  const fullTree = buildTreeNode(props.session)
  const rootStart = props.session.startedAt ?? 0
  const rootEnd = props.session.endedAt ?? 0
  const rootWall = Math.max(1, rootEnd - rootStart)
  const allBoundaries = allSegmentBoundaries(fullTree)

  // 滑块窗口（分析范围）：只影响统计，不影响甘特渲染
  const effectiveWindow: ViewWindow = props.viewWindow ?? { start: rootStart, end: rootEnd }
  const win = clampWindow(effectiveWindow, rootStart, rootEnd, MIN_WINDOW)
  const winDuration = Math.max(1, win.end - win.start)
  // 窗口裁剪树（统计用：ms/count/占比）
  const statTree = clipTreeToWindow(fullTree, win.start, win.end)

  const [ganttW, setGanttW] = useState(GANTT_W)
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)

  // ── 可视区（锚定全会话时间轴，独立于窗口）──
  // visStartTs = 可视区起点（绝对 ts）；pxPerMs = 缩放密度
  // 可视区时间范围 = [visStartTs, visStartTs + ganttW/pxPerMs]
  const [pxPerMs, setPxPerMs] = useState(() => ganttW / rootWall)
  const [visStartTs, setVisStartTs] = useState(rootStart)
  // 会话范围限制可视区
  const visSpan = ganttW / Math.max(pxPerMs, 1e-9)
  const clampedVisStart = Math.min(rootEnd - visSpan, Math.max(rootStart, visStartTs))
  const visEndTs = clampedVisStart + visSpan
  const visDuration = Math.max(1, visEndTs - clampedVisStart)

  // 滑块相对可视区的像素位置（clamp 到轨道内，跑出可视区则卡边缘）
  const sliderPx = (ts: number): number => {
    const px = ((ts - clampedVisStart) / visDuration) * ganttW
    return Math.min(ganttW, Math.max(0, px))
  }
  const startPx = sliderPx(win.start)
  const endPx = sliderPx(win.end)
  // 高亮条 = 窗口 ∩ 可视区（左侧/右侧裁切）
  const hlLeft = Math.max(0, ((win.start - clampedVisStart) / visDuration) * ganttW)
  const hlRight = Math.min(ganttW, ((win.end - clampedVisStart) / visDuration) * ganttW)
  const hlWidth = Math.max(0, hlRight - hlLeft)

  // 会话切换（rootStart/rootEnd 变化）时重置可视区
  useEffect(() => {
    setPxPerMs(ganttW / rootWall)
    setVisStartTs(rootStart)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootStart, rootEnd])

  // ctrl+滚轮缩放：以鼠标焦点为锚点
  const onWheel = (e: React.WheelEvent): void => {
    if (!e.ctrlKey) return
    e.preventDefault()
    const el = ganttTrackRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const xInVis = Math.min(ganttW, Math.max(0, e.clientX - rect.left))
    const anchorTs = clampedVisStart + (xInVis / ganttW) * visDuration
    const factor = e.deltaY < 0 ? 1.25 : 1 / 1.25
    const next = Math.max(ganttW / rootWall, pxPerMs * factor) // 下限 = 全会话满宽
    // 锚点时间像素位置不变
    const anchorPx = (anchorTs - rootStart) * next
    const newVisStart = rootStart + (anchorPx - xInVis) / next
    setPxPerMs(next)
    setVisStartTs(Math.min(rootEnd - ganttW / next, Math.max(rootStart, newVisStart)))
  }

  const ganttTrackRef = useRef<HTMLDivElement>(null)

  // ── 滚动条：全会话内平移可视区 ──
  const scrollbarRef = useRef<HTMLDivElement>(null)
  const scrollbarDragRef = useRef<{ startX: number; startVis: number } | null>(null)
  const onScrollbarDown = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    scrollbarDragRef.current = { startX: e.clientX, startVis: clampedVisStart }
    const mm = (ev: MouseEvent): void => {
      const d = scrollbarDragRef.current
      const el = scrollbarRef.current
      if (!d || !el) return
      const rect = el.getBoundingClientRect()
      const dx = ev.clientX - d.startX
      const ratio = dx / rect.width
      setVisStartTs(Math.min(rootEnd - visSpan, Math.max(rootStart, d.startVis + ratio * rootWall)))
    }
    const up = (): void => {
      scrollbarDragRef.current = null
      window.removeEventListener('mousemove', mm)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', mm)
    window.addEventListener('mouseup', up)
  }

  // ── 滑块：限定分析窗口（离散段边界，吸附可视区内边界）──
  const [sliderDrag, setSliderDrag] = useState<'start' | 'end' | null>(null)
  const sliderRef = useRef<HTMLDivElement>(null)
  const sliderDragRef = useRef<{ startX: number; startTs: number; endTs: number; which: 'start' | 'end' } | null>(null)

  const onSliderDown = (e: React.MouseEvent, which: 'start' | 'end') => {
    if (!props.onWindowChange) return
    e.preventDefault()
    e.stopPropagation()
    sliderDragRef.current = { startX: e.clientX, startTs: win.start, endTs: win.end, which }
    setSliderDrag(which)
    const mm = (ev: MouseEvent): void => {
      const d = sliderDragRef.current
      const el = sliderRef.current
      if (!d || !el || !props.onWindowChange) return
      const rect = el.getBoundingClientRect()
      const ratio = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width))
      // 轨道显示可视区，拖动按可视区时间换算
      const ts = clampedVisStart + ratio * visDuration
      // 只改被拖的滑块，另一个锚定不动（不 clamp 整个窗口，避免未拖滑块被扩展）
      const next = dragWindowEdge(
        { start: d.startTs, end: d.endTs },
        d.which,
        ts,
        { start: rootStart, end: rootEnd },
        MIN_WINDOW,
      )
      d.startTs = next.start
      d.endTs = next.end
      props.onWindowChange(next)
    }
    const up = (): void => {
      const d = sliderDragRef.current
      sliderDragRef.current = null
      setSliderDrag(null)
      window.removeEventListener('mousemove', mm)
      window.removeEventListener('mouseup', up)
      if (d && props.onWindowChange) {
        // 只吸附被拖的滑块，另一个保持不动
        const local = boundariesInRange(allBoundaries, clampedVisStart, visEndTs)
        let start = d.startTs
        let end = d.endTs
        if (d.which === 'start') {
          const s = snapToSegmentBoundary(d.startTs, local)
          if (s < end) start = s // 吸附后不越过对方
        } else {
          const s = snapToSegmentBoundary(d.endTs, local)
          if (s > start) end = s
        }
        props.onWindowChange({ start, end })
      }
    }
    window.addEventListener('mousemove', mm)
    window.addEventListener('mouseup', up)
  }

  const [copiedTip, setCopiedTip] = useState<string | null>(null)
  const copiedTimerRef = useRef<number | null>(null)
  const handleCopy = (text: string, tip: string): void => {
    void copyText(text)
    setCopiedTip(tip)
    if (copiedTimerRef.current) window.clearTimeout(copiedTimerRef.current)
    copiedTimerRef.current = window.setTimeout(() => setCopiedTip(null), 1000)
  }

  const onHandleDown = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragRef.current = { startX: e.clientX, startW: ganttW }
    setDragging(true)
    const mm = (ev: MouseEvent) => {
      const d = dragRef.current
      if (!d) return
      const next = d.startW + (ev.clientX - d.startX)
      setGanttW(Math.min(GANTT_MAX, Math.max(GANTT_MIN, next)))
    }
    const up = () => {
      dragRef.current = null
      setDragging(false)
      window.removeEventListener('mousemove', mm)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', mm)
    window.addEventListener('mouseup', up)
  }

  // 刻度：可视区内均分 5 段，显示相对会话开始的偏移
  const tickPositions = [0, 0.25, 0.5, 0.75, 1]
  const tickTransform = (t: number): string => (t === 0 ? 'none' : t === 1 ? 'translateX(-100%)' : 'translateX(-50%)')

  return (
    <div
      style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-base)', color: 'var(--text)', userSelect: 'none' }}
      onWheel={onWheel}
    >
      {/* 表头：标签列 + 时长列 + 甘特刻度（sticky） */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '6px 8px',
          background: 'var(--bg-subtle)',
          borderBottom: '1px solid var(--border)',
          position: 'sticky',
          top: 0,
          zIndex: 1,
          fontWeight: 700,
        }}
      >
        <span style={{ width: CHEVRON }} />
        {/* 手型而非 `copy`：后者 macOS 画成加号（右键复制的能力不变） */}
        <span
          style={{ flex: 1, cursor: 'pointer' }}
          title={`右键复制会话 ID：${props.session.sessionId}`}
          onContextMenu={(e) => {
            e.preventDefault()
            handleCopy(props.session.sessionId, '已复制会话 ID')
          }}
        >
          {fullTree.label}
        </span>
        <span style={{ width: COL_BAR }} />
        <span style={{ width: COL_DUR, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtMs(winDuration)}</span>
        <span style={{ width: COL_PCT, textAlign: 'right', color: 'var(--text-faint)' }}>100%</span>
        <div
          className={`col-splitter${dragging ? ' is-dragging' : ''}`}
          onMouseDown={onHandleDown}
          title="拖动调整甘特图列宽"
        />
        <div
          ref={ganttTrackRef}
          style={{
            width: ganttW,
            flex: `0 0 ${ganttW}px`,
            position: 'relative',
            height: 16,
            overflow: 'hidden',
            backgroundImage: GRID_BG,
            backgroundSize: `${ganttW / 4}px 100%`,
            borderRight: '1px solid var(--border)',
          }}
        >
          {tickPositions.map((t) => (
            <span
              key={t}
              style={{
                position: 'absolute',
                left: `${t * 100}%`,
                transform: tickTransform(t),
                fontSize: 'var(--fs-xs)',
                color: 'var(--text-faint)',
                fontWeight: 400,
                whiteSpace: 'nowrap',
              }}
            >
              {fmtTs(clampedVisStart + t * visDuration)}
            </span>
          ))}
        </div>
      </div>

      {/* 双滑块：仅横跨甘特列，限定分析窗口 */}
      {props.onWindowChange ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            padding: '2px 8px',
            background: 'var(--bg-subtle)',
            borderBottom: '1px solid var(--border)',
            position: 'sticky',
            top: 26,
            zIndex: 2,
          }}
        >
          <span style={{ width: CHEVRON }} />
          <span style={{ flex: 1 }} />
          <span style={{ width: COL_BAR }} />
          <span style={{ width: COL_DUR }} />
          <span style={{ width: COL_PCT }} />
          <div ref={sliderRef} style={{ width: ganttW, flex: `0 0 ${ganttW}px`, marginLeft: 8, position: 'relative', height: 18 }}>
            <div style={{ position: 'absolute', left: 0, right: 0, top: 7, height: 4, background: 'var(--bg-active)', borderRadius: 2 }} />
            {/* 选中区间（窗口 ∩ 可视区，裁切） */}
            <div
              style={{
                position: 'absolute',
                top: 7,
                height: 4,
                background: 'var(--accent)',
                borderRadius: 2,
                left: `${hlLeft}px`,
                width: `${hlWidth}px`,
              }}
            />
            {/* 起始滑块 */}
            <div
              onMouseDown={(e) => onSliderDown(e, 'start')}
              style={{
                position: 'absolute',
                left: `${startPx}px`,
                top: 0,
                width: 8,
                height: 18,
                marginLeft: -4,
                background: sliderDrag === 'start' ? 'var(--accent)' : 'var(--accent-soft)',
                border: '1px solid var(--accent)',
                borderRadius: 4,
                cursor: 'col-resize',
              }}
              title={`分析开始 ${fmtTs(win.start)}`}
            />
            {/* 结束滑块 */}
            <div
              onMouseDown={(e) => onSliderDown(e, 'end')}
              style={{
                position: 'absolute',
                left: `${endPx}px`,
                top: 0,
                width: 8,
                height: 18,
                marginLeft: -4,
                background: sliderDrag === 'end' ? 'var(--accent)' : 'var(--accent-soft)',
                border: '1px solid var(--accent)',
                borderRadius: 4,
                cursor: 'col-resize',
              }}
              title={`分析结束 ${fmtTs(win.end)}`}
            />
          </div>
        </div>
      ) : null}

      <Legend windowLabel={props.onWindowChange ? `${fmtTs(win.start)} ~ ${fmtTs(win.end)}` : undefined} />

      {/* 水平滚动条（仅甘特列，缩放后可视区窄于全会话出现）：全会话内平移可视区 */}
      {visSpan < rootWall ? (
        <div style={{ display: 'flex', padding: '2px 8px' }}>
          <span style={{ width: CHEVRON }} />
          <span style={{ flex: 1 }} />
          <span style={{ width: COL_BAR }} />
          <span style={{ width: COL_DUR }} />
          <span style={{ width: COL_PCT }} />
          <div
            ref={scrollbarRef}
            onMouseDown={onScrollbarDown}
            style={{
              width: ganttW,
              flex: `0 0 ${ganttW}px`,
              marginLeft: 8,
              height: 12,
              background: 'var(--bg-active)',
              borderRadius: 6,
              position: 'relative',
              cursor: 'pointer',
            }}
            title="拖动平移可视区"
          >
            <div
              style={{
                position: 'absolute',
                top: 1,
                bottom: 1,
                left: `${((clampedVisStart - rootStart) / rootWall) * 100}%`,
                width: `${(visSpan / rootWall) * 100}%`,
                background: 'var(--accent-soft)',
                border: '1px solid var(--accent)',
                borderRadius: 5,
              }}
            />
          </div>
        </div>
      ) : null}

      {statTree.children!.map((c, i) => (
        <Row
          key={c.id}
          node={c}
          ganttNode={fullTree.children?.[i]}
          depth={0}
          index={i}
          revealPath={props.revealPath}
          stripe={i % 2 === 1}
          visStart={clampedVisStart}
          pxPerMs={pxPerMs}
          ganttW={ganttW}
          onSelect={props.onSelect}
          selectedId={props.selectedId}
        />
      ))}
      {copiedTip ? (
        <div style={copiedTipStyle} role="status">
          ✓ {copiedTip}
        </div>
      ) : null}
    </div>
  )
}

function Row(props: {
  node: TreeNode // 统计节点（窗口裁剪后：ms/count/占比）
  ganttNode?: TreeNode // 甘特节点（全会话原始段，甘特渲染用）
  depth: number
  /** 本行在兄弟中的下标（与 revealPath 的层号配对） */
  index: number
  revealPath?: number[]
  stripe?: boolean
  visStart: number
  pxPerMs: number
  ganttW: number
  onSelect: (n: TreeNode) => void
  selectedId?: string
}): JSX.Element {
  const { node, ganttNode, depth, index, revealPath, stripe, visStart, pxPerMs, ganttW, onSelect, selectedId } = props
  const [open, setOpen] = useState(depth < 1)
  // 定位到达时展开沿途节点。写成 effect 而不是初始 state：树在切视图时**不卸载**
  // （否则分隔条比例与滚动位置会丢），初始 state 只在首次挂载那一刻读得到路径。
  // revealPath 只在「定位」时换新数组，所以用户此后手动收起不会被它顶回来。
  useEffect(() => {
    if (revealPath?.[depth] === index) setOpen(true)
  }, [revealPath, depth, index])
  const hasKids = !!node.children?.length
  const expandable = !!node.expandable && !!node.childSession
  const branch = hasKids || expandable
  const p = pct(node.ms, node.wallMs)
  const selected = selectedId === node.id
  const cls = ['tt-row', selected ? 'tt-row-selected' : stripe ? 'tt-row-stripe' : ''].filter(Boolean).join(' ')

  return (
    <div>
      <div
        className={cls}
        onClick={() => onSelect(node)}
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '0 8px',
          height: 26,
          paddingLeft: 8 + depth * 16,
          borderLeft: selected ? '2px solid var(--accent)' : '2px solid transparent',
        }}
      >
        <span
          onClick={(e) => {
            if (branch) {
              e.stopPropagation()
              setOpen(!open)
            }
          }}
          style={{ width: CHEVRON, display: 'inline-flex', alignItems: 'center' }}
        >
          {branch ? <Chevron open={open} /> : null}
        </span>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {node.label}
          {node.count != null ? <span style={{ color: 'var(--text-faint)' }}> ×{node.count}</span> : null}
        </span>
        {/* 进度条（占比横条，类别色） */}
        <span style={{ width: COL_BAR, flex: `0 0 ${COL_BAR}px`, height: 6, background: 'var(--bg-active)', borderRadius: 3, overflow: 'hidden' }}>
          <span style={{ display: 'block', height: '100%', width: `${Math.min(100, p)}%`, background: node.color, borderRadius: 3 }} />
        </span>
        <span style={{ width: COL_DUR, flex: `0 0 ${COL_DUR}px`, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>
          {fmtMs(node.ms)}
        </span>
        <span style={{ width: COL_PCT, flex: `0 0 ${COL_PCT}px`, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--text-faint)' }}>
          {p}%
        </span>
        {/* 甘特：全会话段（ganttNode，非窗口裁剪）按可视区（visStart + pxPerMs）裁剪定位 */}
        <Gantt segments={ganttNode?.segments} visStart={visStart} pxPerMs={pxPerMs} ganttW={ganttW} />
      </div>

      {open && branch && hasKids &&
        node.children!.map((c, i) => (
          <Row key={c.id} node={c} ganttNode={ganttNode?.children?.[i]} depth={depth + 1} index={i} revealPath={revealPath} visStart={visStart} pxPerMs={pxPerMs} ganttW={ganttW} onSelect={onSelect} selectedId={selectedId} />
        ))}
      {open && branch && expandable && (
        <ChildTree child={node.childSession!} depth={depth + 1} revealPath={revealPath} visStart={visStart} pxPerMs={pxPerMs} ganttW={ganttW} onSelect={onSelect} selectedId={selectedId} />
      )}
    </div>
  )
}

/** 子 agent 展开：其分解树子节点，同可视区/缩放定位；统计不随窗口（子 agent 不在窗口裁剪内）。 */
function ChildTree(props: {
  child: Session
  depth: number
  revealPath?: number[]
  visStart: number
  pxPerMs: number
  ganttW: number
  onSelect: (n: TreeNode) => void
  selectedId?: string
}): JSX.Element {
  const full = buildTreeNode(props.child)
  return (
    <>
      {full.children!.map((c, i) => (
        <Row key={c.id} node={c} depth={props.depth} index={i} revealPath={props.revealPath} visStart={props.visStart} pxPerMs={props.pxPerMs} ganttW={props.ganttW} onSelect={props.onSelect} selectedId={props.selectedId} />
      ))}
    </>
  )
}

function Legend(props: { windowLabel?: string }): JSX.Element {
  const items: [string, string][] = [
    ['等用户', 'var(--cat-wait)'],
    ['直接工具', 'var(--cat-direct)'],
    ['委派 Agent', 'var(--cat-delegated)'],
    ['workflow', 'var(--cat-workflow)'],
    ['LLM 计算', 'var(--cat-compute)'],
  ]
  return (
    <div className="legend">
      {items.map(([label, color]) => (
        <span key={label} className="legend-item">
          <span className="legend-sw" style={{ background: color }} />
          {label}
        </span>
      ))}
      {props.windowLabel ? (
        <span style={{ marginLeft: 'auto', color: 'var(--text-secondary)' }}>{props.windowLabel}</span>
      ) : null}
    </div>
  )
}

function Gantt(props: { segments?: Segment[]; visStart: number; pxPerMs: number; ganttW: number }): JSX.Element {
  const { segments, visStart, pxPerMs, ganttW } = props
  const visEnd = visStart + ganttW / Math.max(pxPerMs, 1e-9)
  return (
    <div
      style={{
        width: ganttW,
        flex: `0 0 ${ganttW}px`,
        marginLeft: 8,
        position: 'relative',
        height: 14,
        overflow: 'hidden',
        backgroundImage: GRID_BG,
        backgroundSize: `${ganttW / 4}px 100%`,
        borderLeft: '1px solid var(--border)',
        borderRight: '1px solid var(--border)',
      }}
    >
      {(segments ?? []).map((s, i) => {
        if (s.end <= s.start) return null
        // 段在可视区外的部分裁剪
        const clipStart = Math.max(s.start, visStart)
        const clipEnd = Math.min(s.end, visEnd)
        if (clipEnd <= clipStart) return null
        const pxLeft = (clipStart - visStart) * pxPerMs
        const pxWidth = (clipEnd - clipStart) * pxPerMs
        if (pxLeft + pxWidth <= 0 || pxLeft >= ganttW) return null
        return (
          <div
            key={i}
            title={`${fmtMs(s.end - s.start)}`}
            style={{
              position: 'absolute',
              top: 1,
              bottom: 1,
              left: `${Math.max(0, pxLeft)}px`,
              width: `${Math.min(pxWidth, ganttW - Math.max(0, pxLeft))}px`,
              minWidth: pxWidth < 1 ? 1 : 0,
              background: s.color,
              borderRadius: 2,
            }}
          />
        )
      })}
    </div>
  )
}

/** 复制成功提示：左下角悬浮气泡，1 秒后消失 */
const copiedTipStyle: React.CSSProperties = {
  position: 'fixed',
  left: 'var(--sp-3)',
  bottom: 'var(--sp-3)',
  padding: '6px 12px',
  background: 'var(--accent)',
  color: 'var(--on-accent)',
  borderRadius: 'var(--r-sm)',
  fontSize: 'var(--fs-sm)',
  fontWeight: 600,
  boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
  zIndex: 1000,
  pointerEvents: 'none',
  animation: 'fadeInOut 1s ease',
}