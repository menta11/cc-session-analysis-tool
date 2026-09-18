import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * claude 报告的展示与三个动作（生成 / 导出 .md / 终端追问）。**树视图与日志视图共用**，
 * 所以它只认「报告正文」，不认「报告是怎么来的」——
 * 生成按钮叫什么、空态提示什么，由调用方用 `generateLabel` / `emptyHint` 给。
 */
export function AiReport(props: {
  text: string
  loading: boolean
  error: string
  sessionId?: string
  /** 生成按钮的字面：树视图按分析范围换（整会话 / 时间块），日志视图是「分析筛选出的记录」 */
  generateLabel: string
  /**
   * 给了就禁用生成按钮，并把它当禁用原因写进 title（如日志视图「当前筛选一条记录都没有」）。
   * 不让调用方自己包一层「点不点得动」的壳：那会让按钮的禁用样式与 title 在两边各写一遍。
   */
  generateDisabledReason?: string
  /** 还没生成过时正文区的提示 */
  emptyHint: string
  onGenerate: () => void
  onSave: () => void
  onOpenTerminal: () => void
}): JSX.Element {
  const { text, loading, error, sessionId, generateLabel, generateDisabledReason, emptyHint, onGenerate, onSave, onOpenTerminal } = props
  const generateDisabled = loading || generateDisabledReason !== undefined
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
        <button
          onClick={onGenerate}
          disabled={generateDisabled}
          title={generateDisabledReason}
          style={btnStyle(generateDisabled)}
        >
          {loading ? '分析中…' : generateLabel}
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
          <div style={{ color: 'var(--text-faint)', fontSize: 'var(--fs-base)' }}>{emptyHint}</div>
        )}
      </div>
    </div>
  )
}
