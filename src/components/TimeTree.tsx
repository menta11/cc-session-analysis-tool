import { useRef, useState } from 'react'
import type { Session } from '../../core/parser/types'
import { buildTreeNode, clipTreeToWindow, type Segment, type TreeNode } from '../../core/view/treeView'
import { clampWindow, zoomWindow, snapToSegmentBoundary, type ViewWindow } from '../../core/view/window'
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

const GANTT_W = 320
const GANTT_MIN = 200
const GANTT_MAX = 720
const COL_BAR = 96
const COL_DUR = 64
const COL_PCT = 48
const CHEVRON = 16
const GRID_BG = 'linear-gradient(to right, var(--border-subtle) 1px, transparent 1px)'

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
  const MIN_WINDOW = 1000 // 最小窗口 1s

  // 当前窗口：props 提供（受控）或回退全会话
  const effectiveWindow: ViewWindow = props.viewWindow ?? { start: rootStart, end: rootEnd }
  const clamped = clampWindow(effectiveWindow, rootStart, rootEnd, MIN_WINDOW)
  const winDuration = Math.max(1, clamped.end - clamped.start)
  // 窗口内裁剪树（段裁剪 + 重算 ms/wallMs）
  const tree = clipTreeToWindow(fullTree, clamped.start, clamped.end)

  // 动态刻度：窗口内均分 5 段
  const tickPositions = [0, 0.25, 0.5, 0.75, 1]
  const tickTransform = (t: number): string => (t === 0 ? 'none' : t === 1 ? 'translateX(-100%)' : 'translateX(-50%)')

  // 滑块操作：拖动中不吸附，松手吸附到段边界
  const [sliderDrag, setSliderDrag] = useState<'start' | 'end' | null>(null)
  const sliderRef = useRef<HTMLDivElement>(null)
  const sliderDragRef = useRef<{ startX: number; win: ViewWindow; which: 'start' | 'end' } | null>(null)

  // 底部滚动条：平移窗口（保持窗口宽度不变）
  const scrollbarRef = useRef<HTMLDivElement>(null)
  const scrollbarDragRef = useRef<{ startX: number; win: ViewWindow } | null>(null)

  const onScrollbarDown = (e: React.MouseEvent): void => {
    if (!props.onWindowChange) return
    e.preventDefault()
    e.stopPropagation()
    scrollbarDragRef.current = { startX: e.clientX, win: { ...clamped } }
    const mm = (ev: MouseEvent): void => {
      const d = scrollbarDragRef.current
      const el = scrollbarRef.current
      if (!d || !el || !props.onWindowChange) return
      const rect = el.getBoundingClientRect()
      const span = d.win.end - d.win.start
      const dxMs = ((ev.clientX - d.startX) / rect.width) * rootWall
      let start = d.win.start + dxMs
      let end = start + span
      start = Math.max(rootStart, Math.min(start, rootEnd - span))
      end = start + span
      props.onWindowChange({ start, end })
    }
    const up = (): void => {
      scrollbarDragRef.current = null
      window.removeEventListener('mousemove', mm)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', mm)
    window.addEventListener('mouseup', up)
  }

  const onSliderDown = (e: React.MouseEvent, which: 'start' | 'end') => {
    e.preventDefault()
    e.stopPropagation()
    sliderDragRef.current = { startX: e.clientX, win: { ...clamped }, which }
    setSliderDrag(which)
    const mm = (ev: MouseEvent): void => {
      const d = sliderDragRef.current
      const el = sliderRef.current
      if (!d || !el || !props.onWindowChange) return
      const rect = el.getBoundingClientRect()
      const ratio = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width))
      const ts = rootStart + ratio * rootWall
      const next = { ...d.win }
      if (d.which === 'start') {
        next.start = Math.min(ts, next.end - MIN_WINDOW)
      } else {
        next.end = Math.max(ts, next.start + MIN_WINDOW)
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
        // 松手吸附到最近段边界
        const boundaries = allSegmentBoundaries(tree)
        const next = clampWindow(d.win, rootStart, rootEnd, MIN_WINDOW)
        props.onWindowChange({
          start: snapToSegmentBoundary(next.start, boundaries),
          end: snapToSegmentBoundary(next.end, boundaries),
        })
      }
    }
    window.addEventListener('mousemove', mm)
    window.addEventListener('mouseup', up)
  }

  // ctrl+滚轮缩放（以焦点为中心）
  const onWheel = (e: React.WheelEvent): void => {
    if (!e.ctrlKey || !props.onWindowChange) return
    e.preventDefault()
    const el = sliderRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    const pivot = rootStart + ratio * rootWall
    const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2
    props.onWindowChange(zoomWindow(clamped, pivot, factor, rootStart, rootEnd, MIN_WINDOW))
  }

  const [ganttW, setGanttW] = useState(GANTT_W)
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)
  const [copiedTip, setCopiedTip] = useState<string | null>(null)
  const copiedTimerRef = useRef<number | null>(null)

  /** 复制并显示提示气泡 1 秒 */
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

  return (
    <div
      style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-base)', color: 'var(--text)', userSelect: 'none' }}
      onWheel={onWheel}
    >
      {/* 双滑块范围轨道（顶部） */}
      {props.onWindowChange ? (
        <div
          ref={sliderRef}
          style={{
            padding: '6px 8px 2px',
            background: 'var(--bg-subtle)',
            borderBottom: '1px solid var(--border)',
            position: 'sticky',
            top: 0,
            zIndex: 2,
          }}
        >
          <div style={{ position: 'relative', height: 18 }}>
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
                left: `${((clamped.start - rootStart) / rootWall) * 100}%`,
                width: `${((clamped.end - clamped.start) / rootWall) * 100}%`,
              }}
            />
            {/* 起始滑块 */}
            <div
              onMouseDown={(e) => onSliderDown(e, 'start')}
              style={{
                position: 'absolute',
                left: `${((clamped.start - rootStart) / rootWall) * 100}%`,
                top: 0,
                width: 8,
                height: 18,
                marginLeft: -4,
                background: sliderDrag === 'start' ? 'var(--accent)' : 'var(--accent-soft)',
                border: '1px solid var(--accent)',
                borderRadius: 4,
                cursor: 'col-resize',
              }}
              title="拖动选择开始时间"
            />
            {/* 结束滑块 */}
            <div
              onMouseDown={(e) => onSliderDown(e, 'end')}
              style={{
                position: 'absolute',
                left: `${((clamped.end - rootStart) / rootWall) * 100}%`,
                top: 0,
                width: 8,
                height: 18,
                marginLeft: -4,
                background: sliderDrag === 'end' ? 'var(--accent)' : 'var(--accent-soft)',
                border: '1px solid var(--accent)',
                borderRadius: 4,
                cursor: 'col-resize',
              }}
              title="拖动选择结束时间"
            />
            {/* 窗口时间标签 */}
            <span style={{ position: 'absolute', right: 0, top: 0, fontSize: 'var(--fs-xs)', color: 'var(--text-faint)' }}>
              {fmtMs(clamped.end - rootStart)} / {fmtMs(rootWall)}
            </span>
          </div>
        </div>
      ) : null}

      {/* sticky 表头：标签列 + 时间轴 + 甘特列拖柄 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '6px 8px',
          background: 'var(--bg-subtle)',
          borderBottom: '1px solid var(--border)',
          position: 'sticky',
          top: props.onWindowChange ? 30 : 0,
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
        <span style={{ width: COL_DUR, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtMs(tree.ms)}</span>
        <span style={{ width: COL_PCT, textAlign: 'right', color: 'var(--text-faint)' }}>{pct(tree.ms, tree.wallMs)}%</span>
        <div
          className={`col-splitter${dragging ? ' is-dragging' : ''}`}
          onMouseDown={onHandleDown}
          title="拖动调整甘特图列宽"
        />
        <div
          style={{
            width: ganttW,
            flex: `0 0 ${ganttW}px`,
            position: 'relative',
            height: 16,
            backgroundImage: GRID_BG,
            backgroundSize: '25% 100%',
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
              {fmtMs(clamped.start + t * winDuration)}
            </span>
          ))}
        </div>
      </div>

      <Legend />

      {/* 底部水平滚动条：反映窗口在全会话的位置，拖动平移窗口（窗口比全屏窄时可用） */}
      {props.onWindowChange && winDuration < rootWall ? (
        <div
          ref={scrollbarRef}
          onMouseDown={(e) => onScrollbarDown(e)}
          style={{
            height: 12,
            margin: '4px 8px',
            background: 'var(--bg-active)',
            borderRadius: 6,
            position: 'relative',
            cursor: 'pointer',
          }}
          title="拖动平移时间窗口"
        >
          <div
            style={{
              position: 'absolute',
              top: 1,
              bottom: 1,
              left: `${((clamped.start - rootStart) / rootWall) * 100}%`,
              width: `${((clamped.end - clamped.start) / rootWall) * 100}%`,
              background: 'var(--accent-soft)',
              border: '1px solid var(--accent)',
              borderRadius: 5,
            }}
          />
        </div>
      ) : null}

      {tree.children!.map((c, i) => (
        <Row
          key={c.id}
          node={c}
          depth={0}
          stripe={i % 2 === 1}
          viewStart={clamped.start}
          winDuration={winDuration}
          onSelect={props.onSelect}
          selectedId={props.selectedId}
          ganttW={ganttW}
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
  viewStart: number
  winDuration: number
  onSelect: (n: TreeNode) => void
  selectedId?: string
  ganttW: number
}): JSX.Element {
  const { node, depth, stripe, viewStart, winDuration, onSelect, selectedId, ganttW } = props
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
          {node.count ? <span style={{ color: 'var(--text-faint)' }}> ×{node.count}</span> : null}
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
        {/* 甘特：按时序定位的彩色段（窗口内） */}
        <Gantt segments={node.segments} viewStart={viewStart} winDuration={winDuration} width={ganttW} />
      </div>

      {open && branch && hasKids &&
        node.children!.map((c) => (
          <Row key={c.id} node={c} depth={depth + 1} viewStart={viewStart} winDuration={winDuration} onSelect={onSelect} selectedId={selectedId} ganttW={ganttW} />
        ))}
      {open && branch && expandable && (
        <ChildTree child={node.childSession!} depth={depth + 1} viewStart={viewStart} winDuration={winDuration} onSelect={onSelect} selectedId={selectedId} ganttW={ganttW} />
      )}
    </div>
  )
}

/** 子 agent 展开：其分解树子节点，甘特同窗口定位（绝对 ts）。 */
function ChildTree(props: {
  child: Session
  depth: number
  viewStart: number
  winDuration: number
  onSelect: (n: TreeNode) => void
  selectedId?: string
  ganttW: number
}): JSX.Element {
  const full = buildTreeNode(props.child)
  const tree = clipTreeToWindow(full, props.viewStart, props.viewStart + props.winDuration)
  return (
    <>
      {tree.children!.map((c) => (
        <Row key={c.id} node={c} depth={props.depth} viewStart={props.viewStart} winDuration={props.winDuration} onSelect={props.onSelect} selectedId={props.selectedId} ganttW={props.ganttW} />
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

function Gantt(props: { segments?: Segment[]; viewStart: number; winDuration: number; width: number }): JSX.Element {
  const segs = (props.segments ?? []).filter((s) => s.end > s.start)
  return (
    <div
      style={{
        width: props.width,
        flex: `0 0 ${props.width}px`,
        marginLeft: 8,
        position: 'relative',
        height: 14,
        backgroundImage: GRID_BG,
        backgroundSize: '25% 100%',
        borderLeft: '1px solid var(--border)',
        borderRight: '1px solid var(--border)',
      }}
    >
      {segs.map((s, i) => {
        const left = ((s.start - props.viewStart) / props.winDuration) * 100
        const width = ((s.end - s.start) / props.winDuration) * 100
        if (width <= 0) return null
        return (
          <div
            key={i}
            title={`${fmtMs(s.end - s.start)}`}
            style={{
              position: 'absolute',
              top: 1,
              bottom: 1,
              left: `${Math.max(0, left)}%`,
              minWidth: width < 0.4 ? 1 : 0,
              width: `${width}%`,
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
