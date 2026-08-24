import { useCallback, useEffect, useRef, useState } from 'react'
import type { Session } from '../../core/parser/types'
import type { SessionRef } from '../../core/discovery/scan'
import type { TreeNode } from '../../core/view/treeView'
import { fmtMs, fmtRelative, sessionDisplayTitle } from '../../core/view/format'
import { decodeProjectDir } from '../../core/discovery/projectDir'
import { SessionList } from '../components/SessionList'
import { TimeTree } from '../components/TimeTree'
import { DetailPanel } from '../components/DetailPanel'
import { AiReport } from '../components/AiReport'
import { SplitPane } from '../components/SplitPane'

interface ReportState {
  text: string
  error: string
  claudeId: string | undefined
  loading: boolean
}
const EMPTY_REPORT: ReportState = { text: '', error: '', claudeId: undefined, loading: false }

/** 「会话分析」页：离线解析 ~/.claude/projects 的 JSONL, 递归工作/等待分解 + AI 报告 */
export function AnalyzerPage({ onCopy }: { onCopy: (text: string, tip: string) => void }): JSX.Element {
  const [sessions, setSessions] = useState<SessionRef[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(true)
  const [session, setSession] = useState<Session | null>(null)
  const [selected, setSelected] = useState<TreeNode | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | undefined>()
  const [reports, setReports] = useState<Record<string, ReportState>>({})
  const cur = reports[selectedPath ?? ''] ?? EMPTY_REPORT
  const [sidebarW, setSidebarW] = useState(300)
  // 甘特图视图窗口（默认全会话范围，会话加载后设置）
  const [viewWindow, setViewWindow] = useState<{ start: number; end: number } | null>(null)
  // AI 分析范围：整会话 或 按当前窗口
  const [aiScope, setAiScope] = useState<'whole' | 'window'>('whole')
  // 生成报告时的窗口（用于「窗口已变化」提示）
  const [reportWindow, setReportWindow] = useState<{ start: number; end: number } | null>(null)

  useEffect(() => {
    void window.api.scanProjects().then((s) => {
      setSessions(s)
      setSessionsLoading(false)
    })
  }, [])

  // 文件菜单「导入会话」：主进程打开对话框后把路径推过来
  useEffect(() => window.api.onImportSession((path) => load(path)), [])

  const load = (path: string): void => {
    setSelectedPath(path)
    setSelected(null)
    void window.api.loadSession(path).then((s) => {
      setSession(s)
      if (s.startedAt != null && s.endedAt != null) {
        setViewWindow({ start: s.startedAt, end: s.endedAt })
      }
    })
  }

  const analyze = async (kind: 'whole' | 'node', focusToolUseId?: string): Promise<void> => {
    if (!selectedPath) return
    const key = selectedPath
    // 按窗口分析时传当前窗口；整会话模式不传
    const win = aiScope === 'window' && viewWindow ? viewWindow : undefined
    setReports((r) => ({ ...r, [key]: { ...EMPTY_REPORT, loading: true } }))
    let acc = ''
    // 只接收本会话（key）的 chunk，避免并发分析时串线
    const off = window.api.onAnalyzeChunk((chunk) => {
      if (chunk.sessionPath !== key) return
      acc += chunk.text
      setReports((r) => ({ ...r, [key]: { ...(r[key] ?? EMPTY_REPORT), text: acc, loading: true } }))
    })
    try {
      const res = await window.api.analyzeReport(kind, selectedPath, focusToolUseId, win)
      if (res.ok) {
        setReports((r) => ({ ...r, [key]: { text: res.text || acc, error: '', claudeId: res.sessionId, loading: false } }))
        setReportWindow(win ?? null)
      } else {
        setReports((r) => ({ ...r, [key]: { text: '', error: res.error ?? '分析失败', claudeId: undefined, loading: false } }))
      }
    } finally {
      off()
    }
  }

  // 窗口模式且窗口已偏离生成报告时的窗口 → 提示重新生成
  const windowChanged = !!reportWindow && !!viewWindow && (reportWindow.start !== viewWindow.start || reportWindow.end !== viewWindow.end)

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

  // 当前选中会话的 ref（取 mtime / size）
  const curRef = sessions.find((s) => s.path === selectedPath)
  const wallMs = session && session.startedAt != null && session.endedAt != null ? session.endedAt - session.startedAt : 0
  const projectLabel = curRef ? curRef.cwd ?? decodeProjectDir(curRef.project) : ''

  return (
    <div style={pageStyle}>
      {session ? (
        <div style={metabarStyle}>
          <span
            className="chip"
            style={{ ...chipStyle, cursor: 'copy' }}
            title={`右键复制会话 ID：${session.sessionId}`}
            onContextMenu={(e) => {
              e.preventDefault()
              onCopy(session.sessionId, '已复制会话 ID')
            }}
          >
            <span style={{ ...dotStyle, background: 'var(--cat-compute)' }} />
            <b>{sessionDisplayTitle(curRef ?? { sessionId: session.sessionId })}</b>
          </span>
          <span className="chip" style={chipStyle}>总耗时 <b>{fmtMs(wallMs)}</b></span>
          {projectLabel ? (
            <span className="chip" style={projectChipStyle} title={`项目 ${projectLabel}`}>
              项目 <b style={pathStyle}>{projectLabel}</b>
            </span>
          ) : null}
          {curRef ? <span className="chip" style={chipStyle}>{fmtRelative(curRef.mtimeMs)}</span> : null}
        </div>
      ) : null}

      <div style={shellStyle}>
        <aside style={{ ...sidebarStyle, width: sidebarW }}>
          <div style={sidebarHeaderStyle}>会话</div>
          <div style={{ flex: 1, minHeight: 0 }}>
            {sessionsLoading ? (
              <div style={loadingStyle}>扫描 ~/.claude/projects 中…</div>
            ) : (
              <SessionList sessions={sessions} onSelect={load} selectedPath={selectedPath} />
            )}
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
                      <TimeTree
                        session={session}
                        onSelect={setSelected}
                        selectedId={selected?.id}
                        viewWindow={viewWindow}
                        onWindowChange={setViewWindow}
                      />
                    </div>
                  }
                  bottom={<DetailPanel node={selected} onAnalyzeAgent={analyzeAgent} />}
                />
              }
              bottom={
                <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', padding: 'var(--sp-1) var(--sp-3)', borderBottom: '1px solid var(--border)', background: 'var(--bg-subtle)' }}>
                    <label className="chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={aiScope === 'window'}
                        onChange={(e) => setAiScope(e.target.checked ? 'window' : 'whole')}
                        style={{ cursor: 'pointer' }}
                      />
                      仅分析所选时间块
                    </label>
                    {aiScope === 'window' && cur.claudeId && windowChanged ? (
                      <span style={{ color: 'var(--accent)', fontSize: 'var(--fs-xs)' }} title="窗口已变化，建议重新生成分析报告">
                        ⚠ 窗口已变化，建议重新生成
                      </span>
                    ) : null}
                    {aiScope === 'whole' && cur.claudeId ? (
                      <span style={{ color: 'var(--text-faint)', fontSize: 'var(--fs-xs)' }}>整会话分析</span>
                    ) : null}
                  </div>
                  <div style={{ flex: 1, minHeight: 0 }}>
                    <AiReport
                      text={cur.text}
                      loading={cur.loading}
                      error={cur.error}
                      sessionId={cur.claudeId}
                      aiScope={aiScope}
                      onGenerate={analyzeWhole}
                      onSave={save}
                      onOpenTerminal={() => {
                        if (cur.claudeId) void window.api.openTerminal(cur.claudeId)
                      }}
                    />
                  </div>
                </div>
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

const pageStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  flex: 1,
  minHeight: 0,
}

const metabarStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  rowGap: 'var(--sp-1)',
  alignItems: 'center',
  gap: 'var(--sp-2)',
  padding: 'var(--sp-1) var(--sp-3)',
  borderBottom: '1px solid var(--border)',
  background: 'var(--bg-subtle)',
  flexShrink: 0,
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

const loadingStyle: React.CSSProperties = {
  padding: 'var(--sp-3)',
  color: 'var(--text-faint)',
  fontSize: 'var(--fs-sm)',
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
