import { useMemo, useState } from 'react'
import type { SessionRef } from '../../core/discovery/scan'
import { decodeProjectDir } from '../../core/discovery/projectDir'
import { fmtRelative, fmtSize } from '../../core/view/format'

export function SessionList(props: {
  sessions: SessionRef[]
  onSelect: (path: string) => void
  selectedPath?: string
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<Record<string, boolean>>({})

  const q = query.trim().toLowerCase()
  const filtered = q ? props.sessions.filter((s) => s.sessionId.toLowerCase().includes(q)) : props.sessions

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
        placeholder="搜索会话 ID…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{ margin: 'var(--sp-2)' }}
      />
      <div style={{ flex: 1, overflow: 'auto' }}>
        {q
          ? filtered.map((s) => <Row key={s.path} s={s} onSelect={props.onSelect} selected={props.selectedPath === s.path} />)
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
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {decodeProjectDir(proj)}
                  </span>
                  <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>({sess.length})</span>
                </div>
                {open[proj]
                  ? sess.map((s) => <Row key={s.path} s={s} onSelect={props.onSelect} selected={props.selectedPath === s.path} />)
                  : null}
              </div>
            ))}
      </div>
    </div>
  )
}

function Row(props: { s: SessionRef; onSelect: (p: string) => void; selected: boolean }): JSX.Element {
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
      <div style={{ fontWeight: 600, fontSize: 'var(--fs-base)', fontFamily: 'var(--font-mono)' }}>
        {props.s.sessionId.slice(0, 12)}…
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 1, color: 'var(--text-faint)', fontSize: 'var(--fs-xs)' }}>
        <span>{fmtRelative(props.s.mtimeMs)}</span>
        <span>·</span>
        <span>{fmtSize(props.s.sizeBytes)}</span>
      </div>
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
