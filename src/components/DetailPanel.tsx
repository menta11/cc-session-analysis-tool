import type { ToolCall, StructuredResult } from '../../core/parser/types'
import type { TreeNode } from '../../core/view/treeView'
import { fmtMs } from '../../core/view/format'

export function DetailPanel(props: {
  node: TreeNode | null
  onAnalyzeAgent: (toolUseId: string) => void
}): JSX.Element {
  const n = props.node
  if (!n) {
    return (
      <div
        style={{
          padding: 'var(--sp-3)',
          minHeight: '100%',
          background: 'var(--bg-elevated)',
          color: 'var(--text-faint)',
          fontSize: 'var(--fs-sm)',
        }}
      >
        点节点查看详情
      </div>
    )
  }
  return (
    <div
      style={{
        padding: 'var(--sp-3)',
        minHeight: '100%',
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--fs-base)',
        background: 'var(--bg-elevated)',
        borderTop: `3px solid ${n.color}`,
      }}
    >
      <div
        style={{
          fontWeight: 700,
          marginBottom: 'var(--sp-2)',
          fontFamily: 'var(--font-sans)',
          display: 'flex',
          alignItems: 'baseline',
          gap: 6,
          flexWrap: 'wrap',
        }}
      >
        {n.label}
        <span style={{ color: 'var(--text-faint)', fontWeight: 400, fontSize: 'var(--fs-sm)' }}>
          · {fmtMs(n.ms)}
          {n.count ? ` · ×${n.count}` : ''}
        </span>
      </div>
      {n.kind === 'agent' && n.call ? <AgentDetail node={n} onAnalyzeAgent={props.onAnalyzeAgent} /> : null}
      {n.kind === 'toolBucket' ? <BucketDetail node={n} /> : null}
      {n.kind === 'waitUser' ? <Hint>轮间间隙（等用户输入）+ AskUserQuestion 区间合计。</Hint> : null}
      {n.kind === 'compute' ? <Hint>LLM 思考+输出（总耗时扣除工具/等待后的补集；含不可剥离的间隙）。</Hint> : null}
    </div>
  )
}

function Hint(props: { children: React.ReactNode }): JSX.Element {
  return (
    <div
      style={{
        padding: 'var(--sp-2) var(--sp-3)',
        background: 'var(--bg-subtle)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--r-md)',
        color: 'var(--text-secondary)',
        fontSize: 'var(--fs-sm)',
        fontFamily: 'var(--font-sans)',
      }}
    >
      {props.children}
    </div>
  )
}

function AgentDetail(props: { node: TreeNode; onAnalyzeAgent: (toolUseId: string) => void }): JSX.Element {
  const sr: StructuredResult | null = props.node.call?.structuredResult ?? null
  return (
    <div>
      {sr && sr.toolName === 'Agent' ? (
        <>
          <div className="kvgrid">
            <span className="k">agentType</span>
            <span className="v">{sr.agentType ?? '-'}</span>
            <span className="k">description</span>
            <span className="v">{sr.description ?? '-'}</span>
            <span className="k">resolvedModel</span>
            <span className="v">{sr.resolvedModel ?? '-'}</span>
            <span className="k">totalDurationMs</span>
            <span className="v">{sr.totalDurationMs != null ? fmtMs(sr.totalDurationMs) : '-'}</span>
          </div>
          <div className="vchips">
            {sr.totalTokens != null ? (
              <span className="vchip"><b>{sr.totalTokens}</b> tokens</span>
            ) : null}
            {sr.totalToolUseCount != null ? (
              <span className="vchip"><b>{sr.totalToolUseCount}</b> tool calls</span>
            ) : null}
            <span className={`vchip${sr.isAsync ? ' ok' : ''}`}>{sr.isAsync ? 'async' : 'sync'}</span>
          </div>
        </>
      ) : (
        <div style={{ color: 'var(--text-faint)' }}>(该 Agent 调用无结构化汇总)</div>
      )}
      {props.node.childSession && props.node.call ? (
        <div style={{ display: 'flex', gap: 'var(--sp-2)', alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={() => props.onAnalyzeAgent(props.node.call!.toolUseId)}>
            用 claude 分析此子agent
          </button>
          <span style={{ color: 'var(--text-faint)', fontSize: 'var(--fs-sm)', fontFamily: 'var(--font-sans)' }}>
            ▸ 树中 ▾ 可展开看内部分解
          </span>
        </div>
      ) : null}
    </div>
  )
}

function BucketDetail(props: { node: TreeNode }): JSX.Element {
  const calls = props.node.calls ?? []
  return (
    <div>
      {calls.map((c, i) => (
        <div key={i} className="bucket-card">
          <div className="name">
            <span>{c.name}</span>
            <span style={{ color: 'var(--text-secondary)', fontWeight: 400 }}>· {fmtMs(c.durationMs ?? 0)}</span>
            {c.isError ? <span className="errbadge">✗ error</span> : null}
          </div>
          <pre>{summarizeInput(c)}</pre>
        </div>
      ))}
    </div>
  )
}

function summarizeInput(c: ToolCall): string {
  const i = c.input ?? {}
  if (typeof i.command === 'string') return i.command
  if (typeof i.file_path === 'string') return i.file_path
  if (typeof i.pattern === 'string') return i.pattern
  if (typeof i.description === 'string') return i.description
  return JSON.stringify(i).slice(0, 200)
}
