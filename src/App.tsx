import { useEffect, useRef, useState } from 'react'
import { AnalyzerPage } from './pages/AnalyzerPage'
import { MonitorPage } from './pages/MonitorPage'

type Theme = 'light' | 'dark'
type Page = 'analyzer' | 'monitor'

const PAGES: { key: Page; label: string }[] = [
  { key: 'analyzer', label: '会话分析' },
  { key: 'monitor', label: '实时监控' },
]

function getInitialTheme(): Theme {
  if (typeof localStorage !== 'undefined') {
    const t = localStorage.getItem('ccsa-theme')
    if (t === 'dark' || t === 'light') return t
  }
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

/** 本地 AI 会话/请求分析工具集：会话分析（离线 JSONL）+ 实时监控（内嵌 cc-monitor proxy） */
export function App(): JSX.Element {
  const [page, setPage] = useState<Page>('analyzer')
  // 监控页懒挂载：首次切到才建 iframe, 之后保持挂载 (切换零开销, 会话分析页状态也不丢)
  const [monitorMounted, setMonitorMounted] = useState(false)
  const [theme, setTheme] = useState<Theme>(getInitialTheme)
  const [copiedTip, setCopiedTip] = useState<string | null>(null)
  const copiedTimerRef = useRef<number | null>(null)

  /** 复制并显示提示气泡 1 秒 */
  const handleCopy = (text: string, tip: string): void => {
    void navigator.clipboard.writeText(text)
    setCopiedTip(tip)
    if (copiedTimerRef.current) window.clearTimeout(copiedTimerRef.current)
    copiedTimerRef.current = window.setTimeout(() => setCopiedTip(null), 1000)
  }

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem('ccsa-theme', theme)
    } catch {
      /* 忽略隐私模式等写入失败 */
    }
  }, [theme])

  return (
    <div style={appStyle}>
      <header style={appbarStyle}>
        <span style={brandStyle}>
          <span style={logoStyle}>C</span>
          Claude 会话工具集
        </span>
        <nav style={tabsStyle} aria-label="页面切换">
          {PAGES.map((p) => (
            <button
              key={p.key}
              type="button"
              style={page === p.key ? tabActiveStyle : tabStyle}
              onClick={() => {
                if (p.key === 'monitor') setMonitorMounted(true)
                setPage(p.key)
              }}
              aria-current={page === p.key ? 'page' : undefined}
            >
              {p.label}
            </button>
          ))}
        </nav>
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

      {/* 两页都保持挂载, display 切换: 分析页会话状态 / 监控页 iframe 实时视图都不因切换丢失 */}
      <div style={{ ...pageHostStyle, display: page === 'analyzer' ? 'flex' : 'none' }}>
        <AnalyzerPage onCopy={handleCopy} />
      </div>
      {monitorMounted ? (
        <div style={{ ...pageHostStyle, display: page === 'monitor' ? 'flex' : 'none' }}>
          <MonitorPage theme={theme} />
        </div>
      ) : null}

      {copiedTip ? (
        <div style={copiedTipStyle} role="status">
          ✓ {copiedTip}
        </div>
      ) : null}
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

/** 页面宿主：占满 header 以下区域，配合 display 切换实现保活 */
const pageHostStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  flexDirection: 'column',
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

const tabsStyle: React.CSSProperties = {
  display: 'flex',
  gap: 2,
  flexShrink: 0,
}

const tabStyle: React.CSSProperties = {
  padding: '5px 14px',
  border: '1px solid transparent',
  borderRadius: 'var(--r-sm)',
  background: 'transparent',
  color: 'var(--text-secondary)',
  fontSize: 'var(--fs-sm)',
  fontWeight: 600,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const tabActiveStyle: React.CSSProperties = {
  ...tabStyle,
  border: '1px solid var(--border)',
  background: 'var(--bg-elevated)',
  color: 'var(--text)',
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
