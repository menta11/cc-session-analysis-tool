import { useMemo, useRef, useState } from 'react'
import type { SessionRef } from '../../core/discovery/scan'
import { decodeProjectDir } from '../../core/discovery/projectDir'
import { fmtRelative, fmtSize } from '../../core/view/format'

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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <input
        className="input"
        placeholder="搜会话 ID 或目录…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{ margin: 'var(--sp-2)' }}
      />
      <div style={{ flex: 1, overflow: 'auto' }}>
        {groups.map(([proj, sess]) => (
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
                  onClick={(e) => {
                    e.stopPropagation()
                    handleCopy(groupSub(proj, sess), '已复制完整路径')
                  }}
                  title="点击复制完整路径"
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
            {open[proj]
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
        onClick={(e) => {
          e.stopPropagation()
          props.onCopy(props.s.sessionId, '已复制会话 ID')
        }}
        title={`点击复制会话 ID：${props.s.sessionId}`}
        style={{ fontWeight: 600, fontSize: 'var(--fs-base)', fontFamily: 'var(--font-mono)', cursor: 'copy' }}
      >
        {props.s.aiTitle ?? `${props.s.sessionId.slice(0, 12)}…`}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 1, color: 'var(--text-faint)', fontSize: 'var(--fs-xs)' }}>
        <span>{fmtRelative(props.s.mtimeMs)}</span>
        <span>·</span>
        <span>{fmtSize(props.s.sizeBytes)}</span>
      </div>
    </div>
  )
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
