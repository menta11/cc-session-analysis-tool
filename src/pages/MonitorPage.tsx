import { useCallback, useEffect, useRef, useState } from 'react'

const PROBE_ATTEMPTS = 3
const PROBE_INTERVAL_MS = 800

type Theme = 'dark' | 'light'

/**
 * 「实时监控」页：iframe 嵌 cc-monitor 的 dashboard (由内嵌 proxy 服务).
 * 数据链路零 IPC —— dashboard 内部直连 http://localhost:PORT 的 HTTP/SSE API;
 * 本页只负责: 拿端口、探测 proxy 存活 (失败给重试遮罩)、转发 dashboard 的
 * postMessage({type:'enter-float'}) 到主进程悬浮窗, 以及把宿主主题同步进
 * iframe (?theme= 首帧 + postMessage 实时切换, dashboard 是独立文档, 不继承 CSS 变量).
 */
export function MonitorPage({ theme }: { theme: Theme }): JSX.Element {
  const [port, setPort] = useState<number | null>(null)
  const [proxyDown, setProxyDown] = useState(false)
  const [probing, setProbing] = useState(true)
  // 重试 = 重新探测 + 重载 iframe
  const [reloadKey, setReloadKey] = useState(0)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    void window.api.getMonitorPort().then((p) => setPort(p))
  }, [])

  // 宿主主题切换 → 通知 dashboard (首帧已由 ?theme= 带入, 这里管实时切换)
  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage({ type: 'theme', theme }, '*')
  }, [theme])

  const syncThemeOnLoad = useCallback((): void => {
    iframeRef.current?.contentWindow?.postMessage({ type: 'theme', theme }, '*')
  }, [theme])

  // dashboard 悬浮框按钮在 iframe 里拿不到 contextBridge → postMessage 通知本页
  useEffect(() => {
    const onMsg = (e: MessageEvent): void => {
      const data = e.data as { type?: string } | null
      if (data?.type === 'enter-float') void window.api.enterFloatMode()
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  const probe = useCallback(async (): Promise<boolean> => {
    // 3 次重试兜底启动竞争 (proxy 在 whenReady 里异步起, 渲染页可能先切到本页)
    for (let i = 0; i < PROBE_ATTEMPTS; i++) {
      if (await window.api.pingMonitor()) return true
      if (i < PROBE_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS))
    }
    return false
  }, [])

  useEffect(() => {
    let cancelled = false
    setProbing(true)
    void probe().then((ok) => {
      if (cancelled) return
      setProxyDown(!ok)
      setProbing(false)
    })
    return () => {
      cancelled = true
    }
  }, [port, reloadKey, probe])

  const retry = (): void => {
    setReloadKey((k) => k + 1)
  }

  return (
    <div style={pageStyle}>
      {port != null ? (
        <iframe
          key={reloadKey}
          ref={iframeRef}
          src={`http://localhost:${port}/?theme=${theme}`}
          title="实时监控 dashboard"
          style={iframeStyle}
          onLoad={syncThemeOnLoad}
        />
      ) : (
        <div style={hintStyle}>获取监控端口中…</div>
      )}
      {proxyDown ? (
        <div style={overlayStyle}>
          <div style={{ fontSize: 'var(--fs-md)', fontWeight: 700, marginBottom: 'var(--sp-2)' }}>
            监控代理未启动
          </div>
          <div style={{ color: 'var(--text-secondary)', marginBottom: 'var(--sp-3)' }}>
            端口 {port ?? '?'} 无响应（可能被旧 cc-monitor 占用）。可从托盘菜单「重启代理」，或点击重试。
          </div>
          <button type="button" className="btn btn-primary" onClick={retry} disabled={probing}>
            {probing ? '探测中…' : '重试'}
          </button>
        </div>
      ) : null}
    </div>
  )
}

const pageStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  position: 'relative',
  display: 'flex',
}

const iframeStyle: React.CSSProperties = {
  flex: 1,
  width: '100%',
  height: '100%',
  border: 'none',
  background: 'var(--bg)', // dashboard 自带同色底, 防加载白闪/黑闪
}

const overlayStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--bg)',
  zIndex: 10,
  textAlign: 'center',
  padding: 'var(--sp-5)',
}

const hintStyle: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'var(--text-faint)',
}
