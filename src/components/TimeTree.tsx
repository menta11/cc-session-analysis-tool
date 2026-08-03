import { useRef, useState } from 'react'
import type { Session } from '../../core/parser/types'
import { buildTreeNode, type Segment, type TreeNode } from '../../core/view/treeView'
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
}): JSX.Element {
  const tree = buildTreeNode(props.session)
  const rootStart = props.session.startedAt ?? 0
  const rootEnd = props.session.endedAt ?? 0
  const rootWall = Math.max(1, rootEnd - rootStart)
  const ticks = [0, 0.25, 0.5, 0.75, 1]
  const tickTransform = (t: number): string => (t === 0 ? 'none' : t === 1 ? 'translateX(-100%)' : 'translateX(-50%)')

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
    <div style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-base)', color: 'var(--text)', userSelect: 'none' }}>
      {/* sticky 表头：标签列 + 时间轴 + 甘特列拖柄 */}
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
        <span style={{ width: COL_DUR, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtMs(tree.ms)}</span>
        <span style={{ width: COL_PCT, textAlign: 'right', color: 'var(--text-faint)' }}>100%</span>
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
          {ticks.map((t) => (
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
              {fmtMs(t * rootWall)}
            </span>
          ))}
        </div>
      </div>

      <Legend />

      {tree.children!.map((c, i) => (
        <Row
          key={c.id}
          node={c}
          depth={0}
          stripe={i % 2 === 1}
          rootStart={rootStart}
          rootWall={rootWall}
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
  rootStart: number
  rootWall: number
  onSelect: (n: TreeNode) => void
  selectedId?: string
  ganttW: number
}): JSX.Element {
  const { node, depth, stripe, rootStart, rootWall, onSelect, selectedId, ganttW } = props
  const [open, setOpen] = useState(depth < 1)
  const hasKids = !!node.children?.length
  const expandable = !!node.expandable && !!node.childSession
  const branch = hasKids || expandable
  const p = pct(node.ms, rootWall)
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
        {/* 甘特：按时序定位的彩色段 */}
        <Gantt segments={node.segments} rootStart={rootStart} rootWall={rootWall} width={ganttW} />
      </div>

      {open && branch && hasKids &&
        node.children!.map((c) => (
          <Row key={c.id} node={c} depth={depth + 1} rootStart={rootStart} rootWall={rootWall} onSelect={onSelect} selectedId={selectedId} ganttW={ganttW} />
        ))}
      {open && branch && expandable && (
        <ChildTree child={node.childSession!} depth={depth + 1} rootStart={rootStart} rootWall={rootWall} onSelect={onSelect} selectedId={selectedId} ganttW={ganttW} />
      )}
    </div>
  )
}

/** 子 agent 展开：其分解树子节点，甘特仍按 root 总耗时定位（绝对 ts）。 */
function ChildTree(props: {
  child: Session
  depth: number
  rootStart: number
  rootWall: number
  onSelect: (n: TreeNode) => void
  selectedId?: string
  ganttW: number
}): JSX.Element {
  const tree = buildTreeNode(props.child)
  return (
    <>
      {tree.children!.map((c) => (
        <Row key={c.id} node={c} depth={props.depth} rootStart={props.rootStart} rootWall={props.rootWall} onSelect={props.onSelect} selectedId={props.selectedId} ganttW={props.ganttW} />
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

function Gantt(props: { segments?: Segment[]; rootStart: number; rootWall: number; width: number }): JSX.Element {
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
        const left = ((s.start - props.rootStart) / props.rootWall) * 100
        const width = ((s.end - s.start) / props.rootWall) * 100
        if (width <= 0) return null
        return (
          <div
            key={i}
            title={`${fmtMs(s.end - s.start)}`}
            style={{
              position: 'absolute',
              top: 1,
              bottom: 1,
              left: `${left}%`,
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
