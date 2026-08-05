import { useEffect, useRef, useState } from 'react'
import type { Session } from '../../core/parser/types'
import { buildTreeNode, clipTreeToWindow, type Segment, type TreeNode } from '../../core/view/treeView'
import { clampWindow, snapToSegmentBoundary, type ViewWindow } from '../../core/view/window'
import { fmtMs, pct } from '../../core/view/format'

/** 复制文本到剪贴板，返回是否成功（Electron 渲染进程支持 navigator.clipboard） */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** 收集树中所有甘特段的边界（排序去重），供滑块吸附。用完整树（非裁剪后），保证边界齐全。 */
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
}): JSX.Element {
  const fullTree = buildTreeNode(props.session)
  const rootStart = props.session.startedAt ?? 0
  const rootEnd = props.session.endedAt ?? 0
  const rootWall = Math.max(1, rootEnd - rootStart)
  const boundaries = allSegmentBoundaries(fullTree)

  // 滑块窗口（分析范围，离散段边界）；props 提供或回退全会话
  const effectiveWindow: ViewWindow = props.viewWindow ?? { start: rootStart, end: rootEnd }
  const win = clampWindow(effectiveWindow, rootStart, rootEnd, MIN_WINDOW)
  const winDuration = Math.max(1, win.end - win.start)
  // 窗口内裁剪树（统计按窗口）
  const tree = clipTreeToWindow(fullTree, win.start, win.end)

  const [ganttW, setGanttW] = useState(GANTT_W)
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)

  // ── 缩放（pxPerMs，独立于窗口）──
  // 内容像素宽 = winDuration * pxPerMs；可视区 = ganttW
  const [pxPerMs, setPxPerMs] = useState(() => ganttW / winDuration)
  const [visOffsetPx, setVisOffsetPx] = useState(0)
  const contentWidth = winDuration * pxPerMs
  const canScroll = contentWidth > ganttW
  const maxOffset = Math.max(0, contentWidth - ganttW)
  const clampedOffset = Math.min(maxOffset, Math.max(0, visOffsetPx))

  // 窗口变化时重置缩放/可视区（新窗口默认满宽）
  useEffect(() => {
    setPxPerMs(ganttW / winDuration)
    setVisOffsetPx(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win.start, win.end])

  // 窗口内可视区的时间范围（刻度/渲染用）
  const visStartTs = win.start + clampedOffset / pxPerMs
  const visEndTs = win.start + (clampedOffset + ganttW) / pxPerMs
  const visDuration = Math.max(1, visEndTs - visStartTs)

  // ctrl+滚轮缩放：以鼠标焦点为锚点，保持该时间点像素位置不变
  const onWheel = (e: React.WheelEvent): void => {
    if (!e.ctrlKey) return
    e.preventDefault()
    const el = ganttTrackRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const xInVis = Math.min(ganttW, Math.max(0, e.clientX - rect.left))
    const anchorTs = visStartTs + (xInVis / ganttW) * visDuration
    const factor = e.deltaY < 0 ? 1.25 : 1 / 1.25
    const next = Math.max(ganttW / winDuration, pxPerMs * factor) // 下限 = 整窗满宽
    // 锚点时间在可视区内的像素位置不变
    const anchorPx = (anchorTs - win.start) * next
    const newOffset = anchorPx - xInVis
    setPxPerMs(next)
    setVisOffsetPx(Math.min(Math.max(0, newOffset), Math.max(0, winDuration * next - ganttW)))
  }

  const ganttTrackRef = useRef<HTMLDivElement>(null)

  // ── 滚动条：窗口内平移可视区 ──
  const scrollbarRef = useRef<HTMLDivElement>(null)
  const scrollbarDragRef = useRef<{ startX: number; startOffset: number } | null>(null)
  const onScrollbarDown = (e: React.MouseEvent): void => {
    if (!canScroll) return
    e.preventDefault()
    e.stopPropagation()
    scrollbarDragRef.current = { startX: e.clientX, startOffset: clampedOffset }
    const mm = (ev: MouseEvent): void => {
      const d = scrollbarDragRef.current
      const el = scrollbarRef.current
      if (!d || !el) return
      const rect = el.getBoundingClientRect()
      const dx = ev.clientX - d.startX
      const ratio = dx / rect.width
      setVisOffsetPx(Math.min(maxOffset, Math.max(0, d.startOffset + ratio * contentWidth)))
    }
    const up = (): void => {
      scrollbarDragRef.current = null
      window.removeEventListener('mousemove', mm)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', mm)
    window.addEventListener('mouseup', up)
  }

  // ── 滑块：限定分析窗口（离散段边界） ──
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
      const ts = rootStart + ratio * rootWall
      let next = { start: d.startTs, end: d.endTs }
      if (d.which === 'start') {
        next.start = Math.min(ts, d.endTs - MIN_WINDOW)
      } else {
        next.end = Math.max(ts, d.startTs + MIN_WINDOW)
      }
      props.onWindowChange(clampWindow(next, rootStart, rootEnd, MIN_WINDOW))
    }
    const up = (): void => {
      const d = sliderDragRef.current
      sliderDragRef.current = null
      setSliderDrag(null)
      window.removeEventListener('mousemove', mm)
      window.removeEventListener('mouseup', up)
      if (d && props.onWindowChange) {
        // 松手吸附到最近段边界（用完整树的边界），保证 start<end 且边界在会话内
        const sStart = snapToSegmentBoundary(d.startTs, boundaries)
        const sEnd = snapToSegmentBoundary(d.endTs, boundaries)
        const next = clampWindow({ start: sStart, end: sEnd }, rootStart, rootEnd, MIN_WINDOW)
        props.onWindowChange(next)
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
      {/* 表头：标签列 + 时间轴 + 甘特列拖柄（sticky） */}
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
        <span
          style={{ flex: 1, cursor: 'copy' }}
          title={`右键复制会话 ID：${props.session.sessionId}`}
          onContextMenu={(e) => {
            e.preventDefault()
            handleCopy(props.session.sessionId, '已复制会话 ID')
          }}
        >
          {tree.label}
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
              {fmtMs(visStartTs - rootStart + t * visDuration)}
            </span>
          ))}
        </div>
      </div>

      {/* 双滑块：仅横跨甘特列，限定分析窗口 */}
      {props.onWindowChange ? (
        <div
          ref={sliderRef}
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
          <div style={{ width: ganttW, flex: `0 0 ${ganttW}px`, marginLeft: 8, position: 'relative', height: 18 }}>
            {/* 轨道 */}
            <div style={{ position: 'absolute', left: 0, right: 0, top: 7, height: 4, background: 'var(--bg-active)', borderRadius: 2 }} />
            {/* 选中区间 */}
            <div
              style={{
                position: 'absolute',
                top: 7,
                height: 4,
                background: 'var(--accent)',
                borderRadius: 2,
                left: `${((win.start - rootStart) / rootWall) * 100}%`,
                width: `${((win.end - win.start) / rootWall) * 100}%`,
              }}
            />
            {/* 起始滑块 */}
            <div
              onMouseDown={(e) => onSliderDown(e, 'start')}
              style={{
                position: 'absolute',
                left: `${((win.start - rootStart) / rootWall) * 100}%`,
                top: 0,
                width: 8,
                height: 18,
                marginLeft: -4,
                background: sliderDrag === 'start' ? 'var(--accent)' : 'var(--accent-soft)',
                border: '1px solid var(--accent)',
                borderRadius: 4,
                cursor: 'col-resize',
              }}
              title="拖动选择分析开始时间"
            />
            {/* 结束滑块 */}
            <div
              onMouseDown={(e) => onSliderDown(e, 'end')}
              style={{
                position: 'absolute',
                left: `${((win.end - rootStart) / rootWall) * 100}%`,
                top: 0,
                width: 8,
                height: 18,
                marginLeft: -4,
                background: sliderDrag === 'end' ? 'var(--accent)' : 'var(--accent-soft)',
                border: '1px solid var(--accent)',
                borderRadius: 4,
                cursor: 'col-resize',
              }}
              title="拖动选择分析结束时间"
            />
            <span style={{ position: 'absolute', right: 0, top: 0, fontSize: 'var(--fs-xs)', color: 'var(--text-faint)' }}>
              {fmtMs(win.end - win.start)}
            </span>
          </div>
        </div>
      ) : null}

      <Legend />

      {/* 水平滚动条（仅甘特列，缩放后出现）：窗口内平移可视区 */}
      {canScroll ? (
        <div
          style={{ display: 'flex', padding: '2px 8px' }}
        >
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
                left: `${(clampedOffset / contentWidth) * 100}%`,
                width: `${(ganttW / contentWidth) * 100}%`,
                background: 'var(--accent-soft)',
                border: '1px solid var(--accent)',
                borderRadius: 5,
              }}
            />
          </div>
        </div>
      ) : null}

      {tree.children!.map((c, i) => (
        <Row
          key={c.id}
          node={c}
          depth={0}
          stripe={i % 2 === 1}
          win={win}
          pxPerMs={pxPerMs}
          visOffsetPx={clampedOffset}
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
  node: TreeNode
  depth: number
  stripe?: boolean
  win: ViewWindow
  pxPerMs: number
  visOffsetPx: number
  ganttW: number
  onSelect: (n: TreeNode) => void
  selectedId?: string
}): JSX.Element {
  const { node, depth, stripe, win, pxPerMs, visOffsetPx, ganttW, onSelect, selectedId } = props
  const [open, setOpen] = useState(depth < 1)
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
        {/* 甘特：窗口内按时序像素定位 */}
        <Gantt segments={node.segments} win={win} pxPerMs={pxPerMs} visOffsetPx={visOffsetPx} ganttW={ganttW} />
      </div>

      {open && branch && hasKids &&
        node.children!.map((c) => (
          <Row key={c.id} node={c} depth={depth + 1} win={win} pxPerMs={pxPerMs} visOffsetPx={visOffsetPx} ganttW={ganttW} onSelect={onSelect} selectedId={selectedId} />
        ))}
      {open && branch && expandable && (
        <ChildTree child={node.childSession!} depth={depth + 1} win={win} pxPerMs={pxPerMs} visOffsetPx={visOffsetPx} ganttW={ganttW} onSelect={onSelect} selectedId={selectedId} />
      )}
    </div>
  )
}

/** 子 agent 展开：其分解树子节点，同窗口/缩放定位。 */
function ChildTree(props: {
  child: Session
  depth: number
  win: ViewWindow
  pxPerMs: number
  visOffsetPx: number
  ganttW: number
  onSelect: (n: TreeNode) => void
  selectedId?: string
}): JSX.Element {
  const full = buildTreeNode(props.child)
  const tree = clipTreeToWindow(full, props.win.start, props.win.end)
  return (
    <>
      {tree.children!.map((c) => (
        <Row key={c.id} node={c} depth={props.depth} win={props.win} pxPerMs={props.pxPerMs} visOffsetPx={props.visOffsetPx} ganttW={props.ganttW} onSelect={props.onSelect} selectedId={props.selectedId} />
      ))}
    </>
  )
}

function Legend(): JSX.Element {
  const items: [string, string][] = [
    ['等用户', 'var(--cat-wait)'],
    ['直接工具', 'var(--cat-direct)'],
    ['委派 Agent', 'var(--cat-delegated)'],
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
    </div>
  )
}

function Gantt(props: {
  segments?: Segment[]
  win: ViewWindow
  pxPerMs: number
  visOffsetPx: number
  ganttW: number
}): JSX.Element {
  const { segments, win, pxPerMs, visOffsetPx, ganttW } = props
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
        // 段在窗口内的像素位置（减去可视区偏移）
        const pxLeft = (s.start - win.start) * pxPerMs - visOffsetPx
        const pxWidth = (s.end - s.start) * pxPerMs
        if (pxLeft + pxWidth <= 0 || pxLeft >= ganttW) return null // 可视区外
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

function Chevron(props: { open: boolean }): JSX.Element {
  return (
    <svg
      className={`chevron${props.open ? ' chevron-open' : ''}`}
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
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