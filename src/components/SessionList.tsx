import { useMemo, useRef, useState } from 'react'
import type { SessionRef } from '../../core/discovery/scan'
import { decodeProjectDir } from '../../core/discovery/projectDir'
import { fmtRelative, fmtSize, sessionDisplayTitle, timeBucketLabel } from '../../core/view/format'

type ListView = 'project' | 'timeline'
const VIEW_STORAGE_KEY = 'ccsa-session-view'

function getInitialView(): ListView {
  try {
    return localStorage.getItem(VIEW_STORAGE_KEY) === 'timeline' ? 'timeline' : 'project'
  } catch {
    return 'project'
  }
}

/** 复制文本到剪贴板，返回是否成功（Electron 渲染进程支持 navigator.clipboard） */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export function SessionList(props: {
  sessions: SessionRef[]
  onSelect: (path: string) => void
  selectedPath?: string
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [view, setView] = useState<ListView>(getInitialView)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [copiedTip, setCopiedTip] = useState<string | null>(null)
  const copiedTimerRef = useRef<number | null>(null)

  /** 复制并显示「复制成功」提示 1 秒 */
  const handleCopy = (text: string, tip: string): void => {
    void copyText(text)
    setCopiedTip(tip)
    if (copiedTimerRef.current) window.clearTimeout(copiedTimerRef.current)
    copiedTimerRef.current = window.setTimeout(() => setCopiedTip(null), 1000)
  }

  const q = query.trim().toLowerCase()
  const filtered = useMemo(
    () =>
      q
        ? props.sessions.filter(
            (s) =>
              s.sessionId.toLowerCase().includes(q) ||
              s.project.toLowerCase().includes(q) ||
              decodeProjectDir(s.project).toLowerCase().includes(q),
          )
        : props.sessions,
    [q, props.sessions],
  )

  const groups = useMemo(() => {
    const m = new Map<string, SessionRef[]>()
    for (const s of filtered) {
      const arr = m.get(s.project) ?? []
      arr.push(s)
      m.set(s.project, arr)
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [filtered])

  const toggle = (p: string): void => setOpen((o) => ({ ...o, [p]: !o[p] }))

  // 时间线分桶：filtered 已按 mtime 倒序, 顺序遍历切连续桶
  const timelineGroups = useMemo(() => {
    const out: [string, SessionRef[]][] = []
    for (const s of filtered) {
      const label = timeBucketLabel(s.mtimeMs)
      const last = out[out.length - 1]
      if (last && last[0] === label) last[1].push(s)
      else out.push([label, [s]])
    }
    return out
  }, [filtered])

  const switchView = (v: ListView): void => {
    setView(v)
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, v)
    } catch {
      /* 隐私模式等写入失败可忽略 */
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', gap: 'var(--sp-2)', margin: 'var(--sp-2)', alignItems: 'center' }}>
        <input
          className="input"
          placeholder="搜会话 ID 或目录…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ flex: 1, margin: 0, minWidth: 0 }}
        />
        <div style={viewToggleStyle} role="tablist" aria-label="列表视图">
          <button
            type="button"
            style={view === 'project' ? viewBtnActiveStyle : viewBtnStyle}
            onClick={() => switchView('project')}
            title="按项目目录分组"
            role="tab"
            aria-selected={view === 'project'}
          >
            项目
          </button>
          <button
            type="button"
            style={view === 'timeline' ? viewBtnActiveStyle : viewBtnStyle}
            onClick={() => switchView('timeline')}
            title="按时间倒序平铺"
            role="tab"
            aria-selected={view === 'timeline'}
          >
            时间线
          </button>
        </div>
      </div>
      <div style={{ flex: 1, overflow: 'auto' }}>
        {view === 'timeline'
          ? timelineGroups.map(([label, sess]) => (
              <div key={label}>
                <div className="row" onClick={() => toggle(label)} style={bucketHeaderStyle}>
                  <Chevron open={!!open[label]} />
                  <span>
                    {label} <span style={{ fontWeight: 400 }}>({sess.length})</span>
                  </span>
                </div>
                {open[label] !== false
                  ? sess.map((s) => (
                      <Row
                        key={s.path}
                        s={s}
                        onSelect={props.onSelect}
                        selected={props.selectedPath === s.path}
                        onCopy={handleCopy}
                        showProject
                      />
                    ))
                  : null}
              </div>
            ))
          : groups.map(([proj, sess]) => (
          <div key={proj}>
            <div
              className="row"
              onClick={() => toggle(proj)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--sp-1)',
                padding: '6px 10px',
                background: 'var(--bg-active)',
                fontWeight: 600,
                fontSize: 'var(--fs-sm)',
                borderBottom: '1px solid var(--border)',
                color: 'var(--text-secondary)',
              }}
            >
              <Chevron open={!!open[proj]} />
              <span
                style={{
                  flex: 1,
                  overflow: 'hidden',
                  display: 'flex',
                  flexDirection: 'column',
                  minWidth: 0,
                }}
                title={groupTitle(proj, sess)}
              >
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--fs-xs)',
                    color: 'var(--text-secondary)',
                  }}
                >
                  {groupTitle(proj, sess)}
                </span>
                <span
                  onContextMenu={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    handleCopy(groupSub(proj, sess), '已复制完整路径')
                  }}
                  title="右键复制完整路径"
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    color: 'var(--text-faint)',
                    fontWeight: 400,
                    fontSize: 'var(--fs-xs)',
                    cursor: 'copy',
                  }}
                >
                  {groupSub(proj, sess)}
                </span>
              </span>
              <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>({sess.length})</span>
            </div>
            {open[proj] !== false
              ? sess.map((s) => (
                  <Row
                    key={s.path}
                    s={s}
                    onSelect={props.onSelect}
                    selected={props.selectedPath === s.path}
                    onCopy={handleCopy}
                  />
                ))
              : null}
          </div>
        ))}
      </div>
      {copiedTip ? (
        <div style={copiedTipStyle} role="status">
          ✓ {copiedTip}
        </div>
      ) : null}
    </div>
  )
}

function Row(props: {
  s: SessionRef
  onSelect: (p: string) => void
  selected: boolean
  onCopy: (text: string, tip: string) => void
  /** 时间线视图下无项目分组上下文, 行内补显示项目名 */
  showProject?: boolean
}): JSX.Element {
  return (
    <div
      className={`row${props.selected ? ' row-selected' : ''}`}
      onClick={() => props.onSelect(props.s.path)}
      title={props.s.sessionId}
      style={{
        padding: '6px 12px',
        borderBottom: '1px solid var(--border-subtle)',
        borderLeft: props.selected ? '2px solid var(--accent)' : '2px solid transparent',
      }}
    >
      <div
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          props.onCopy(props.s.sessionId, '已复制会话 ID')
        }}
        title={`右键复制会话 ID：${props.s.sessionId}`}
        style={{ fontWeight: 600, fontSize: 'var(--fs-base)', fontFamily: 'var(--font-mono)', cursor: 'copy' }}
      >
        {sessionDisplayTitle(props.s)}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 1, color: 'var(--text-faint)', fontSize: 'var(--fs-xs)' }}>
        <span>{fmtRelative(props.s.mtimeMs)}</span>
        <span>·</span>
        <span>{fmtSize(props.s.sizeBytes)}</span>
        {props.showProject ? (
          <>
            <span>·</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {basename(props.s.cwd ?? decodeProjectDir(props.s.project))}
            </span>
          </>
        ) : null}
      </div>
    </div>
  )
}

/** 视图切换（项目/时间线）小分段控件 */
const viewToggleStyle: React.CSSProperties = {
  display: 'inline-flex',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-sm)',
  overflow: 'hidden',
  flexShrink: 0,
}

const viewBtnStyle: React.CSSProperties = {
  padding: '4px 8px',
  border: 'none',
  background: 'var(--bg-elevated)',
  color: 'var(--text-secondary)',
  fontSize: 'var(--fs-xs)',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const viewBtnActiveStyle: React.CSSProperties = {
  ...viewBtnStyle,
  background: 'var(--accent)',
  color: 'var(--on-accent)',
  fontWeight: 600,
}

/** 时间线分桶标题行：可点击折叠（默认展开） */
const bucketHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--sp-1)',
  padding: '6px 10px',
  background: 'var(--bg-active)',
  fontWeight: 600,
  fontSize: 'var(--fs-sm)',
  borderBottom: '1px solid var(--border)',
  color: 'var(--text-secondary)',
  position: 'sticky',
  top: 0,
  cursor: 'pointer',
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


/** 分组标题：优先显示 cwd 的末尾目录名（如「请假审批」），否则回退到解码目录名的末尾 */
function groupTitle(proj: string, sess: SessionRef[]): string {
  const cwd = sess[0]?.cwd
  if (cwd) return basename(cwd)
  return basename(decodeProjectDir(proj))
}

/** 分组副标题：显示完整真实路径（cwd），否则回退到解码的 sanitized 目录名 */
function groupSub(proj: string, sess: SessionRef[]): string {
  return sess[0]?.cwd ?? decodeProjectDir(proj)
}

/** 取路径末尾目录名（兼容 / 和 \ 分隔符） */
function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || p
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
