import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SessionRef } from '../../core/discovery/scan'
import { decodeProjectDir } from '../../core/discovery/projectDir'
import { fmtRelative, fmtSize, sessionRowLabel, timeBucketLabel } from '../../core/view/format'
import { isBucketOpen, visibleSessions } from '../../core/view/sessionList'
import { Chevron } from './icons'

/**
 * 视图切换的两个标签页。**顺序即渲染顺序，首项即默认视图** —— 两者都从这一份定义出发，
 * 不会出现「改了排列顺序、忘了同步默认值」。
 */
const VIEW_TABS = [
  { id: 'timeline', label: '时间线', title: '按时间倒序平铺' },
  { id: 'project', label: '项目', title: '按项目目录分组' },
] as const

type ListView = (typeof VIEW_TABS)[number]['id']
const DEFAULT_VIEW: ListView = VIEW_TABS[0].id

/**
 * 存储键带版本号：它存的是「用户上次的选择」，**默认值一改就得换键** ——
 * 否则老 WebView 里那条旧值会被当成用户意图读回来，新默认永远不生效
 * （开发态 5173 与成品应用是两个 origin，各自留着一份）。
 */
const VIEW_STORAGE_KEY = 'ccsa-session-view-2'

/**
 * 全表共用一个 IntersectionObserver，登记「行进入视口」。
 *
 * 为什么不用虚拟滚动：本列表按项目分组、可折叠，滚动位置与分组高度耦合，自己实现窗口化要重算
 * 布局；而这里的诉求只是「别读看不见的行」，观察器正好只解决这一件事。
 * 1185 行共用一个观察器实例（每行一个实例的话光构造就上千次）。
 *
 * **观察器在 effect 里建、在清理里拆，重建时把已登记的元素补登记一遍** —— 这条不是洁癖：
 * `<React.StrictMode>` 会把每个 effect 跑成「挂载 → 清理 → 再挂载」，清理里的 `disconnect()`
 * 会丢掉全部登记 —— 于是观察器永久空转、一行元数据都读不回来（2026-09-14 实测：1185 次 observe、
 * 回调 0 次触发、列表只剩时间与大小）。补登记这一步把「谁登记过」这个事实放在 ref 里（跨清理存活），
 * 重建后即可恢复。
 *
 * 返回的登记函数身份稳定 —— 行组件是 memo 的，回调换身份会让整表重渲染。
 */
function useVisibilityRequest(
  onNeedMeta: (ref: SessionRef) => void,
): (el: Element | null, ref: SessionRef) => void {
  const cb = useRef(onNeedMeta)
  cb.current = onNeedMeta
  const targets = useRef(new Map<Element, SessionRef>())
  const observer = useRef<IntersectionObserver | null>(null)

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        io.unobserve(e.target)
        const target = targets.current.get(e.target)
        targets.current.delete(e.target)
        if (target) cb.current(target)
      }
    })
    observer.current = io
    for (const el of targets.current.keys()) io.observe(el)
    return () => {
      io.disconnect()
      observer.current = null
    }
  }, [])

  return useCallback((el: Element | null, ref: SessionRef): void => {
    if (!el) return
    targets.current.set(el, ref)
    if (observer.current) {
      observer.current.observe(el)
      return
    }
    // 宿主没有 IntersectionObserver（极老 WebView）：退化为立即请求，功能不丢，只是不再省
    if (typeof IntersectionObserver === 'undefined') cb.current(ref)
  }, [])
}

/** 存进去的是不是已知视图（旧版本 / 手改过的值一律当没存过，回默认） */
function isListView(v: string | null): v is ListView {
  return VIEW_TABS.some((t) => t.id === v)
}

function getInitialView(): ListView {
  try {
    const saved = localStorage.getItem(VIEW_STORAGE_KEY)
    return isListView(saved) ? saved : DEFAULT_VIEW
  } catch {
    return DEFAULT_VIEW
  }
}

/** 复制文本到剪贴板，返回是否成功（WebView 支持 navigator.clipboard） */
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
  /** 行进入可视区时上报 —— 元数据按需读的触发点（见 core/discovery/metaLoader.ts） */
  onNeedMeta: (ref: SessionRef) => void
  selectedPath?: string
}): JSX.Element {
  const observeRow = useVisibilityRequest(props.onNeedMeta)
  const [query, setQuery] = useState('')
  const [view, setView] = useState<ListView>(getInitialView)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [copiedTip, setCopiedTip] = useState<string | null>(null)
  const copiedTimerRef = useRef<number | null>(null)

  /** 复制并显示「复制成功」提示 1 秒。useCallback：行组件是 memo 的，回调换身份会让 memo 失效 */
  const handleCopy = useCallback((text: string, tip: string): void => {
    void copyText(text)
    setCopiedTip(tip)
    if (copiedTimerRef.current) window.clearTimeout(copiedTimerRef.current)
    copiedTimerRef.current = window.setTimeout(() => setCopiedTip(null), 1000)
  }, [])

  const q = query.trim().toLowerCase()
  // 已知「打开是空表」的会话不进列表（判定见 core/discovery/scan.ts::hasAssistantRecord）
  const visible = useMemo(() => visibleSessions(props.sessions), [props.sessions])
  const filtered = useMemo(
    () =>
      q
        ? visible.filter(
            (s) =>
              s.sessionId.toLowerCase().includes(q) ||
              s.project.toLowerCase().includes(q) ||
              decodeProjectDir(s.project).toLowerCase().includes(q),
          )
        : visible,
    [q, visible],
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

  // 时间线分桶：filtered 已按 mtime 倒序, 顺序遍历切连续桶
  const timelineGroups = useMemo(() => {
    const out: [string, SessionRef[]][] = []
    for (const s of filtered) {
      const label = timeBucketLabel(s.mtimeMs)
      const last = out[out.length - 1]
      if (last && last[0] === label) last[1].push(s)
      else out.push([label, [s]])
    }
    return out
  }, [filtered])

  // 默认只展开第一组（项目视图＝排序里的首个项目，时间线＝最近那段）；重复计算很便宜，不必 memo
  const defaultOpenProject = groups[0]?.[0]
  const defaultOpenBucket = timelineGroups[0]?.[0]
  const projectOpen = (proj: string): boolean => isBucketOpen(open, proj, proj === defaultOpenProject)
  const bucketOpen = (label: string): boolean => isBucketOpen(open, label, label === defaultOpenBucket)

  const switchView = (v: ListView): void => {
    setView(v)
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, v)
    } catch {
      /* 隐私模式等写入失败可忽略 */
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', gap: 'var(--sp-2)', margin: 'var(--sp-2)', alignItems: 'center' }}>
        <input
          className="input"
          placeholder="搜会话 ID 或目录…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ flex: 1, margin: 0, minWidth: 0 }}
        />
        <div style={viewToggleStyle} role="tablist" aria-label="列表视图">
          {VIEW_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              style={view === tab.id ? viewBtnActiveStyle : viewBtnStyle}
              onClick={() => switchView(tab.id)}
              title={tab.title}
              role="tab"
              aria-selected={view === tab.id}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>
      <div style={{ flex: 1, overflow: 'auto' }}>
        {view === 'timeline'
          ? timelineGroups.map(([label, sess]) => (
              <div key={label}>
                <div className="row" onClick={() => toggle(label)} style={bucketHeaderStyle}>
                  <Chevron open={bucketOpen(label)} />
                  <span>
                    {label} <span style={{ fontWeight: 400 }}>({sess.length})</span>
                  </span>
                </div>
                {bucketOpen(label)
                  ? sess.map((s) => (
                      <Row
                        key={s.path}
                        s={s}
                        onSelect={props.onSelect}
                        selected={props.selectedPath === s.path}
                        onCopy={handleCopy}
                        observe={observeRow}
                        showProject
                      />
                    ))
                  : null}
              </div>
            ))
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
              <Chevron open={projectOpen(proj)} />
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
                  onContextMenu={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    handleCopy(groupSub(proj, sess), '已复制完整路径')
                  }}
                  title="右键复制完整路径"
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    color: 'var(--text-faint)',
                    fontWeight: 400,
                    fontSize: 'var(--fs-xs)',
                    // 手型而非 copy：后者是「拖放复制」语义，macOS 画成加号，还会盖掉外层 .row 的手型
                    cursor: 'pointer',
                  }}
                >
                  {groupSub(proj, sess)}
                </span>
              </span>
              <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>({sess.length})</span>
            </div>
            {projectOpen(proj)
              ? sess.map((s) => (
                  <Row
                    key={s.path}
                    s={s}
                    onSelect={props.onSelect}
                    selected={props.selectedPath === s.path}
                    onCopy={handleCopy}
                    observe={observeRow}
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

/** 行标题（会话名称）排版 */
const rowTitleStyle: React.CSSProperties = {
  fontWeight: 600,
  fontSize: 'var(--fs-base)',
  fontFamily: 'var(--font-mono)',
  cursor: 'pointer',
}

/**
 * 无名称时顶上的 ID 排版：小一号 + 单行省略。
 *
 * 字号小一号是算出来的，不是审美：36 字符在 13px 等宽下约 281px，而默认 300px 侧栏的内容宽
 * 只有 276px（行 padding 6px 12px），按原名号会吃掉尾字符 —— ID 的尾段恰恰是区分度所在。
 * 12px 等宽约 259px，留 17px 余量；`nowrap + ellipsis` 兜住侧栏被拖到最窄 180px 的情形。
 */
const rowIdStyle: React.CSSProperties = {
  ...rowTitleStyle,
  fontSize: 'var(--fs-sm)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

/**
 * 行组件。**memo 化是必需的不是优化**：补齐阶段每 200ms 提交一批更新，1185 行的列表若整表重渲染，
 * 每次提交都要重建上千个元素的 props；memo 之后只有真正变化的那几行会重渲染（行对象的身份由
 * `mergeSessionRefs` 保证 —— 未变化的行沿用旧对象）。前提是 `onSelect` / `onCopy` 身份稳定。
 */
const Row = memo(function Row(props: {
  s: SessionRef
  onSelect: (p: string) => void
  selected: boolean
  onCopy: (text: string, tip: string) => void
  observe: (el: Element | null, ref: SessionRef) => void
  /** 时间线视图下无项目分组上下文, 行内补显示项目名 */
  showProject?: boolean
}): JSX.Element {
  const el = useRef<HTMLDivElement | null>(null)
  const label = sessionRowLabel(props.s)

  /**
   * 本行还没有元数据就请一次。
   *
   * **不能加「只请一次」的闸门**：重扫会把整个列表换成骨架（元数据没了），而这份骨架在只有
   * React 重渲染（dev 热更新）时不会重建行实例 —— 闸门一关，这些行就再也不会开口，
   * 「等着这批标题」的转圈指示器于是永远等不到回应。
   *
   * 元数据到了之后 `hasMeta` 为真，effect 重跑时直接返回 —— 不会读一次观察一遍。
   * 观察器对**已经可见**的元素会立刻回调一次，所以重扫后重新观察也能马上拿到回应。
   */
  useEffect(() => {
    if (hasMeta(props.s)) return
    props.observe(el.current, props.s)
  }, [props.s, props.observe])

  return (
    <div
      ref={el}
      className={`row${props.selected ? ' row-selected' : ''}`}
      onClick={() => props.onSelect(props.s.path)}
      title={props.s.sessionId}
      style={{
        padding: '6px 12px',
        borderBottom: '1px solid var(--border-subtle)',
        borderLeft: props.selected ? '2px solid var(--accent)' : '2px solid transparent',
      }}
    >
      {/* 标题块**无条件渲染**：右键复制会话 ID 挂在它上面，条件渲染会让没名称的行连这条路径一起没有 */}
      <div
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          props.onCopy(props.s.sessionId, '已复制会话 ID')
        }}
        title={`右键复制会话 ID：${props.s.sessionId}`}
        style={label.isSessionId ? rowIdStyle : rowTitleStyle}
      >
        {label.text}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 1, color: 'var(--text-faint)', fontSize: 'var(--fs-xs)' }}>
        <span>{fmtRelative(props.s.mtimeMs)}</span>
        <span>·</span>
        <span>{fmtSize(props.s.sizeBytes)}</span>
        {props.showProject ? (
          <>
            <span>·</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {basename(props.s.cwd ?? decodeProjectDir(props.s.project))}
            </span>
          </>
        ) : null}
      </div>
    </div>
  )
})

/** 视图切换（项目/时间线）小分段控件 */
const viewToggleStyle: React.CSSProperties = {
  display: 'inline-flex',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-sm)',
  overflow: 'hidden',
  flexShrink: 0,
}

const viewBtnStyle: React.CSSProperties = {
  padding: '4px 8px',
  border: 'none',
  background: 'var(--bg-elevated)',
  color: 'var(--text-secondary)',
  fontSize: 'var(--fs-xs)',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const viewBtnActiveStyle: React.CSSProperties = {
  ...viewBtnStyle,
  background: 'var(--accent)',
  color: 'var(--on-accent)',
  fontWeight: 600,
}

/** 时间线分桶标题行：可点击折叠（默认展开） */
const bucketHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--sp-1)',
  padding: '6px 10px',
  background: 'var(--bg-active)',
  fontWeight: 600,
  fontSize: 'var(--fs-sm)',
  borderBottom: '1px solid var(--border)',
  color: 'var(--text-secondary)',
  position: 'sticky',
  top: 0,
  cursor: 'pointer',
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

/** 行是否已经带上元数据（有任意一项就够：读了才有，没有就是还没读） */
function hasMeta(s: SessionRef): boolean {
  return s.cwd != null || s.customTitle != null || s.aiTitle != null || s.userPrompt != null
}

/** 取路径末尾目录名（兼容 / 和 \ 分隔符） */
function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || p
}
