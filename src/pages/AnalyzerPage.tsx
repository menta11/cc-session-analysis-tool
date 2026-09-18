import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Session } from '../../core/parser/types'
import type { SessionRef } from '../../core/discovery/scan'
import { buildTreeNode, findToolPath, type TreeNode } from '../../core/view/treeView'
import type { LogSummary } from '../../core/view/logView'
import type { LogScope } from '../../core/ai/logDigest'
import { fmtMs, fmtRelative, sessionDisplayTitle } from '../../core/view/format'
import { createMetaLoader } from '../../core/discovery/metaLoader'
import { decodeProjectDir } from '../../core/discovery/projectDir'
import { mergeSessionRefs } from '../../core/view/sessionList'
import type { ViewWindow } from '../../core/view/window'
import { api } from '../api'
import { SessionList } from '../components/SessionList'
import { TimeTree } from '../components/TimeTree'
import { DetailPanel } from '../components/DetailPanel'
import { AiReport } from '../components/AiReport'
import { SplitPane } from '../components/SplitPane'
import {
  EMPTY_LOG_REPORT,
  EMPTY_LOG_VIEW_STATE,
  LogView,
  type LogAnalysis,
  type LogReport,
  type LogViewState,
} from '../components/LogView'
import { FolderIcon, RefreshIcon } from '../components/icons'
import { dirName } from '../../core/paths'
import type { AnalyzeTarget, SaveFilter } from '../api/hostApi'

interface ReportState {
  text: string
  error: string
  claudeId: string | undefined
  loading: boolean
}
const EMPTY_REPORT: ReportState = { text: '', error: '', claudeId: undefined, loading: false }

/** 分段控件的两项。**顺序即渲染顺序（日志在左），首项即默认视图** —— 两处同源，不会各改各的 */
const VIEW_OPTIONS = [
  { value: 'log', label: '日志视图' },
  { value: 'tree', label: '树视图' },
] as const

type ViewMode = (typeof VIEW_OPTIONS)[number]['value']
const DEFAULT_VIEW: ViewMode = VIEW_OPTIONS[0].value

/**
 * 存储键带版本号：它存的是「用户上次的选择」，默认值一改就得换键，否则旧值被当成用户意图
 * 读回来，新默认永远不生效（与列表的 `ccsa-session-view-2` 同一套做法）。
 */
const VIEW_STORAGE_KEY = 'ccsa-analyzer-view-2'

/** 报告导出的保存对话框过滤器（树视图的整会话报告与日志视图的记录分析报告共用） */
const MD_FILTERS: SaveFilter[] = [{ name: 'Markdown', extensions: ['md'] }]

/** 默认文件名带会话短 ID：连着导出几个会话时不会互相覆盖 */
function reportFileName(sessionId: string | undefined, prefix: string): string {
  return `${prefix}-${sessionId?.slice(0, 8) ?? 'session'}.md`
}

/** 异常 → 一句能贴到界面上的话（`Err` 之外的抛出物也得有字） */
function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
const TREE_REPORT_PREFIX = '会话分析报告'
const LOG_REPORT_PREFIX = '记录分析报告'

/** 存进去的是不是已知视图（旧版本 / 手改过的值一律当没存过，回默认） */
function isViewMode(v: string | null): v is ViewMode {
  return VIEW_OPTIONS.some((o) => o.value === v)
}

/** 视图模式持久化：下次打开还是上次那个视图（与列表的项目/时间线同一套做法） */
function getInitialView(): ViewMode {
  try {
    const saved = localStorage.getItem(VIEW_STORAGE_KEY)
    return isViewMode(saved) ? saved : DEFAULT_VIEW
  } catch {
    return DEFAULT_VIEW
  }
}

function persistView(v: ViewMode): void {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, v)
  } catch {
    /* 隐私模式等写入失败可忽略 */
  }
}

/** 元数据回填的合并间隔：滚动时一批批到达，逐条提交会把渲染放大成 O(n²) */
const REFS_FLUSH_MS = 200
/** 遮罩转圈的延迟：命中缓存时可见行几十毫秒就读完，一闪而过的遮罩比不显示更烦人 */
const OVERLAY_DELAY_MS = 180

/**
 * 会话列表状态：扫描出骨架 → 按需回填元数据。
 *
 * 骨架整表换（`replace`，一次扫描一次），元数据增量并（`apply`，按 path 覆盖、去抖提交）。
 * 两件事分开是因为频率差两个量级：骨架一次到位，元数据却在滚动中不断到达。
 */
function useSessionList(): {
  sessions: SessionRef[]
  replace: (refs: SessionRef[]) => void
  apply: (refs: readonly SessionRef[]) => void
} {
  const [sessions, setSessions] = useState<SessionRef[]>([])
  const pending = useRef(new Map<string, SessionRef>())
  const timer = useRef<number | null>(null)

  const cancelTimer = useCallback((): void => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  const apply = useCallback(
    (refs: readonly SessionRef[]): void => {
      for (const r of refs) pending.current.set(r.path, r)
      if (timer.current !== null) return
      timer.current = window.setTimeout(() => {
        timer.current = null
        const buf = pending.current
        if (buf.size === 0) return
        pending.current = new Map()
        setSessions((prev) => mergeSessionRefs(prev, [...buf.values()]))
      }, REFS_FLUSH_MS)
    },
    [],
  )

  const replace = useCallback(
    (refs: SessionRef[]): void => {
      pending.current = new Map()
      cancelTimer()
      setSessions(refs)
    },
    [cancelTimer],
  )

  // 卸载时取消未提交的定时器；缓冲内容随组件一起丢弃
  useEffect(() => cancelTimer, [cancelTimer])

  return { sessions, replace, apply }
}

/** 「会话分析」页：离线解析 ~/.claude/projects 的 JSONL, 递归工作/等待分解 + AI 报告 */
export function AnalyzerPage({ onCopy }: { onCopy: (text: string, tip: string) => void }): JSX.Element {
  const { sessions, apply: applyRefs, replace: replaceRefs } = useSessionList()
  const [sessionsLoading, setSessionsLoading] = useState(true)
  const [sessionsError, setSessionsError] = useState<string | null>(null)
  /**
   * 请了还没回应的行（按 path）。**转圈遮罩与「补全标题…」都由它驱动** —— 只有真有请求在飞时才转。
   *
   * 不能用「所有行都有标题了吗」当判据：那要求把 1186 个会话全读一遍，而这套设计只读看得见的行
   * （见 core/discovery/metaLoader.ts），于是它恒为假，只能靠某次回应碰巧把它翻回来 ——
   * dev 热更新后左栏永久转圈就是踩在这个上。
   */
  const [pendingMeta, setPendingMeta] = useState<ReadonlySet<string>>(new Set())
  const [overlayDue, setOverlayDue] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [session, setSession] = useState<Session | null>(null)
  const [selected, setSelected] = useState<TreeNode | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | undefined>()
  const [reports, setReports] = useState<Record<string, ReportState>>({})
  const cur = reports[selectedPath ?? ''] ?? EMPTY_REPORT
  /** 日志视图那一份报告，与树视图的 `reports` 分开：同一次筛选分析不该覆盖另一份的正文 */
  const [logReports, setLogReports] = useState<Record<string, LogReport>>({})
  const logCur = logReports[selectedPath ?? ''] ?? EMPTY_LOG_REPORT
  /** 分析面板是否展开（同样是「用户上次的选择」，与报告正文一样由本页持有） */
  const [logOpen, setLogOpen] = useState(false)
  /**
   * 日志视图的筛选与排序。**必须由本页持有**：日志视图是按需挂载的（切到树视图即卸载），
   * 状态留在组件里会在切走的瞬间归零 —— 而面板里的报告还在，于是它立刻被判成「筛选已变化」，
   * 用户什么都没改却被告知报告过期。与下方时间选区 `logWindow` 是同一条理由。
   */
  const [logView, setLogView] = useState<LogViewState>(EMPTY_LOG_VIEW_STATE)
  const [sidebarW, setSidebarW] = useState(300)
  const [view, setView] = useState<ViewMode>(getInitialView)
  /** 日志视图「在树视图定位」算出的展开路径（下标逐层，见 core/view/treeView.ts 的 findToolPath） */
  const [revealPath, setRevealPath] = useState<number[] | undefined>(undefined)
  // 甘特图视图窗口（默认全会话范围，会话加载后设置）
  const [viewWindow, setViewWindow] = useState<{ start: number; end: number } | null>(null)
  /**
   * 日志视图的时间选区（在时间栏上拉出来的那一段）。
   *
   * 与 `viewWindow` **各自独立**：那个管树视图的统计口径与 AI 的「仅分析所选时间块」，
   * 这个只管日志表筛出哪一段。放在这一层而不是 LogView 内部，是因为日志视图是按需挂载的 ——
   * 「点 ID 去树视图看一眼再回来」这条最常见的交叉操作会让组件内的状态丢掉。
   */
  const [logWindow, setLogWindow] = useState<ViewWindow | null>(null)
  // AI 分析范围：整会话 或 按当前窗口
  const [aiScope, setAiScope] = useState<'whole' | 'window'>('whole')
  // 生成报告时的窗口（用于「窗口已变化」提示）
  const [reportWindow, setReportWindow] = useState<{ start: number; end: number } | null>(null)
  /** 「打开位置」失败时的原因（正常情况为 null；起进程失败很罕见但不能吞） */
  const [dirError, setDirError] = useState<string | null>(null)

  /**
   * 在系统文件管理器里打开该会话 jsonl 所在的目录（`~/.claude/projects/<project>/`）——
   * 不是会话里那个 cwd（那是被分析的项目），是这份 transcript 自己的落盘位置。
   *
   * 失败文案带上「打开文件夹」这个动作：宿主那条错误是中性的（同一个原语也开终端），
   * 光看「启动进程失败（explorer）」用户不知道自己点的那一下要干什么。
   */
  const openSessionDir = useCallback(async (): Promise<void> => {
    if (!selectedPath) return
    const res = await api.openDir(dirName(selectedPath))
    setDirError(res.ok ? null : res.error ? `打开文件夹失败：${res.error}` : '打开文件夹失败')
  }, [selectedPath])

  /**
   * 元数据加载器：队列表、去重、缓存命中判定都在 core（可单测），宿主只提供
   * 「读一个文件」「读缓存」「写缓存」三个薄动作（见 `src/api/tauri.ts`）。
   */
  const loader = useMemo(
    () =>
      createMetaLoader({
        read: (path) => api.readSessionMeta(path),
        onLoaded: (refs) => {
          // 每一条回应都对应一次 request：收账（失败的那条也走这里，它的元数据就是空的）
          setPendingMeta((prev) => {
            if (!refs.some((r) => prev.has(r.path))) return prev
            const next = new Set(prev)
            for (const r of refs) next.delete(r.path)
            return next
          })
          applyRefs(refs)
        },
        loadCache: () => api.loadMetaCache(),
        persistCache: (cache) => void api.saveMetaCache(cache),
      }),
    [applyRefs],
  )

  const loadSessions = useCallback(async (): Promise<void> => {
    try {
      // 只拿骨架（read_dir + stat）：本机 1185 个会话实测 82 ms。文件内容一个字都不读 ——
      // 谁被看见谁才读，见 loader 与 core/discovery/metaLoader.ts 的头注释。
      const list = await api.scanProjects()
      replaceRefs(list)
      // 重扫把列表换成骨架：已在读的那几条继续等自己的回应，其余的行被看见时会再请一次
      loader.setScope(list.map((s) => s.path))
      setSessionsError(null)
    } catch (err) {
      // 扫描失败必须落到「有错误可看 + 可重试」，绝不能让 loading 常驻
      // （曾经：rejection 无人接管 → 列表永久停在「扫描中…」）
      setSessionsError(err instanceof Error ? err.message : String(err))
    } finally {
      setSessionsLoading(false)
    }
  }, [replaceRefs, loader])

  /** 行进入可视区 → 请它的元数据。loader 幂等，滚动中反复进来重复请求没有代价。 */
  const requestMeta = useCallback(
    (ref: SessionRef): void => {
      setPendingMeta((prev) => (prev.has(ref.path) ? prev : new Set(prev).add(ref.path)))
      loader.request(ref)
    },
    [loader],
  )

  useEffect(() => {
    void loadSessions()
  }, [loadSessions])

  /** 有请求在飞 = 有人正等着标题；读得快（缓存命中）时这点等待看不见，遮罩因此还延后一拍 */
  const readingMeta = pendingMeta.size > 0
  const showTitleOverlay = overlayDue && readingMeta
  useEffect(() => {
    if (!readingMeta) {
      setOverlayDue(false)
      return
    }
    const t = window.setTimeout(() => setOverlayDue(true), OVERLAY_DELAY_MS)
    return () => window.clearTimeout(t)
  }, [readingMeta])

  /** 手动刷新会话列表：cc-monitor 挂后台期间新会话/标题持续产生，无需重启应用 */
  const refresh = (): void => {
    if (refreshing) return
    setRefreshing(true)
    void loadSessions().finally(() => setRefreshing(false))
  }

  // 文件菜单「导入会话」：主进程打开对话框后把路径推过来
  useEffect(() => api.onImportSession((path) => load(path)), [])

  /** useCallback：作为 onSelect 传给 memo 化的行组件，换身份会让整表重渲染 */
  const load = useCallback((path: string): void => {
    setSelectedPath(path)
    setSelected(null)
    // 换会话必须清掉时间选区：上一个会话的时刻落在这个会话里也「合法」，
    // 留着它会悄悄筛掉一堆行，而用户看着一个自己没拉过的选区无从解释
    setLogWindow(null)
    // 同理清掉上一次「打开位置」的报错 —— 留着它，看起来像是新选的会话也失败了
    setDirError(null)
    void api.loadSession(path).then((s) => {
      setSession(s)
      if (s.startedAt != null && s.endedAt != null) {
        setViewWindow({ start: s.startedAt, end: s.endedAt })
      }
    })
  }, [])

  /** 树视图的分析：`target` 就是交给宿主的那份请求，本函数只负责流式状态的收与发 */
  const analyze = async (target: AnalyzeTarget): Promise<void> => {
    if (!selectedPath) return
    const key = selectedPath
    setReports((r) => ({ ...r, [key]: { ...EMPTY_REPORT, loading: true } }))
    let acc = ''
    // 只接收本会话（key）树视图那一份 chunk：日志视图的分析在同一个会话上可能同时在跑（见 AnalyzeTag）
    const off = api.onAnalyzeChunk((chunk) => {
      if (chunk.sessionPath !== key || chunk.tag !== 'tree') return
      acc += chunk.text
      setReports((r) => ({ ...r, [key]: { ...(r[key] ?? EMPTY_REPORT), text: acc, loading: true } }))
    })
    try {
      const res = await api.analyzeReport(key, target)
      if (res.ok) {
        setReports((r) => ({ ...r, [key]: { text: res.text || acc, error: '', claudeId: res.sessionId, loading: false } }))
        // 只有整会话模式才有「生成时的窗口」这个概念，节点分析不参与那条过期判据
        setReportWindow(target.kind === 'whole' ? target.window ?? null : null)
      } else {
        setReports((r) => ({ ...r, [key]: { text: '', error: res.error ?? '分析失败', claudeId: undefined, loading: false } }))
      }
    } catch (err) {
      // 子进程本身的失败都走 `ok:false`（见 claudeCli），能落到这里的是 IPC 层炸了
      // （事件通道被裁、invoke 失败…）。**不接住就会永久停在「生成中」**：按钮一直禁用、正文
      // 一直空着，而屏幕上没有一个字说发生了什么 —— 「静默消失」正是本仓最忌讳的那种失败。
      setReports((r) => ({ ...r, [key]: { ...EMPTY_REPORT, error: `分析失败：${msgOf(err)}` } }))
    } finally {
      off()
    }
  }

  /**
   * 日志视图的分析：输入是**视图此刻筛出来的那批记录**（scope），不是整个会话。
   * 报告状态与树视图那份分开存（`logReports`），两者可以同时存在、互不覆盖。
   */
  const analyzeLog = useCallback(
    async (scope: LogScope, summary: LogSummary): Promise<void> => {
      if (!selectedPath) return
      const key = selectedPath
      const label = scope.filterLabel
      setLogOpen(true) // 点生成就把面板摊开：否则报告在折叠着的面板里流式输出，用户什么也看不到
      setLogReports((r) => ({ ...r, [key]: { ...EMPTY_LOG_REPORT, label, loading: true } }))
      let acc = ''
      const off = api.onAnalyzeChunk((chunk) => {
        if (chunk.sessionPath !== key || chunk.tag !== 'log') return
        acc += chunk.text
        setLogReports((r) => ({ ...r, [key]: { ...(r[key] ?? EMPTY_LOG_REPORT), text: acc, loading: true } }))
      })
      const done = (patch: Partial<LogReport>): void =>
        setLogReports((r) => ({ ...r, [key]: { ...EMPTY_LOG_REPORT, label, ...patch } }))
      try {
        const res = await api.analyzeReport(key, { kind: 'log', scope, summary })
        if (res.ok) done({ text: res.text || acc, claudeId: res.sessionId })
        else done({ error: res.error ?? '分析失败' })
      } catch (err) {
        // 同 `analyze`：IPC 层炸了必须变成一句话，否则面板永久停在「生成中…」
        done({ error: `分析失败：${msgOf(err)}` })
      } finally {
        off()
      }
    },
    [selectedPath],
  )

  /**
   * 导出报告为 .md：选路径 → 写盘。三个结果分开报，**因为调用方要据此决定动不动 `error`**：
   * 成功要把上一次的「导出失败」擦掉（否则红字与已落盘的事实打架），取消则什么都不该改。
   * 树视图与日志视图共用一份：两处只差一个文件名，各写一遍就会有一处忘了处理写盘失败。
   */
  const exportReport = useCallback(
    async (text: string, fileName: string): Promise<{ saved: boolean; error: string }> => {
      if (!text) return { saved: false, error: '' }
      const path = await api.chooseSavePath(fileName, MD_FILTERS)
      if (!path) return { saved: false, error: '' } // 用户取消：不是错误，也不动现有提示
      try {
        await api.writeTextFile(path, text)
        return { saved: true, error: '' }
      } catch (err) {
        // 写盘失败（权限/路径）必须说出来 —— 静默失败会让人以为导出成功了
        return { saved: false, error: `导出失败：${msgOf(err)}` }
      }
    },
    [],
  )

  // 窗口模式且窗口已偏离生成报告时的窗口 → 提示重新生成
  const windowChanged = !!reportWindow && !!viewWindow && (reportWindow.start !== viewWindow.start || reportWindow.end !== viewWindow.end)

  const analyzeWhole = (): void => {
    // 按窗口分析时传当前窗口；整会话模式不传（宿主那边 `window` 缺席就是「整会话」）
    void analyze({ kind: 'whole', window: aiScope === 'window' ? viewWindow ?? undefined : undefined })
  }

  const analyzeAgent = (toolUseId: string): void => {
    void analyze({ kind: 'node', focusToolUseId: toolUseId })
  }

  /** 把导出结果写回对应报告 —— 面板本来就在显示那份报告，提示跟着它走最容易被看到 */
  const saveTreeReport = async (): Promise<void> => {
    if (!selectedPath) return
    const key = selectedPath
    const r = await exportReport(cur.text, reportFileName(session?.sessionId, TREE_REPORT_PREFIX))
    if (r.saved || r.error) setReports((prev) => ({ ...prev, [key]: { ...(prev[key] ?? EMPTY_REPORT), error: r.error } }))
  }

  const saveLogReport = useCallback(async (): Promise<void> => {
    if (!selectedPath) return
    const key = selectedPath
    const r = await exportReport(logCur.text, reportFileName(session?.sessionId, LOG_REPORT_PREFIX))
    if (r.saved || r.error) {
      setLogReports((prev) => ({ ...prev, [key]: { ...(prev[key] ?? EMPTY_LOG_REPORT), error: r.error } }))
    }
  }, [selectedPath, logCur.text, session?.sessionId, exportReport])

  const openLogTerminal = useCallback((): void => {
    if (logCur.claudeId) void api.openTerminal(logCur.claudeId)
  }, [logCur.claudeId])

  /** 交给 LogView 的那份包：身份稳住，行组件的 memo 才不会被一次无关渲染掀翻 */
  const logAnalysis: LogAnalysis = useMemo(
    () => ({
      report: logCur,
      open: logOpen,
      setOpen: setLogOpen,
      run: (scope, summary) => void analyzeLog(scope, summary),
      save: () => void saveLogReport(),
      openTerminal: openLogTerminal,
    }),
    [logCur, logOpen, analyzeLog, saveLogReport, openLogTerminal],
  )

  /** 切视图（并记住选择）。树视图不卸载，所以分隔条比例/滚动位置都留着 */
  const switchView = useCallback((v: ViewMode): void => {
    setView(v)
    persistView(v)
  }, [])

  /** 日志视图「在树视图定位」：算出展开路径 → 选中该节点 → 切到树视图 */
  const locate = useCallback(
    (toolUseId: string): void => {
      if (!session) return
      const hit = findToolPath(buildTreeNode(session), toolUseId)
      if (!hit) return
      setRevealPath(hit.path)
      setSelected(hit.node)
      setView('tree')
      persistView('tree')
    },
    [session],
  )

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
          {/* chip 只有右键复制、没有左键行为 → 默认箭头（手型会诱导点击）；不能用 `copy`，macOS 画成加号 */}
          <span
            className="chip"
            style={{ ...chipStyle, cursor: 'default' }}
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
          <button
            type="button"
            className="btn"
            style={dirBtnStyle}
            onClick={() => void openSessionDir()}
            title="在文件管理器中打开该会话所在的文件夹"
          >
            <FolderIcon />
            打开位置
          </button>
          {dirError ? <span style={dirErrorStyle}>{dirError}</span> : null}
          <div style={{ flex: 1, height: 1 }} />
          <ViewSwitch view={view} onSwitch={switchView} />
        </div>
      ) : null}

      <div style={shellStyle}>
        <aside style={{ ...sidebarStyle, width: sidebarW }}>
          <div style={sidebarHeaderStyle}>
            <span>会话</span>
            {readingMeta ? <span style={metaChipStyle}>补全标题…</span> : null}
            <button
              type="button"
              onClick={refresh}
              disabled={refreshing}
              title={refreshing ? '扫描中…' : '刷新会话列表'}
              aria-label="刷新会话列表"
              style={{ ...refreshBtnStyle, ...(refreshing ? { opacity: 0.6, cursor: 'wait' } : {}) }}
            >
              <RefreshIcon spinning={refreshing} />
            </button>
          </div>
          <div style={sidebarBodyStyle}>
            {sessionsLoading ? (
              <div style={loadingStyle}>扫描 ~/.claude/projects 中…</div>
            ) : (
              <>
                {sessionsError ? (
                  <div style={scanErrorStyle} role="alert">
                    <div>扫描会话列表失败</div>
                    <div style={scanErrorDetailStyle}>{sessionsError}</div>
                    <button type="button" onClick={refresh} style={retryBtnStyle}>
                      重试
                    </button>
                  </div>
                ) : null}
                {/* 出错时若已有列表仍照常显示 —— 报错不吞掉可用数据 */}
                <div style={listHostStyle}>
                  <SessionList
                    sessions={sessions}
                    onSelect={load}
                    onNeedMeta={requestMeta}
                    selectedPath={selectedPath}
                  />
                  {/* 可见行的标题还在读 → 整表遮罩转圈。延后一点才显示：命中缓存时几十毫秒就好，
                      一闪而过的遮罩比不显示更烦人（见 OVERLAY_DELAY_MS）。 */}
                  {showTitleOverlay ? (
                    <div style={overlayStyle} role="status">
                      <RefreshIcon spinning size={22} />
                      <span>载入中…</span>
                    </div>
                  ) : null}
                </div>
              </>
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
            <>
            {/* 树视图常驻（display 隐藏）：分隔条比例、滚动位置、展开状态都跟着留着；
                日志视图反过来按需挂载 —— 它可能有上千行，留着 DOM 是纯浪费 */}
            <div style={{ ...viewHostStyle, display: view === 'log' ? 'none' : 'flex' }}>
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
                          revealPath={revealPath}
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
                        generateLabel={aiScope === 'window' ? '生成时间块分析' : '生成整会话分析'}
                        emptyHint="点击「生成整会话分析」开始；或在子 agent 节点点「用 claude 分析此子agent」。"
                        onGenerate={analyzeWhole}
                        onSave={() => void saveTreeReport()}
                        onOpenTerminal={() => {
                          if (cur.claudeId) void api.openTerminal(cur.claudeId)
                        }}
                      />
                    </div>
                  </div>
                }
              />
            </div>
            {view === 'log' ? (
              <div style={{ ...viewHostStyle, display: 'flex' }}>
                <LogView
                  session={session}
                  onCopy={onCopy}
                  onLocate={locate}
                  analysis={logAnalysis}
                  state={logView}
                  setState={setLogView}
                  selection={logWindow}
                  onSelectionChange={setLogWindow}
                />
              </div>
            ) : null}
            </>
          ) : (
            <EmptyState />
          )}
        </main>
      </div>
    </div>
  )
}

/** 元信息栏右侧的「树视图 / 日志视图」分段控件 */
function ViewSwitch(props: { view: ViewMode; onSwitch: (v: ViewMode) => void }): JSX.Element {
  return (
    <div style={viewSwitchStyle} role="tablist" aria-label="分析视图">
      {VIEW_OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={props.view === o.value}
          onClick={() => props.onSwitch(o.value)}
          style={props.view === o.value ? viewTabActiveStyle : viewTabStyle}
        >
          {o.label}
        </button>
      ))}
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

/** 元信息栏里的动作按钮：借通用 `.btn`，只把它压到与旁边 chip 同高 */
const dirBtnStyle: React.CSSProperties = { fontSize: 'var(--fs-xs)', padding: '2px 8px' }

const dirErrorStyle: React.CSSProperties = { color: 'var(--danger)', fontSize: 'var(--fs-xs)' }

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
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '8px 12px',
  fontWeight: 700,
  fontSize: 'var(--fs-sm)',
  color: 'var(--text-tertiary)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  borderBottom: '1px solid var(--border)',
}

const refreshBtnStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 22,
  height: 22,
  padding: 0,
  border: '1px solid var(--border)',
  background: 'var(--bg-elevated)',
  color: 'var(--text-secondary)',
  borderRadius: 'var(--r-sm)',
  cursor: 'pointer',
  flexShrink: 0,
  transition: 'background var(--transition-fast), color var(--transition-fast)',
}

const loadingStyle: React.CSSProperties = {
  padding: 'var(--sp-3)',
  color: 'var(--text-faint)',
  fontSize: 'var(--fs-sm)',
}

/** 列表宿主：遮罩要相对它定位 */
const listHostStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  position: 'relative',
}

/** 整表遮罩转圈：可见行的标题未就绪时盖住列表，避免「列表像空的」的错觉 */
const overlayStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 'var(--sp-2)',
  background: 'var(--bg-subtle)',
  color: 'var(--text-secondary)',
  fontSize: 'var(--fs-sm)',
}

/** 侧栏主体：错误横幅 + 列表纵向排布，列表占满剩余高度 */
const sidebarBodyStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
}

/** 「补全标题…」：骨架已可见、元数据仍在补齐时的轻提示 */
const metaChipStyle: React.CSSProperties = {
  fontWeight: 400,
  fontSize: 'var(--fs-xs)',
  color: 'var(--text-faint)',
  textTransform: 'none',
  letterSpacing: 0,
  marginLeft: 'auto',
  marginRight: 'var(--sp-2)',
}

/** 扫描失败态：给出可读错误 + 重试入口，替代「loading 常驻」的静默失败 */
const scanErrorStyle: React.CSSProperties = {
  padding: 'var(--sp-3)',
  color: 'var(--text-secondary)',
  fontSize: 'var(--fs-sm)',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--sp-2)',
  alignItems: 'flex-start',
}

const scanErrorDetailStyle: React.CSSProperties = {
  color: 'var(--text-faint)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-xs)',
  wordBreak: 'break-word',
}

const retryBtnStyle: React.CSSProperties = {
  padding: '4px 12px',
  border: '1px solid var(--border)',
  background: 'var(--bg-elevated)',
  color: 'var(--text)',
  borderRadius: 'var(--r-sm)',
  cursor: 'pointer',
  fontSize: 'var(--fs-sm)',
}

const mainStyle: React.CSSProperties = { flex: 1, minWidth: 0 }

/** 视图宿主：树视图与日志视图共用一块区域，同一时刻只显示一个 */
const viewHostStyle: React.CSSProperties = {
  height: '100%',
  flexDirection: 'column',
}

const viewSwitchStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 2,
  padding: 2,
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-md)',
  background: 'var(--bg-elevated)',
  flexShrink: 0,
}

const viewTabStyle: React.CSSProperties = {
  padding: '3px 10px',
  border: 'none',
  borderRadius: 'var(--r-sm)',
  background: 'transparent',
  color: 'var(--text-tertiary)',
  fontSize: 'var(--fs-xs)',
  fontWeight: 600,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const viewTabActiveStyle: React.CSSProperties = {
  ...viewTabStyle,
  background: 'var(--accent)',
  color: 'var(--on-accent)',
}

const emptyStyle: React.CSSProperties = {
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 'var(--sp-5)',
  textAlign: 'center',
}
