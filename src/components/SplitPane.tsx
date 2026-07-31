import { useCallback, useRef, useState, type ReactNode } from 'react'

/** 上下可拖动分隔的二分屏。上/下内容随分隔条比例自适应。 */
export function SplitPane(props: { top: ReactNode; bottom: ReactNode; initialRatio?: number }): JSX.Element {
  const [ratio, setRatio] = useState(props.initialRatio ?? 0.62)
  const [dragging, setDragging] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)

  const moveTo = useCallback((clientY: number) => {
    const el = containerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const r = (clientY - rect.top) / rect.height
    setRatio(Math.min(0.92, Math.max(0.08, r)))
  }, [])

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault()
    draggingRef.current = true
    setDragging(true)
    const mm = (ev: MouseEvent) => { if (draggingRef.current) moveTo(ev.clientY) }
    const up = () => {
      draggingRef.current = false
      setDragging(false)
      window.removeEventListener('mousemove', mm)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', mm)
    window.addEventListener('mouseup', up)
  }

  return (
    <div ref={containerRef} style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%' }}>
      <div style={{ height: `${ratio * 100}%`, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
        {props.top}
      </div>
      <div
        onMouseDown={startDrag}
        className={`splitter${dragging ? ' is-dragging' : ''}`}
        style={{ height: 6 }}
        role="separator"
        aria-orientation="horizontal"
      />
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, background: 'var(--bg-subtle)' }}>{props.bottom}</div>
    </div>
  )
}
