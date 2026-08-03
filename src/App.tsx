import { useCallback, useEffect, useRef, useState } from 'react'
import type { Session } from '../core/parser/types'
import type { SessionRef } from '../core/discovery/scan'
import type { TreeNode } from '../core/view/treeView'
import { fmtMs, fmtRelative } from '../core/view/format'
import { decodeProjectDir } from '../core/discovery/projectDir'
import { SessionList } from './components/SessionList'
import { TimeTree } from './components/TimeTree'
import { DetailPanel } from './components/DetailPanel'
import { AiReport } from './components/AiReport'
import { SplitPane } from './components/SplitPane'

type Theme = 'light' | 'dark'

function getInitialTheme(): Theme {
  if (typeof localStorage !== 'undefined') {
    const t = localStorage.getItem('ccsa-theme')
    if (t === 'dark' || t === 'light') return t
  }
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

interface ReportState {
  text: string
  error: string
  claudeId: string | undefined
  loading: boolean
}
const EMPTY_REPORT: ReportState = { text: '', error: '', claudeId: undefined, loading: false }

export function App(): JSX.Element {
  const [sessions, setSessions] = useState<SessionRef[]>([])
  const [session, setSession] = useState<Session | null>(null)
  const [selected, setSelected] = useState<TreeNode | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | undefined>()
  const [reports, setReports] = useState<Record<string, ReportState>>({})
  const cur = reports[selectedPath ?? ''] ?? EMPTY_REPORT
  const [theme, setTheme] = useState<Theme>(getInitialTheme)
  const [sidebarW, setSidebarW] = useState(300)
  // 左侧目录栏宽度拖拽（垂直分隔条）
  const [sidebarDragging, setSidebarDragging] = useState(false)
  const sidebarDragRef = useRef(false)
  const startSidebarDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    sidebarDragRef.current = true
    setSidebarDragging(true)
    const mm = (ev: MouseEvent): void => {
      if (!sidebarDragRef.current) return
      const w = Math.min(520, Math.max(180, ev.clientX))
      setSidebarW(w)
    }
    const up = (): void => {
      sidebarDragRef.current = false
      setSidebarDragging(false)
      window.removeEventListener('mousemove', mm)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', mm)
    window.addEventListener('mouseup', up)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem('ccsa-theme', theme)
    } catch {
      /* 忽略隐私模式等写入失败 */
    }
  }, [theme])

  useEffect(() => {
    void window.api.scanProjects().then(setSessions)
  }, [])

  // 文件菜单「导入会话」：主进程打开对话框后把路径推过来
  useEffect(() => window.api.onImportSession((path) => load(path)), [])

  const load = (path: string): void => {
    setSelectedPath(path)
    setSelected(null)
    void window.api.loadSession(path).then(setSession)
  }

  const analyze = async (kind: 'whole' | 'node', focusToolUseId?: string): Promise<void> => {
    if (!selectedPath) return
    const key = selectedPath
    setReports((r) => ({ ...r, [key]: { ...EMPTY_REPORT, loading: true } }))
    let acc = ''
    const off = window.api.onAnalyzeChunk((chunk) => {
      acc += chunk
      setReports((r) => ({ ...r, [key]: { ...(r[key] ?? EMPTY_REPORT), text: acc, loading: true } }))
    })
    try {
      const res = await window.api.analyzeReport(kind, selectedPath, focusToolUseId)
      if (res.ok) {
        setReports((r) => ({ ...r, [key]: { text: res.text || acc, error: '', claudeId: res.sessionId, loading: false } }))
      } else {
        setReports((r) => ({ ...r, [key]: { text: '', error: res.error ?? '分析失败', claudeId: undefined, loading: false } }))
      }
    } finally {
      off()
    }
  }

  const analyzeWhole = (): void => {
    void analyze('whole')
  }

  const analyzeAgent = (toolUseId: string): void => {
    void analyze('node', toolUseId)
  }

  const save = async (): Promise<void> => {
    if (!cur.text) return
    await window.api.saveReport(cur.text, `会话分析报告-${session?.sessionId.slice(0, 8) ?? 'session'}.md`)
  }

  // 当前选中会话的 ref（取 mtime / size）
  const curRef = sessions.find((s) => s.path === selectedPath)
  const wallMs = session && session.startedAt != null && session.endedAt != null ? session.endedAt - session.startedAt : 0
  const projectLabel = curRef ? curRef.cwd ?? decodeProjectDir(curRef.project) : ''

  return (
    <div style={appStyle}>
      <header style={appbarStyle}>
        <span style={brandStyle}>
          <span style={logoStyle}>C</span>
          Claude 会话耗时分析
        </span>
        {session ? (
          <span style={metabarStyle}>
            <span className="chip" style={chipStyle}>
              <span style={{ ...dotStyle, background: 'var(--cat-compute)' }} />
              <b>{curRef?.aiTitle ?? session.sessionId.slice(0, 8)}</b>
            </span>
            <span className="chip" style={chipStyle}>总耗时 <b>{fmtMs(wallMs)}</b></span>
            {projectLabel ? (
              <span className="chip" style={projectChipStyle} title={`项目 ${projectLabel}`}>
                项目 <b style={pathStyle}>{projectLabel}</b>
              </span>
            ) : null}
            {curRef ? <span className="chip" style={chipStyle}>{fmtRelative(curRef.mtimeMs)}</span> : null}
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          title={theme === 'dark' ? '切换到亮色' : '切换到暗色'}
          aria-label={theme === 'dark' ? '切换到亮色' : '切换到暗色'}
          style={iconBtnStyle}
        >
          {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
        </button>
      </header>

      <div style={shellStyle}>
        <aside style={{ ...sidebarStyle, width: sidebarW }}>
          <div style={sidebarHeaderStyle}>会话</div>
          <div style={{ flex: 1, minHeight: 0 }}>
            <SessionList sessions={sessions} onSelect={load} selectedPath={selectedPath} />
          </div>
        </aside>
        <div
          onMouseDown={startSidebarDrag}
          className={`splitter-v${sidebarDragging ? ' is-dragging' : ''}`}
          style={sidebarSplitterStyle}
          role="separator"
          aria-orientation="vertical"
        />

        <main style={mainStyle}>
          {session ? (
            <SplitPane
              top={
                <SplitPane
                  initialRatio={0.62}
                  top={
                    <div style={{ height: '100%', overflow: 'auto', minHeight: 0 }}>
                      <TimeTree session={session} onSelect={setSelected} selectedId={selected?.id} />
                    </div>
                  }
                  bottom={<DetailPanel node={selected} onAnalyzeAgent={analyzeAgent} />}
                />
              }
              bottom={
                <AiReport
                  text={cur.text}
                  loading={cur.loading}
                  error={cur.error}
                  sessionId={cur.claudeId}
                  onGenerate={analyzeWhole}
                  onSave={save}
                  onOpenTerminal={() => {
                    if (cur.claudeId) void window.api.openTerminal(cur.claudeId)
                  }}
                />
              }
            />
          ) : (
            <EmptyState />
          )}
        </main>
      </div>
    </div>
  )
}

function EmptyState(): JSX.Element {
  return (
    <div style={emptyStyle}>
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: 'var(--text-faint)', marginBottom: 'var(--sp-3)' }}>
        <path d="M3 12h4l3 8 4-16 3 8h4" />
      </svg>
      <div style={{ fontSize: 'var(--fs-lg)', fontWeight: 600, marginBottom: 'var(--sp-2)' }}>
        选择一个会话开始分析
      </div>
      <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-base)' }}>
        从左侧选择会话，或用顶部菜单「文件 → 导入会话」打开任意 .jsonl 文件。
      </div>
    </div>
  )
}

function SunIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  )
}

function MoonIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  )
}

const appStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100vh',
  margin: 0,
  background: 'var(--bg)',
  color: 'var(--text)',
}

const appbarStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  rowGap: 'var(--sp-1)',
  gap: 'var(--sp-3)',
  padding: 'var(--sp-1) var(--sp-3)',
  minHeight: 44,
  borderBottom: '1px solid var(--border)',
  background: 'var(--bg-subtle)',
  flexShrink: 0,
}

const brandStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--sp-2)',
  fontWeight: 700,
  fontSize: 'var(--fs-md)',
  whiteSpace: 'nowrap',
  flexShrink: 0,
}

const logoStyle: React.CSSProperties = {
  width: 22,
  height: 22,
  borderRadius: 6,
  background: 'linear-gradient(135deg, var(--accent), var(--cat-compute))',
  color: 'var(--on-accent)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 13,
  fontWeight: 800,
}

const metabarStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  rowGap: 'var(--sp-1)',
  alignItems: 'center',
  gap: 'var(--sp-2)',
  marginLeft: 'var(--sp-2)',
  flex: '1 1 auto',
  minWidth: 0,
}

const chipStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '2px 8px',
  border: '1px solid var(--border)',
  borderRadius: 999,
  background: 'var(--bg-elevated)',
  color: 'var(--text-secondary)',
  fontSize: 'var(--fs-xs)',
  whiteSpace: 'nowrap',
  flexShrink: 0,
}

// 项目 chip：路径可很长，单独允许收缩 + 截断，完整路径放 title
const projectChipStyle: React.CSSProperties = {
  ...chipStyle,
  flexShrink: 1,
  minWidth: 0,
  maxWidth: '32ch',
}

const pathStyle: React.CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  minWidth: 0,
  fontWeight: 600,
}

const dotStyle: React.CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: '50%',
}

const shellStyle: React.CSSProperties = {
  display: 'flex',
  flex: 1,
  minHeight: 0,
}

const sidebarStyle: React.CSSProperties = {
  flexShrink: 0,
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--bg-subtle)',
  minWidth: 0,
}

const sidebarSplitterStyle: React.CSSProperties = {
  width: 6,
  cursor: 'col-resize',
  flexShrink: 0,
  background: 'var(--border)',
  transition: 'background var(--transition-fast)',
}

const sidebarHeaderStyle: React.CSSProperties = {
  padding: '8px 12px',
  fontWeight: 700,
  fontSize: 'var(--fs-sm)',
  color: 'var(--text-tertiary)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  borderBottom: '1px solid var(--border)',
}

const iconBtnStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 30,
  height: 30,
  padding: 0,
  border: '1px solid var(--border)',
  background: 'var(--bg-elevated)',
  color: 'var(--text-secondary)',
  borderRadius: 'var(--r-sm)',
  cursor: 'pointer',
  flexShrink: 0,
  transition: 'background var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast)',
}
const mainStyle: React.CSSProperties = { flex: 1, minWidth: 0 }

const emptyStyle: React.CSSProperties = {
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 'var(--sp-5)',
  textAlign: 'center',
}
