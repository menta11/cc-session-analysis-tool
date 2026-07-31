import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export function AiReport(props: {
  text: string
  loading: boolean
  error: string
  sessionId?: string
  onGenerate: () => void
  onSave: () => void
  onOpenTerminal: () => void
}): JSX.Element {
  const { text, loading, error, sessionId, onGenerate, onSave, onOpenTerminal } = props
  const btn: React.CSSProperties = {
    padding: '4px 12px',
    border: '1px solid var(--border-strong)',
    background: 'var(--bg-elevated)',
    color: 'var(--text)',
    borderRadius: 'var(--r-sm)',
    cursor: 'pointer',
    fontSize: 'var(--fs-base)',
  }
  const btnStyle = (disabled: boolean): React.CSSProperties =>
    disabled ? { ...btn, opacity: 0.5, cursor: 'not-allowed' } : btn

  return (
    <div style={{ padding: 'var(--sp-3)', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ marginBottom: 'var(--sp-2)', display: 'flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
        <button onClick={onGenerate} disabled={loading} style={btnStyle(loading)}>
          {loading ? '分析中…' : '生成整会话分析'}
        </button>
        <button onClick={onSave} disabled={!text || loading} style={btnStyle(!text || loading)}>
          导出 .md
        </button>
        <button
          onClick={onOpenTerminal}
          disabled={!sessionId || loading}
          style={btnStyle(!sessionId || loading)}
          title={sessionId ? `续接 claude 会话 ${sessionId.slice(0, 8)}` : '需先生成一次分析'}
        >
          打开 claude 终端继续追问
        </button>
        <span style={{ color: 'var(--text-faint)', fontSize: 'var(--fs-sm)' }}>
          调本机 claude CLI，复用已登录、无需 API key；流式输出
        </span>
        {sessionId ? (
          <span style={{ marginLeft: 'auto', color: 'var(--text-faint)', fontSize: 'var(--fs-xs)' }} title="claude 会话 id（备追问）">
            session {sessionId.slice(0, 8)}…
          </span>
        ) : null}
      </div>
      {error ? (
        <div style={{ color: 'var(--danger)', marginBottom: 'var(--sp-1)', fontSize: 'var(--fs-base)' }}>
          {error}
        </div>
      ) : null}
      <div
        className="md-report"
        style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: 'var(--sp-1) 0' }}
      >
        {loading && !text ? (
          <div style={{ color: 'var(--text-faint)', fontSize: 'var(--fs-base)' }}>
            正在调用 claude 分析（流式输出中，约 1–5 分钟）…
          </div>
        ) : text ? (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
        ) : (
          <div style={{ color: 'var(--text-faint)', fontSize: 'var(--fs-base)' }}>
            点击「生成整会话分析」开始；或在子 agent 节点点「用 claude 分析此子agent」。
          </div>
        )}
      </div>
    </div>
  )
}
