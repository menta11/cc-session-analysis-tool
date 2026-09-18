import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { Session } from '../../core/parser/types'
import {
  DURATION_SCALE_COLOR,
  DURATION_SORTS,
  EMPTY_DURATION_QUERY,
  LOG_KIND_STYLE,
  LOG_KINDS,
  axisForWindow,
  axisPos,
  buildLogRows,
  buildTimeline,
  describeLogFilter,
  durationBounds,
  durationSortOption,
  filterLogRows,
  fmtRowTokens,
  kindLabelOf,
  logBoundaries,
  logSpanLabel,
  logSummary,
  nextDurationSort,
  rowSpan,
  sortLogRows,
  timeAxisOf,
  withDurationOp,
  LOG_STATUS_LABEL,
  type DurationOp,
  type DurationQuery,
  type DurationSort,
  type DurationSortOption,
  type LogFilter,
  type LogPanel,
  type LogRow,
  type LogRowKind,
  type LogRowStatus,
  type LogSummary,
  type TimeAxis,
  type TimelineBlock,
} from '../../core/view/logView'
import { CATEGORY_COLORS, subagentLabel } from '../../core/view/treeView'
import {
  clampWindow,
  dragWindowEdge,
  snapToSegmentBoundary,
  windowAround,
  type ViewWindow,
} from '../../core/view/window'
import { MS_PER_MINUTE, durationScale, fmtClock, fmtDuration, fmtMs, fmtPct1, type DurationScale } from '../../core/view/format'
import { MAX_DIGEST_ROWS, type LogScope } from '../../core/ai/logDigest'
import { AiReport } from './AiReport'
import { AnalyzeIcon, Chevron, SearchIcon } from './icons'

/** 日志分析报告的状态。由父组件持有 —— 本视图切走即卸载，报告不能跟着没。 */
export interface LogReport {
  text: string
  loading: boolean
  error: string
  /** claude 会话 id（生成成功才有），用于「打开终端继续追问」 */
  claudeId?: string
  /** 生成这份报告时的筛选说明；与当前筛选不一致就是过期报告（见 LogAnalysis.staleHint） */
  label: string
}

export const EMPTY_LOG_REPORT: LogReport = { text: '', loading: false, error: '', label: '' }

/**
 * 日志视图的 claude 分析：状态在父组件，触发在父组件，本视图只负责「把当前所见交出去」与展示。
 *
 * 父组件持有报告（而非本视图）的原因与时间选区一致：本视图是按需挂载的，切到树视图再回来
 * 就得连报告一起丢，而「对着同一批记录来回看」正是最常发生的操作。
 */
export interface LogAnalysis {
  report: LogReport
  open: boolean
  setOpen: (open: boolean) => void
  /** 生成：scope 是**本视图此刻**的所见（筛选后 + 已排序），父组件原样转给 claude */
  run: (scope: LogScope, summary: LogSummary) => void
  save: () => void
  openTerminal: () => void
}

/**
 * 筛选与排序。**由父组件持有**，与时间选区 `selection` 同一条理由：
 *
 * 本视图是按需挂载的（切到树视图就卸载），筛选状态留在组件里会在切走的瞬间归零。
 * 那不只是「筛选没了」——面板还持有一份按旧筛选生成的报告，于是它立刻被判成「筛选已变化」，
 * 用户什么都没改却被告知报告过期，而且再也回不到同一份分析（筛选条件已经无从复现）。
 */
export interface LogViewState {
  kinds: LogRowKind[]
  statuses: LogRowStatus[]
  query: string
  duration: DurationQuery
  sort: DurationSort
}

export const EMPTY_LOG_VIEW_STATE: LogViewState = {
  kinds: [],
  statuses: [],
  query: '',
  duration: EMPTY_DURATION_QUERY,
  sort: 'normal',
}

/**
 * 日志视图（设计稿「日志列表」页的主区）：把会话摊成一条条记录来看。
 *
 * 与树视图共用同一份解析结果与类别配色，所以切来切去不会看到两套数字：
 * 汇总条直接读 `logSummary`（= `breakdownOf`），行的类别色读 `LOG_KIND_STYLE`（= 类别变量）。
 *
 * 时间选区（`selection`）由父组件持有：本视图是**按需挂载**的（切走即卸载），
 * 而「点 ID 去树视图看一眼再回来」是最常见的交叉操作，放在组件里选区就没了。
 * claude 分析的报告（`analysis`）同理。
 */
export function LogView(props: {
  session: Session
  onCopy: (text: string, tip: string) => void
  /** 在树视图定位该记录（只有工具/委派记录是树上的节点） */
  onLocate: (toolUseId: string) => void
  /** claude 分析：状态与控制（见 LogAnalysis） */
  analysis: LogAnalysis
  /** 筛选与排序（见 LogViewState） */
  state: LogViewState
  setState: Dispatch<SetStateAction<LogViewState>>
  /** 时间栏上拉选出来的那一段（绝对时刻）；null = 未选 */
  selection: ViewWindow | null
  onSelectionChange: (w: ViewWindow | null) => void
}): JSX.Element {
  const { session, onCopy, onLocate, analysis, state, setState, selection, onSelectionChange } = props
  const { kinds, statuses, query, duration, sort } = state
  const rows = useMemo(() => buildLogRows(session), [session])
  const summary = useMemo(() => logSummary(session), [session])

  const [openId, setOpenId] = useState<string | null>(null)
  /** 时间栏刚跳过来的那一行：短暂高亮，否则滚过去也认不出是哪条 */
  const [flashId, setFlashId] = useState<string | null>(null)
  const tableRef = useRef<HTMLDivElement>(null)
  const flashTimer = useRef<number | null>(null)

  /** 改其中一两项。函数式更新，免得同一拍里连改两处时后一次覆盖前一次 */
  const patch = useCallback(
    (p: Partial<LogViewState>): void => setState((prev) => ({ ...prev, ...p })),
    [setState],
  )
  const setKinds = useCallback((k: LogRowKind[]): void => patch({ kinds: k }), [patch])
  const setQuery = useCallback((q: string): void => patch({ query: q }), [patch])
  const setDuration = useCallback((d: DurationQuery): void => patch({ duration: d }), [patch])
  const cycleSort = useCallback((): void => setState((p) => ({ ...p, sort: nextDurationSort(p.sort) })), [setState])

  // 类型与状态都是集合：一个都不选 = 不按这一维过滤（见 core 的 LogFilter）
  const filter = useMemo<LogFilter>(
    () => ({ kinds, statuses, query, duration: durationBounds(duration), window: selection }),
    [kinds, statuses, query, duration, selection],
  )
  const filtered = useMemo(() => filterLogRows(rows, filter), [rows, filter])
  /**
   * 时间栏的块集：选区之外的筛选都生效，**唯独不含选区**。
   *
   * 为什么不能只留选区里的块：2 小时的会话里选 30 秒，那十几块会全挤在轨道千分之四宽的位置、
   * 其余全是空的，「全景」当场失效 —— 正是这个视图要给人看的东西。
   */
  const themed = useMemo(
    () => (filter.window ? filterLogRows(rows, { ...filter, window: null }) : filtered),
    [rows, filter, filtered],
  )
  /**
   * 时间轴标尺恒取自**全部行**（不随筛选变）：一随筛选变，你每敲一个搜索字符整条时间栏的块都会横移，
   * 拉出来的选区框也跟着失去参照。高度同理 —— 分母锚在全部行上，筛到只剩短记录时才仍有可比性。
   */
  const axis = useMemo(() => timeAxisOf(rows), [rows])
  /** waterfall 的横轴：选了区间就放大到区间，否则与时间栏同一把尺 */
  const wfAxis = useMemo(() => axisForWindow(axis, selection), [axis, selection])
  /** 松手吸附的候选边界（记录的起止时刻）。取自全部行，拖的时候不会因筛选而跳 */
  const boundaries = useMemo(() => logBoundaries(rows), [rows])

  const toggleStatus = useCallback(
    (s: LogRowStatus): void =>
      setState((prev) => ({
        ...prev,
        statuses: prev.statuses.includes(s) ? prev.statuses.filter((x) => x !== s) : [...prev.statuses, s],
      })),
    [setState],
  )

  // 排序只重排数组引用，行对象一个不变 —— 行组件是 memo 的，正文不会因此重算
  const displayed = useMemo(() => sortLogRows(filtered, sort), [filtered, sort])
  const sortOpt = durationSortOption(sort)

  // 排序生效时不建时间栏：横轴是时刻，重排之后它已经对不上列表了（见 DurationSortOption.keepsTimeline）
  const timeline = useMemo(
    () => (sortOpt.keepsTimeline ? buildTimeline(themed, axis, filter.window) : []),
    [themed, axis, filter.window, sortOpt.keepsTimeline],
  )

  /** 时间栏点击 → 滚到那一行并短暂高亮。表是整表渲染的（行都在 DOM 里），所以直接找得到。 */
  const jumpTo = useCallback((id: string): void => {
    const host = tableRef.current
    const el = host?.querySelector<HTMLElement>(`[data-log-id="${CSS.escape(id)}"]`)
    if (!el) return
    el.scrollIntoView({ block: 'center' })
    setFlashId(id)
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => setFlashId(null), FLASH_MS)
  }, [])

  useEffect(
    () => () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current)
    },
    [],
  )

  const toggleRow = useCallback((id: string): void => {
    setOpenId((prev) => (prev === id ? null : id))
  }, [])

  /**
   * 当前筛选条件的人话说明。**报告过期判据与交给 claude 的说明是同一个字符串** ——
   * 各算各的话，「界面说没变、报告却标了过期」这种自相矛盾迟早出现。
   */
  const filterLabel = useMemo(() => describeLogFilter(filter), [filter])

  /** **这批记录**覆盖的绝对时间范围（算法与理由见 core 的 `logSpanLabel`：取批次首尾，不是会话首尾） */
  const spanLabel = useMemo(() => logSpanLabel(displayed), [displayed])

  /** 交给 claude 的就是**此刻屏幕上那批**：筛选后的行 + 当前排序 */
  const runAnalysis = useCallback((): void => {
    analysis.run(
      {
        rows: displayed,
        total: rows.length,
        filterLabel,
        sortLabel: sort === 'normal' ? '' : sortOpt.label,
        spanLabel,
      },
      summary,
    )
  }, [analysis, displayed, rows.length, filterLabel, sort, sortOpt, spanLabel, summary])

  /**
   * 分析面板与筛选栏的生成入口共用这一份可用性判定：**分析在飞的时候两边都要禁用**。
   *
   * 只挡面板那一枚是不够的：两个入口都能起一次 `claude -p`，而它们的 chunk 载荷完全相同
   * （同会话 + 同 `log` 标签），两份输出会互相插队、最后完成的那份覆盖正文。
   */
  const analyzable = displayed.length > 0 && !analysis.report.loading
  /** 超上限时如实说：摘要只喂最慢的那 300 条，用户得知道报告没覆盖全部筛选结果 */
  const truncatedNote =
    displayed.length > MAX_DIGEST_ROWS ? `只分析最慢的 ${MAX_DIGEST_ROWS} 条（共 ${displayed.length} 条）` : undefined

  return (
    <div style={wrapStyle}>
      <SummaryBar summary={summary} total={rows.length} shown={displayed.length} />
      <FilterBar
        kinds={kinds}
        onKinds={setKinds}
        statuses={statuses}
        onStatus={toggleStatus}
        query={query}
        onQuery={setQuery}
        duration={duration}
        onDuration={setDuration}
        onAnalyze={runAnalysis}
        analyzable={analyzable}
        analyzeTitle={analyzeTitle(analysis.report.loading, displayed.length, truncatedNote)}
        selection={selection}
        onSelectionChange={onSelectionChange}
        shown={displayed.length}
      />
      {!sortOpt.keepsTimeline ? (
        <TimelineOff sortOpt={sortOpt} />
      ) : timeline.length > 0 || selection !== null ? (
        // 有选区时即使一条都不匹配也要留着时间栏：手柄在这里，藏起来用户就没法调整它了
        <Timeline
          blocks={timeline}
          axis={axis}
          selection={selection}
          boundaries={boundaries}
          onJump={jumpTo}
          onSelect={onSelectionChange}
        />
      ) : null}
      <div style={tableStyle} ref={tableRef}>
        <LogHeaderRow sort={{ opt: sortOpt, active: sort !== 'normal', onClick: cycleSort }} />
        {displayed.length === 0 ? (
          <div style={emptyStyle}>没有匹配的记录</div>
        ) : (
          displayed.map((row, i) => (
            <LogRowView
              key={`${row.kind}-${row.fullId}`}
              row={row}
              wallMs={summary.wallMs}
              wfAxis={wfAxis}
              stripe={i % 2 === 1}
              expanded={openId === row.fullId}
              flashed={flashId === row.fullId}
              onToggle={toggleRow}
              onCopy={onCopy}
              onLocate={onLocate}
            />
          ))
        )}
      </div>
      <LogAnalysisPanel
        analysis={analysis}
        filterLabel={filterLabel}
        analyzable={analyzable}
        truncatedNote={truncatedNote}
        onRun={runAnalysis}
      />
    </div>
  )
}

/** 筛选栏那枚按钮的悬停说明：把「现在点下去会发生什么」写全，包括上限与正在跑 */
function analyzeTitle(loading: boolean, count: number, truncatedNote: string | undefined): string {
  if (loading) return '正在分析中…'
  if (count === 0) return '当前筛选一条记录都没有'
  return `用本机 claude CLI 分析当前筛选出的 ${count} 条记录（复用已登录、无需 API key）${
    truncatedNote ? `；超过上限，${truncatedNote}` : ''
  }`
}

/**
 * 日志视图底部的 claude 分析面板：折叠头常驻（它是「这批记录能被分析」这个能力的入口），
 * 正文复用树视图那份 `AiReport`（同一套流式渲染 + 导出 .md + 终端追问）。
 *
 * 过期提示（`filterLabel` 与报告生成时的不一致）与树视图的「窗口已变化」同一条思路：
 * 报告是对着**某一批记录**下的结论，筛选一改它就对不上了，不说清会被当成当前筛选的结论。
 */
function LogAnalysisPanel(props: {
  analysis: LogAnalysis
  /** 此刻的筛选说明 */
  filterLabel: string
  analyzable: boolean
  /** 超出行数上限时的如实说明（不超则为 undefined） */
  truncatedNote: string | undefined
  onRun: () => void
}): JSX.Element {
  const { analysis, filterLabel, analyzable, truncatedNote, onRun } = props
  const r = analysis.report
  const stale = r.label !== '' && r.label !== filterLabel
  // 有正文就先说正文的来路：`error` 里既可能是分析失败、也可能只是这次导出 .md 没写成功，
  // 后者不该把摘要写成「生成失败」（正文其实好好地在下面）
  const hint = r.loading ? '生成中…' : r.text ? `基于 ${r.label}` : r.error ? '生成失败' : '对当前筛选出的记录生成报告'

  return (
    <div style={analysis.open ? { ...analysisPanelStyle, ...analysisPanelOpenStyle } : analysisPanelStyle}>
      <button
        type="button"
        onClick={() => analysis.setOpen(!analysis.open)}
        aria-expanded={analysis.open}
        style={analysisHeadStyle}
      >
        <Chevron open={analysis.open} />
        <span style={analysisTitleStyle}>claude 分析</span>
        <span style={analysisHintStyle}>{hint}</span>
        {truncatedNote ? <span style={analysisNoteStyle}>{truncatedNote}</span> : null}
        {stale ? (
          <span style={analysisStaleStyle} title={`报告基于「${r.label}」生成，当前筛选已变为「${filterLabel}」`}>
            ⚠ 筛选已变化，建议重新生成
          </span>
        ) : null}
      </button>
      {analysis.open ? (
        <div style={analysisBodyStyle}>
          <AiReport
            text={r.text}
            loading={r.loading}
            error={r.error}
            sessionId={r.claudeId}
            generateLabel={r.text ? '重新分析当前筛选' : '分析筛选出的记录'}
            generateDisabledReason={
              analyzable ? undefined : r.loading ? '正在分析中…' : '当前筛选一条记录都没有'
            }
            emptyHint="把当前筛选出的记录交给本机 claude CLI 做一份分析（复用已登录、无需 API key，流式输出）。"
            onGenerate={onRun}
            onSave={analysis.save}
            onOpenTerminal={analysis.openTerminal}
          />
        </div>
      ) : null}
    </div>
  )
}

/** 时间栏里一块的最小宽度（px）：88ms 的记录在 2 小时的会话里宽度只有 0.001%，不给下限就点不到。 */
const MIN_BLOCK_PX = 3
/** 从时间栏跳过去之后，那一行高亮多久 */
const FLASH_MS = 1600
/** 时间栏里耗时最短的块的不透明度：既要看得见，又不能和长耗时一样抢眼 */
const BLOCK_MIN_OPACITY = 0.35
/** 选区外的块再乘这一层：全景仍在，但不跟选区里抢注意力 */
const DIM_OPACITY = 0.25
/** 拖动位移不超过这么多像素就当成单击（不产生选区）—— 否则手一抖就拉出一个 1px 的框 */
const DRAG_THRESHOLD_PX = 3
/** 选区手柄宽度（px）。实心色块，比树视图那个滑块宽一点：1 分钟的选择区在 4 小时的轴上只有几个像素，边界得显眼 */
const HANDLE_W = 10
/** 手柄中间那道握把的宽度（px）：让人一眼看出这是「能拖的边」而不是一段普通色条 */
const HANDLE_GRIP_W = 2
/** 手柄上按方向键时，Shift 一次走多少倍（1px 的整数倍，见 msPerPx） */
const KEY_STEP_MULTIPLIER = 10
/** 鼠标悬停时那条竖线（px）：细到不挡块，又要一眼看得见 */
const HOVER_LINE_W = 1
/** 双击选中的时间范围宽度：以双击点为中心的一段（1 分钟，左右各一半） */
const DBLCLICK_WINDOW_MS = MS_PER_MINUTE
/**
 * 拖完选区之后多久以内的「双击」不算双击。
 *
 * 浏览器判 double click 只看两次 click 的间隔与位置，**不管我们有没有吃掉事件** —— 而拖完那一手
 * 的 mouseup 本身就派发了一次 click，于是紧随其后的随便一下单击都会被算成 detail=2 并派发 dblclick。
 * 那个显然不是用户的双击，得按时间挡掉（500ms 与浏览器判定双击的间隔同量级）。
 */
const DBLCLICK_GUARD_MS = 500

/** 拖动中的状态。`moved` 一旦置位就不再回落：阈值只用来区分「单击」与「拖动」 */
type DragState =
  | { mode: 'new'; x0: number; moved: boolean }
  | { mode: 'edge'; which: 'start' | 'end'; x0: number; startTs: number; endTs: number; moved: boolean }

/**
 * 时间栏：会话时间轴上的一条概览，每条记录一块 —— **位置 = 时刻，宽度 = 耗时**，颜色 = 记录类型。
 *
 * 它与下面的表不是一一对齐的关系（表按记录逐条排，一个 88ms 的行和一个 30min 的行各占一行高），
 * 所以它回答的是「时间都花在什么时候、哪几段最密」，点击负责把你送到那一行。
 *
 * 轨道上拉一下 = 选出一段时间（选区是一条筛选条件，见 core 的 LogFilter.window）；选区外挡一层暗色。
 * 横轴取自全部行、不随筛选变，所以选区框在整条会话里的位置永远是稳的。
 */
function Timeline(props: {
  blocks: TimelineBlock[]
  axis: TimeAxis
  selection: ViewWindow | null
  /** 松手吸附的候选边界（见 core `logBoundaries`） */
  boundaries: number[]
  onJump: (id: string) => void
  onSelect: (w: ViewWindow | null) => void
}): JSX.Element {
  const { axis, boundaries, onSelect } = props
  const trackRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  /**
   * 刚刚拖完那一手要吃掉紧跟的 click。
   *
   * 为什么是「置位 + 捕获阶段消费」而不是 setTimeout 复位：click 与 mouseup 的先后在不同设备上
   * 不完全一致，定时器复位是在赌顺序；而在轨道上捕获 click（比块自己的 onClick 更早）是无序假设的写法。
   */
  const swallowRef = useRef(false)
  /** 拖动中的实时选区。只活在这里，松手才提交给父组件（见下） */
  const [preview, setPreview] = useState<ViewWindow | null>(null)
  /** 跟随鼠标的那条红色竖线：**直接改 style、不走 state** —— 轨道上一千多个块，逐帧 setState 会让它们跟着重画 */
  const hoverRef = useRef<HTMLDivElement>(null)
  /** 上一次拖完的时刻（见 DBLCLICK_GUARD_MS） */
  const dragEndedAtRef = useRef(0)

  // 矮的先画：密集区里块必然重叠，耗时长的必须压在上面 —— 否则「哪段耗时高」全被后画的小块盖住
  const ordered = useMemo(() => [...props.blocks].sort((a, b) => a.intensity - b.intensity), [props.blocks])

  const bounds: ViewWindow = { start: axis.lo, end: axis.lo + axis.total }
  // 换会话时父组件给的选区可能还指着上一个会话的时刻，读的时候兜一次（轴的边界用**行**的范围，
  // 不是会话文件的 startedAt/endedAt —— 后者是文件首末事件时刻，可能远早于第一条记录）
  const sel = props.selection === null ? null : clampWindow(props.selection, bounds.start, bounds.end, 1)
  const shown = preview ?? sel

  /** 轨道宽度（px）：鼠标给的是像素，模型要的是毫秒，换算是这里唯一一处 */
  const trackPx = (): number => Math.max(1, trackRef.current?.getBoundingClientRect().width ?? 1)
  /** 1px 值多少毫秒。既是拖动中两端互斥的下限（不能叠在一起），也是方向键的步长 */
  const msPerPx = (): number => axis.total / trackPx()
  /** 视口坐标 → 绝对时刻（clamp 到轴内） */
  const tsAt = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return axis.lo
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return axis.lo + ratio * axis.total
  }

  /** 松手那一瞬间的原始区间（还没吸附） */
  const rawWindowAt = (d: DragState, clientX: number): ViewWindow => {
    const ts = tsAt(clientX)
    if (d.mode === 'new') {
      const anchor = tsAt(d.x0)
      return { start: Math.min(anchor, ts), end: Math.max(anchor, ts) }
    }
    return {
      start: d.which === 'start' ? ts : d.startTs,
      end: d.which === 'end' ? ts : d.endTs,
    }
  }

  /**
   * 吸附到最近的记录边界。
   *
   * 拉新选区时两端都吸附；拖手柄时**只吸附被拖的那一端** —— 另一端是用户之前定的，
   * 不该被这一次拖动顺手改掉。吸附后两端撞在一起就整体作废（保留原选区），比硬凑一个退化区间诚实。
   */
  const snapWindow = (w: ViewWindow, d: DragState): ViewWindow | null => {
    const start = d.mode === 'new' || d.which === 'start' ? snapToSegmentBoundary(w.start, boundaries) : w.start
    const end = d.mode === 'new' || d.which === 'end' ? snapToSegmentBoundary(w.end, boundaries) : w.end
    if (end <= start) return null
    return clampWindow({ start, end }, bounds.start, bounds.end, 1)
  }

  const onMove = (ev: MouseEvent): void => {
    const d = dragRef.current
    if (!d) return
    if (!d.moved) {
      // 阈值内一个字节都不更新：否则单击（想跳到某一行）会先闪出一个 1px 的框
      if (Math.abs(ev.clientX - d.x0) < DRAG_THRESHOLD_PX) return
      d.moved = true
    }
    const ts = tsAt(ev.clientX)
    // 拖动中只画预览，不回调父组件：选区一变，waterfall 的轴就变，而轴进的是每一行的 props ——
    // 一千多行的 memo 会当场全部失效，跟着 mousemove 每帧重渲染一遍
    if (d.mode === 'new') {
      const anchor = tsAt(d.x0)
      setPreview({ start: Math.min(anchor, ts), end: Math.max(anchor, ts) })
      return
    }
    // 只动被拖的那一端：另一端锚定不动（整窗 clamp 会让人以为拖错了对象）
    setPreview(dragWindowEdge({ start: d.startTs, end: d.endTs }, d.which, ts, bounds, msPerPx()))
  }

  const onUp = (ev: MouseEvent): void => {
    const d = dragRef.current
    dragRef.current = null
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    setPreview(null)
    if (!d) return
    // 没动过 = 单击：一个字的选区状态都不改，块自己的 onClick 照常跳转
    if (!d.moved) return
    swallowRef.current = true
    dragEndedAtRef.current = Date.now()
    const snapped = snapWindow(rawWindowAt(d, ev.clientX), d)
    if (snapped) onSelect(snapped)
  }

  /**
   * 双击 = 快速圈一段时间。
   *
   * 选区内双击 → 取消（那一段已经看完了，再双击就是「收起」）；选区外双击 → 以该点为中心重选 1 分钟。
   * 不走吸附：这里要的就是「前后各半分钟」这个确定宽度，吸到记录边界反而让宽度不再确定。
   */
  const onDoubleClick = (e: React.MouseEvent): void => {
    if (Date.now() - dragEndedAtRef.current < DBLCLICK_GUARD_MS) return
    e.preventDefault()
    const ts = tsAt(e.clientX)
    if (sel && ts >= sel.start && ts <= sel.end) {
      onSelect(null)
      return
    }
    const next = windowAround(ts, DBLCLICK_WINDOW_MS, bounds)
    if (next) onSelect(next)
  }

  /** 鼠标在轨道上时更新那条竖线（位置 = 鼠标处的时刻） */
  const moveHover = (e: React.MouseEvent): void => {
    const line = hoverRef.current
    const rect = trackRef.current?.getBoundingClientRect()
    if (!line || !rect || rect.width <= 0) return
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    line.style.left = pctOf(ratio)
    line.style.opacity = '1'
  }

  const hideHover = (): void => {
    if (hoverRef.current) hoverRef.current.style.opacity = '0'
  }

  const startDrag = (next: DragState, e: React.MouseEvent): void => {
    if (e.button !== 0) return
    e.preventDefault()
    // 复位不是防御性代码：鼠标在时间栏**之外**松开时浏览器根本不派发 click，我们收不到它，
    // 标志会一直留着，下一次真实点击就被白白吞掉
    swallowRef.current = false
    dragRef.current = next
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const onTrackDown = (e: React.MouseEvent): void => {
    // 在块上按下也会冒泡到这里 —— 正是想要的：从任何一个位置起手都能拉选区
    startDrag({ mode: 'new', x0: e.clientX, moved: false }, e)
  }

  const onHandleDown = (which: 'start' | 'end') => (e: React.MouseEvent<HTMLDivElement>): void => {
    // 必须挡掉轨道那一层：否则同一次按下会起两个拖拽，两个监听互抢
    e.stopPropagation()
    // startDrag 会 preventDefault（否则拖动中会把轨道上的文字选中），而那同时也会挡掉浏览器的聚焦 ——
    // 于是「点一下手柄再用方向键微调」这条最自然的路径会失效，所以这里显式补一次
    e.currentTarget.focus()
    const w = sel ?? bounds
    startDrag({ mode: 'edge', which, x0: e.clientX, startTs: w.start, endTs: w.end, moved: false }, e)
  }

  /** 手柄上的方向键：±1px 对应的时长、Shift ×10、Esc 清选区（Esc 挂手柄上，不挂 document —— 类型下拉也吃 Esc） */
  const onHandleKey = (which: 'start' | 'end') => (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      onSelect(null)
      return
    }
    const dir = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0
    if (dir === 0 || !sel) return
    e.preventDefault()
    const edge = which === 'start' ? sel.start : sel.end
    const ts = edge + dir * msPerPx() * (e.shiftKey ? KEY_STEP_MULTIPLIER : 1)
    onSelect(dragWindowEdge(sel, which, ts, bounds, msPerPx()))
  }

  return (
    <div
      ref={trackRef}
      onMouseDown={onTrackDown}
      onMouseMove={moveHover}
      onMouseLeave={hideHover}
      onDoubleClick={onDoubleClick}
      onClickCapture={(e) => {
        if (!swallowRef.current) return
        swallowRef.current = false
        e.stopPropagation()
        e.preventDefault()
      }}
      style={timelineStyle}
      role="group"
      aria-label="会话时间概览（在轨道上拉选或双击一段时间可只看那一段，点击一块跳转到对应记录）"
    >
      {/* 选区底色：画在块之前，于是落在块的下面 */}
      {shown ? <div style={{ ...timelineSelStyle, left: pctOf(axisPos(axis, shown.start)), width: pctOf(Math.max(0, axisPos(axis, shown.end) - axisPos(axis, shown.start))) }} /> : null}
      {ordered.map((b) => (
        <div
          key={b.id}
          title={b.dimmed ? `${b.label}（在选区之外，清除选区后可跳转）` : b.label}
          onClick={b.dimmed ? undefined : () => props.onJump(b.id)}
          style={{
            ...timelineBlockStyle,
            left: pctOf(b.start),
            width: pctOf(b.width),
            height: `${b.intensity * 100}%`,
            background: b.color,
            // 耗时越长越实：短任务留得住存在感，但不跟长耗时抢注意力。
            // 变暗是**乘**上去的，不能覆盖 —— 覆盖会把「高度与透明度编码耗时」这件事毁掉
            opacity: (BLOCK_MIN_OPACITY + (1 - BLOCK_MIN_OPACITY) * b.intensity) * (b.dimmed ? DIM_OPACITY : 1),
            cursor: b.dimmed ? 'default' : 'pointer',
          }}
        />
      ))}
      {/* 鼠标位置的红色竖线：画在块之后（压在块上才看得见）、手柄之前（手柄仍是最上面那层）。
          没有选区时也要有 —— 它是「这里能取时刻」的提示，双击选段也要有个落点的参照 */}
      <div ref={hoverRef} style={hoverLineStyle} />
      {shown ? (
        <>
          <Handle
            at={axisPos(axis, shown.start)}
            label="选区开始"
            valuetext={fmtClock(shown.start)}
            active={preview !== null}
            onDown={onHandleDown('start')}
            onKey={onHandleKey('start')}
          />
          <Handle
            at={axisPos(axis, shown.end)}
            label="选区结束"
            valuetext={fmtClock(shown.end)}
            active={preview !== null}
            onDown={onHandleDown('end')}
            onKey={onHandleKey('end')}
          />
        </>
      ) : null}
      {/* 松手前只在轨道上给一行读数（提交之后读数是筛选栏那个 chip，不在两处重复显示） */}
      {preview ? (
        <span style={timelineReadoutStyle}>
          {fmtClock(preview.start)} → {fmtClock(preview.end)} · {fmtDuration(preview.end - preview.start)}
        </span>
      ) : null}
    </div>
  )
}

/** 归一化位置 → CSS 百分比 */
function pctOf(ratio: number): string {
  return `${ratio * 100}%`
}

/** 选区两端的手柄：拖动改这一端，方向键微调，Esc 清掉整个选区 */
function Handle(props: {
  /** 归一化位置 0~1 */
  at: number
  label: string
  valuetext: string
  active: boolean
  onDown: (e: React.MouseEvent<HTMLDivElement>) => void
  onKey: (e: React.KeyboardEvent) => void
}): JSX.Element {
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={props.label}
      aria-valuetext={props.valuetext}
      title={`${props.label}：拖动调整，方向键微调（Shift ×${KEY_STEP_MULTIPLIER}），Esc 清除选区`}
      onMouseDown={props.onDown}
      onKeyDown={props.onKey}
      style={{
        ...handleStyle,
        left: `calc(${pctOf(props.at)} - ${HANDLE_W / 2}px)`,
      }}
    >
      <span style={gripStyle(props.active)} />
    </div>
  )
}

/**
 * 时间栏不在时，它原来的位置上放的一行说明。
 *
 * 为什么不留空：整条时间栏凭空消失看着像坏了。这行说清「为什么没有」，
 * 并指出怎么让它回来（点表头的耗时）。
 */
function TimelineOff(props: { sortOpt: DurationSortOption }): JSX.Element {
  return (
    <div style={timelineOffStyle}>
      已按耗时{props.sortOpt.label}排列 · 时间栏按时刻定位，排序后不再对应列表，点「耗时」表头可切回
    </div>
  )
}

/** 耗时列表头：点一下切下一档（正常 → 倒序 → 正序）。排序生效时整格换成强调色。 */
function SortHeader(props: {
  label: string
  sortOpt: DurationSortOption
  active: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button type="button" onClick={props.onClick} title={SORT_HINT} style={sortHeaderStyle(props.active)}>
      {props.label}
      <span style={{ fontSize: 'var(--fs-sm)' }}>{props.sortOpt.indicator}</span>
    </button>
  )
}

/** 表头的悬停说明。档位名与顺序都从 DURATION_SORTS 来，别在这里再抄一遍 */
const SORT_HINT = `点击切换排序：${DURATION_SORTS.map((o) => o.label).join(' → ')} → 循环`

const timelineStyle: React.CSSProperties = {
  position: 'relative',
  height: 30,
  margin: '0 12px 6px',
  flexShrink: 0,
  background: 'var(--bg-subtle)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-sm)',
  overflow: 'hidden',
  // 拉选区时不要在轨道上选中文本（与树视图那个滑块同一处理）
  userSelect: 'none',
  // 十字光标 + 那条红色竖线：这是一根「取时刻」的尺，不是一个普通的可点区域
  cursor: 'crosshair',
}

/**
 * 选区底色。画在块之前，于是压不到块上 —— 它只是「这一段被选中了」的地色。
 *
 * **不能用 `--accent*`**：调色板里只有五个数据色相（灰/蓝/橙/绿/粉），而「工具 / 用户+LLM」
 * 那批块正是蓝的 —— 暗色主题下 `--accent` 与 `--cat-direct` 甚至是同一个色号（`#4c9ffb`），
 * 选区画上去就与块糊成一片。时间栏上的选区一律用**无色相**的中性色，红（`--danger`）留给鼠标那条竖线。
 */
const timelineSelStyle: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  bottom: 0,
  background: 'var(--bg-active)',
  pointerEvents: 'none',
}

/** 拖动中的读数：贴在轨道左上角，让它盖不住的东西都别动（pointer-events: none） */
const timelineReadoutStyle: React.CSSProperties = {
  position: 'absolute',
  top: 1,
  left: 4,
  padding: '1px 5px',
  borderRadius: 'var(--r-sm)',
  background: 'var(--bg-subtle)',
  color: 'var(--text-secondary)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-xs)',
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
}

/**
 * 跟随鼠标的竖线：位置由 `moveHover` 直接改 style（不走 state）。
 *
 * 颜色取 `--danger`：调色板里的红只有它（`--danger-soft` 是它的淡底）。初始 opacity 0，鼠标离开轨道就收起来。
 */
const hoverLineStyle: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  bottom: 0,
  width: HOVER_LINE_W,
  // 位置在边缘时也能看见（否则最右一像素处整条线会被裁掉）
  transform: 'translateX(-50%)',
  background: 'var(--danger)',
  opacity: 0,
  pointerEvents: 'none',
}

/**
 * 选区手柄：满高、实心、画在块之后以便压在块上（否则密集区里根本看不见它）。
 *
 * 取 `--text`（亮色近黑 / 暗色近白）而不是 `--accent`：与选区底色同一条理由 ——
 * accent 在暗色主题下就是「工具 / 用户+LLM」那批块的蓝，界线画上去等于没有界线。
 * 也用不着担心它跟数据撞色：黑/白不在那五个色相里，且它是整条轨道上唯一的无彩色块。
 */
const handleStyle: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  bottom: 0,
  width: HANDLE_W,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--text)',
  borderRadius: 2,
  cursor: 'col-resize',
}

/** 手柄中间那道握把：让人一眼认出这是「能拖的边」（取手柄色的反面） */
function gripStyle(active: boolean): React.CSSProperties {
  return {
    width: HANDLE_GRIP_W,
    height: 12,
    borderRadius: 1,
    background: 'var(--bg)',
    opacity: active ? 1 : 0.75,
  }
}

/** 与时间栏同一格、同一条边距：换行说明不该让下面的表跳一下 */
const timelineOffStyle: React.CSSProperties = {
  ...timelineStyle,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderStyle: 'dashed',
  color: 'var(--text-faint)',
  fontSize: 'var(--fs-xs)',
}

function sortHeaderStyle(active: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 2,
    padding: 0,
    border: 'none',
    background: 'transparent',
    // 字体从表头继承（fs-xs / 700），只有「是否在排序」这一处自己决定颜色
    font: 'inherit',
    cursor: 'pointer',
    color: active ? 'var(--accent)' : 'inherit',
  }
}

const timelineBlockStyle: React.CSSProperties = {
  position: 'absolute',
  // 从底边向上长：高度的差异才好横向比较
  bottom: 0,
  minWidth: MIN_BLOCK_PX,
  minHeight: MIN_BLOCK_PX,
  borderRadius: 1,
  cursor: 'pointer',
}

/** 汇总条：五项与分解模型同源（总耗时 = 等用户 + 直接工具 + 委派子agent + 模型思考） */
function SummaryBar(props: { summary: LogSummary; total: number; shown: number }): JSX.Element {
  return (
    <div style={summaryBarStyle}>
      {SUMMARY_ITEMS.map((s) => (
        <div key={s.key} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={summaryLabelStyle}>{s.label}</span>
          <span style={{ ...summaryValueStyle, color: s.color }}>{fmtMs(props.summary[s.key])}</span>
        </div>
      ))}
      <div style={{ flex: 1, height: 1 }} />
      <span style={recordCountStyle}>
        共 {props.total} 条记录 · 显示 {props.shown} 条
      </span>
    </div>
  )
}

function FilterBar(props: {
  kinds: LogRowKind[]
  onKinds: (k: LogRowKind[]) => void
  statuses: LogRowStatus[]
  onStatus: (s: LogRowStatus) => void
  query: string
  onQuery: (q: string) => void
  duration: DurationQuery
  onDuration: (q: DurationQuery) => void
  /** 用 claude 分析当前筛选出的记录 */
  onAnalyze: () => void
  /** 能分析且没有分析在飞；不能时按钮禁用 */
  analyzable: boolean
  analyzeTitle: string
  /** 时间选区（时间栏拉出来的）：它是一条筛选条件，所以在这个栏里，与类型/状态并列 */
  selection: ViewWindow | null
  onSelectionChange: (w: ViewWindow | null) => void
  /** 当前显示的条数：写进选区 chip，让「双闭区间会带上贴边的那条」这件事自明 */
  shown: number
}): JSX.Element {
  return (
    <div style={filterBarStyle}>
      {props.selection ? (
        <SelectionChip selection={props.selection} count={props.shown} onClear={() => props.onSelectionChange(null)} />
      ) : null}
      <span style={filterLabelStyle}>类型</span>
      <KindSelect kinds={props.kinds} onChange={props.onKinds} />
      <span style={dividerStyle} />
      <span style={filterLabelStyle}>状态</span>
      {STATUS_OPTIONS.map((s) => (
        <Chip key={s.value} active={props.statuses.includes(s.value)} onClick={() => props.onStatus(s.value)}>
          {s.label}
        </Chip>
      ))}
      <span style={dividerStyle} />
      <DurationFilter value={props.duration} onChange={props.onDuration} />
      <span style={dividerStyle} />
      <div style={searchBoxStyle}>
        <span style={{ display: 'inline-flex', color: 'var(--text-faint)' }}>
          <SearchIcon />
        </span>
        <input
          value={props.query}
          onChange={(e) => props.onQuery(e.target.value)}
          placeholder="搜索命令 / 路径 / 摘要…"
          aria-label="搜索记录"
          style={searchInputStyle}
        />
      </div>
      <div style={{ flex: 1, height: 1 }} />
      <button
        type="button"
        onClick={props.onAnalyze}
        disabled={!props.analyzable}
        title={props.analyzeTitle}
        style={{ ...analyzeBtnStyle, ...(props.analyzable ? null : { opacity: 0.5, cursor: 'not-allowed' }) }}
      >
        <AnalyzeIcon />
        用 claude 分析
      </button>
    </div>
  )
}

/** 一个都不选时的按钮文字。它与 core 的语义同义：空集 = 不按类型过滤 */
const KIND_ALL_LABEL = '全部'
/** 按钮上最多并排列几个类型名，再多就只报个数（列太长会把搜索框挤走） */
const KIND_LABELS_MAX = 2
/** 菜单底部那个动作按钮的两个字面：五个都没勾 →「全选」，都勾了 →「清空」 */
const KIND_SELECT_ALL = '全选'
const KIND_CLEAR = '清空'

/**
 * 类型多选下拉。
 *
 * 为什么自己写而不是 `<select multiple>`：原生多选要按住 Cmd 点、选完不收起、也没法给每一项上
 * 类别色 —— 这几样恰好是这里最需要的。代价是要自己管「点外面收起」（下面那个 effect）。
 *
 * 语义与状态 chip 一致：**一个都不选 = 不按类型过滤**，所以没有「全部」这个可选项，
 * 按钮上空选时显示「全部」只是把「不筛」这件事说出来。
 */
function KindSelect(props: { kinds: LogRowKind[]; onChange: (next: LogRowKind[]) => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  // 展开时才登记「点外面/按 Esc 收起」：收起状态下一份监听都不该挂着
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent): void => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const { kinds, onChange } = props
  const labels = kinds.map((k) => LOG_KIND_STYLE[k].label)
  const all = labels.join('、')
  const allOn = kinds.length === LOG_KINDS.length
  const toggleAll = (): void => onChange(allOn ? [] : [...LOG_KINDS])

  return (
    <div ref={boxRef} style={kindSelectWrapStyle}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="记录类型（可多选）"
        title={kinds.length === 0 ? '不按类型过滤' : all}
        style={kindBtnStyle(open, kinds.length > 0)}
      >
        {kinds.length === 0
          ? KIND_ALL_LABEL
          : kinds.length <= KIND_LABELS_MAX
            ? all
            : `已选 ${kinds.length} 类`}
        <Chevron open={open} />
      </button>
      {open ? (
        <div style={kindMenuStyle}>
          <div role="listbox" aria-multiselectable style={kindListStyle}>
            {LOG_KINDS.map((k) => {
              const on = kinds.includes(k)
              return (
                <button
                  key={k}
                  type="button"
                  role="option"
                  aria-selected={on}
                  onClick={() => onChange(on ? kinds.filter((x) => x !== k) : [...kinds, k])}
                  style={kindItemStyle(on)}
                >
                  <span style={kindCheckStyle(on)}>{on ? '✓' : ''}</span>
                  <span style={{ color: LOG_KIND_STYLE[k].color, fontWeight: 600 }}>
                    {LOG_KIND_STYLE[k].label}
                  </span>
                </button>
              )
            })}
          </div>
          {/*
            全选 ⇄ 清空 合成一个按钮：五个逐个点是最费手的操作，两头都得有出口。
            它不放进 listbox 里 —— 它不是「一个类型」，带上勾选框会被当成第六类。
          */}
          <button type="button" onClick={toggleAll} style={kindActionStyle}>
            {allOn ? KIND_CLEAR : KIND_SELECT_ALL}
          </button>
        </div>
      ) : null}
    </div>
  )
}

/** 表头 + 行共用一套列定义：列宽/对齐只写一遍，改列不用在两处同步 */
interface LogColumn {
  key:
    | 'expand'
    | 'id'
    | 'time'
    | 'kind'
    | 'action'
    | 'summary'
    | 'status'
    | 'tokens'
    | 'duration'
    | 'share'
    | 'waterfall'
  label: string
  /** 固定宽度（px）；摘要列吃掉剩余宽度 */
  width?: number
  align: 'left' | 'center' | 'right'
  /** 表头悬停说明（列的含义不是一眼能猜到的才给） */
  title?: string
  /** 表头可点击切换排序（目前只有耗时列 —— 其余列各有各的次序，等真需要再加） */
  sortable?: boolean
}

const LOG_COLUMNS: LogColumn[] = [
  { key: 'expand', label: '', width: 16, align: 'center' },
  { key: 'id', label: '记录 ID', width: 104, align: 'center' },
  { key: 'time', label: '时间', width: 92, align: 'center' },
  { key: 'kind', label: '类型', width: 66, align: 'center' },
  { key: 'action', label: '操作', width: 128, align: 'center' },
  { key: 'summary', label: '摘要', align: 'left' },
  { key: 'status', label: '状态', width: 56, align: 'center' },
  {
    key: 'tokens',
    label: '输入/输出 tok',
    width: 104,
    align: 'right',
    title: '单位 tok，输入 / 输出。输入 = 非缓存输入 + 缓存写入 + 缓存读取。没有模型那半的行（等用户、没有响应发起过的工具）留空',
  },
  {
    key: 'duration',
    label: '耗时',
    width: 72,
    align: 'right',
    sortable: true,
    title: '按量级着色：毫秒级灰 · 秒级蓝 · 分钟级橙',
  },
  { key: 'share', label: '占比', width: 132, align: 'right' },
  {
    key: 'waterfall',
    label: 'waterfall',
    width: 132,
    align: 'left',
    title: '该记录在会话时间轴上的位置：左端 = 开始时刻，宽度 = 耗时（选了时间选区时按选区放大）',
  },
]

/**
 * 汇总条各项：口径来自 LogSummary，配色即类别色（明暗主题各自跟随）。
 *
 * 等式看总耗时那一列：`总耗时 = 等用户 + 本地工具 + 模型思考`。直接工具/委派子agent/workflow 是
 * 「本地工具」的三个分项，它们**可以重叠**（workflow 在后台跑时主 agent 照常干活），所以逐项相加
 * 可能大于总耗时 —— 那是真实的并行，不是算错。
 */
/**
 * 汇总条各项：口径来自 `LogSummary`（= `breakdownOf`），配色即类别色（明暗主题各自跟随）。
 * 这里摊的是**分项**（直接工具 / 委派 / workflow 各一列），所以不摆 `localToolMs` ——
 * 摆上去会与三列并排成一个「合起来对不上」的假象（它是并集，不是三列之和）。
 */
const SUMMARY_ITEMS: { key: keyof LogSummary; label: string; color: string }[] = [
  { key: 'wallMs', label: '总耗时', color: 'var(--text)' },
  { key: 'waitUserMs', label: '等用户', color: CATEGORY_COLORS.waitUser },
  { key: 'directMs', label: '直接工具', color: CATEGORY_COLORS.direct },
  { key: 'delegatedMs', label: '委派子agent', color: CATEGORY_COLORS.delegated },
  { key: 'workflowMs', label: 'workflow', color: CATEGORY_COLORS.workflow },
  { key: 'computeMs', label: '模型思考', color: CATEGORY_COLORS.compute },
]

const DURATION_OPS: { value: DurationOp; label: string }[] = [
  { value: 'gt', label: '高于' },
  { value: 'lt', label: '低于' },
  { value: 'between', label: '区间' },
]

/**
 * 单位与耗时列印出来的单位同一根轴（ms / s / m），切单位不改数值，只改解释。
 *
 * `s` 排第一 = 默认值（`EMPTY_DURATION_QUERY.unit`）：下拉里首项就是「选中项长什么样」，
 * 而且万一某条路径的值没匹配上任何选项，浏览器回退到首项也还是 s。
 */
const DURATION_UNITS: DurationScale[] = ['s', 'ms', 'm']

/**
 * 状态筛选 chip。只有成功/失败两项：`na`（没跑完）不是用户会去筛的东西 —— 它是「这条记录
 * 没有结果可比」的意思，而不是一种结论。文案取自 core 的标签表（与交给 claude 的记录表同源）。
 */
const STATUS_OPTIONS: { value: LogRowStatus; label: string }[] = (['ok', 'error'] as const).map((value) => ({
  value,
  label: LOG_STATUS_LABEL[value],
}))

/**
 * 表头行：主表与子 agent 的子表共用（列只有 `LOG_COLUMNS` 一份定义，两处不可能对不上）。
 *
 * `sort` 传 null 时耗时列不可点：子表是子会话自己的时序，不参与主表的排序。
 */
function LogHeaderRow(props: {
  sort: { opt: DurationSortOption; active: boolean; onClick: () => void } | null
}): JSX.Element {
  return (
    <div style={headRowStyle}>
      {LOG_COLUMNS.map((c) => (
        <div key={c.key} style={cellStyle(c, true)} title={c.title}>
          {c.sortable && props.sort ? (
            <SortHeader label={c.label} sortOpt={props.sort.opt} active={props.sort.active} onClick={props.sort.onClick} />
          ) : (
            c.label
          )}
        </div>
      ))}
    </div>
  )
}

/**
 * 子 agent 的记录：把展开的那一步钻进去。
 *
 * 与主表同一套行组件、同一套口径 —— 耗时/占比/waterfall 全按**它自己那个会话**算
 * （占比的分母是子会话的 `breakdownOf().wallMs`），所以钻进来的数与主表那一行不冲突：
 * 上面那行说「这一步等了 1m39s」，这里说「那 1m39s 花在哪」。
 *
 * 不参与主表的筛选与时间选区：这是「看这一步干了什么」的钻取，不是主表的第二个视图 ——
 * 筛一下就把要找的记录筛没了，得不偿失。
 *
 * 委派一行一个；workflow 一行 N 个（每个子 agent 一个），`label` 是各自的名字。
 *
 * **默认只占一行摘要，点开才铺表**：一次 workflow 展开背后是 3–7 个子 agent，每个都当场铺出
 * 一张带表头、最高 420px 的表，加起来一展开就是好几屏，而多数时候只想看其中一个。
 * 折叠省下的是**渲染**（上千行的 DOM 与表头），条数仍要 `buildLogRows` 才有 —— 这一层的构建
 * 本来就要等父行展开，没有多付。
 */
function ChildLogList(props: {
  session: Session
  /** 摘要行最前面的名字（workflow 的子 agent）；不给就写「子 agent 记录」 */
  label?: string
  onCopy: (text: string, tip: string) => void
  onLocate: (toolUseId: string) => void
}): JSX.Element {
  const { session, onCopy, onLocate } = props
  const [open, setOpen] = useState(false)
  const rows = useMemo(() => buildLogRows(session), [session])
  const wallMs = useMemo(() => logSummary(session).wallMs, [session])
  return (
    <div style={childListStyle}>
      <div
        style={childSummaryStyle}
        onClick={() => setOpen((o) => !o)}
        title={open ? '收起记录' : '展开记录'}
      >
        <Chevron open={open} />
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {props.label ?? '子 agent 记录'}
        </span>
        <span>{rows.length} 条</span>
        <span style={{ color: 'var(--text-faint)' }}>· 总耗时 {fmtMs(wallMs)}</span>
      </div>
      {open ? (
        rows.length === 0 ? (
          <div style={childEmptyStyle}>这个子 agent 没有可显示的记录</div>
        ) : (
          <ChildLogTable rows={rows} wallMs={wallMs} onCopy={onCopy} onLocate={onLocate} />
        )
      ) : null}
    </div>
  )
}

/** 子 agent 那张表本身：只有摘要行被点开时才挂载（`timeAxisOf` 随它一起延后） */
function ChildLogTable(props: {
  rows: LogRow[]
  wallMs: number
  onCopy: (text: string, tip: string) => void
  onLocate: (toolUseId: string) => void
}): JSX.Element {
  const { rows, wallMs, onCopy, onLocate } = props
  const axis = useMemo(() => timeAxisOf(rows), [rows])
  return (
    <div style={childTableStyle}>
      <LogHeaderRow sort={null} />
      {rows.map((r, i) => (
        <ChildRow
          key={`${r.kind}-${r.fullId}`}
          row={r}
          wallMs={wallMs}
          wfAxis={axis}
          stripe={i % 2 === 1}
          onCopy={onCopy}
          onLocate={onLocate}
        />
      ))}
    </div>
  )
}

/**
 * 子表里的一行：开合自己管。
 *
 * 主表是「同时只开一条」（`openId` 在 LogView），而钻进来之后要能逐条对照着看 ——
 * 何况把主表的 openId 传下来，每次开合都会让主表一千多行一起重渲染（memo 全失效）。
 */
const ChildRow = memo(function ChildRow(props: {
  row: LogRow
  wallMs: number
  wfAxis: TimeAxis
  stripe: boolean
  onCopy: (text: string, tip: string) => void
  onLocate: (toolUseId: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <LogRowView
      {...props}
      nested
      expanded={open}
      flashed={false}
      onToggle={() => setOpen((o) => !o)}
    />
  )
})

const LogRowView = memo(function LogRowView(props: {
  row: LogRow
  wallMs: number
  /** waterfall 列的横轴。**必须是稳定引用**（父组件 useMemo）—— 它一变，全部行的 memo 一起失效 */
  wfAxis: TimeAxis
  stripe: boolean
  expanded: boolean
  /** 从时间栏跳过来的那一行：短暂高亮 */
  flashed: boolean
  onToggle: (id: string) => void
  onCopy: (text: string, tip: string) => void
  onLocate: (toolUseId: string) => void
  /** 这一行长在子 agent 的子表里：不挂 `data-log-id`（那是主表跳转的锚点，会被子表的同 ID 行抢走） */
  nested?: boolean
}): JSX.Element {
  const { row, expanded } = props
  // 只有工具/委派记录在树上有对应节点（模型响应与轮间间隙不是节点，定位无从谈起）
  const locatable = row.kind === 'tool' || row.kind === 'subagent'
  const style = LOG_KIND_STYLE[row.kind]

  return (
    <>
      <div
        className={[
          'lv-row',
          expanded ? 'lv-row-open' : '',
          // 隔行底色：只作类名不带行内 background —— 行内样式会盖掉 :hover 的反馈
          props.stripe && !expanded ? 'lv-row-stripe' : '',
          // 一次响应发起的工具行圈在它下面（`→ Bash、Read` 那一行的下方），读起来是一组
          row.invokedTools.length > 0 ? 'lv-row-lead' : '',
          row.leadId !== null ? 'lv-row-member' : '',
          props.flashed ? 'lv-row-flash' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        data-log-id={props.nested ? undefined : row.fullId}
        style={rowStyle}
        onClick={() => props.onToggle(row.fullId)}
      >
        {LOG_COLUMNS.map((c) => (
          <div key={c.key} style={cellStyle(c, false)}>
            {cellContent(c.key, { ...props, locatable, style })}
          </div>
        ))}
      </div>
      {/*
        展开出来的东西全在这一个容器里：底色、左侧那条竖线、与下一行之间的分界线都由 `.lv-detail`
        统一表达（见 styles.css）—— 一行展开后是「这一行的内容」，不是另起一块区域。
        面板与子 agent 记录都只是它的内容，自己不再画外框。
      */}
      {expanded ? (
        <div className="lv-detail">
          <DetailPanels row={row} locatable={locatable} onCopy={props.onCopy} onLocate={props.onLocate} />
          {/* 委派行展开后，把子 agent 自己的记录列在下面（递归：它里面再有委派也照样展开） */}
          {row.childSession ? (
            <ChildLogList session={row.childSession} onCopy={props.onCopy} onLocate={props.onLocate} />
          ) : null}
          {/*
            workflow 行：一次调用背后是一整套子 agent（本机实测 3–7 个），逐个列出来 ——
            每个子 agent 的名字取它收到的第一行 prompt（workflow 派活时写的就是「你是…专家」）。
          */}
          {(row.childSessions ?? []).map((child, i) => (
            <ChildLogList
              key={i}
              session={child}
              label={subagentLabel(child, i)}
              onCopy={props.onCopy}
              onLocate={props.onLocate}
            />
          ))}
        </div>
      ) : null}
    </>
  )
})

function cellContent(
  key: LogColumn['key'],
  ctx: {
    row: LogRow
    wallMs: number
    wfAxis: TimeAxis
    expanded: boolean
    locatable: boolean
    onCopy: (text: string, tip: string) => void
    onLocate: (toolUseId: string) => void
    style: { label: string; color: string; soft: string }
  },
): JSX.Element | string | null {
  const { row, style } = ctx
  switch (key) {
    case 'expand':
      return <Chevron open={ctx.expanded} />
    case 'id':
      return (
        <span
          style={{ ...monoStyle, color: 'var(--accent)', overflow: 'hidden', textOverflow: 'ellipsis' }}
          title={row.fullId}
        >
          {row.id}
        </span>
      )
    case 'time':
      return <span style={{ ...monoStyle, color: 'var(--text-secondary)' }}>{fmtClock(row.ts)}</span>
    case 'kind':
      return (
        <span style={{ ...badgeStyle, color: style.color, background: style.soft }}>{kindLabelOf(row)}</span>
      )
    case 'action':
      return (
        <span style={{ ...monoStyle, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis' }} title={row.action}>
          {row.action}
        </span>
      )
    case 'summary':
      return (
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }} title={row.summary}>
          {row.summary}
        </span>
      )
    case 'status':
      return <StatusCell status={row.status} />
    case 'tokens':
      // 没有模型那半的行留空（不是 `—`）：这一列的性质是「有数才有字」，与状态列的「必有一态」不同。
      // 写法与口径都在 core（fmtRowTokens），表格与面板写的是同一份数字。
      // 悬停给精确值：格子里是 `4.2k` 这种紧凑写法，要看准数时不该只有一个近似值
      return row.tokens ? (
        <span
          style={{ ...monoStyle, color: 'var(--text-secondary)' }}
          title={`输入 ${row.tokens.input} tok · 输出 ${row.tokens.output} tok`}
        >
          {fmtRowTokens(row.tokens)}
        </span>
      ) : null
    case 'duration':
      // 量级着色：毫秒级灰 / 秒级蓝 / 分钟级橙。档位来自 durationScale，与印出来的单位同源
      return (
        <span style={{ ...monoStyle, color: DURATION_SCALE_COLOR[durationScale(row.durationMs)], fontWeight: 600 }}>
          {row.durationMs > 0 ? fmtDuration(row.durationMs) : '—'}
        </span>
      )
    case 'share':
      return <ShareCell ms={row.durationMs} wallMs={ctx.wallMs} color={style.color} />
    case 'waterfall':
      return <WaterfallCell row={row} axis={ctx.wfAxis} />
  }
}

function StatusCell(props: { status: LogRowStatus }): JSX.Element {
  if (props.status === 'error') {
    return <span style={{ ...monoStyle, fontWeight: 600, color: 'var(--danger)', background: 'var(--danger-soft)', borderRadius: 'var(--r-sm)', padding: '2px 6px' }}>error</span>
  }
  if (props.status === 'ok') {
    return <span style={{ ...monoStyle, fontWeight: 600, color: CATEGORY_COLORS.compute }}>ok</span>
  }
  return <span style={{ ...monoStyle, color: 'var(--text-faint)' }}>—</span>
}

/** 占比 = 本条耗时 / 会话总耗时；条宽按比例，最短 2px（亚秒记录也要看得见存在） */
function ShareCell(props: { ms: number; wallMs: number; color: string }): JSX.Element {
  const ratio = props.wallMs > 0 ? Math.min(1, props.ms / props.wallMs) : 0
  const width = props.ms > 0 ? Math.max(MIN_MARK_PX, Math.round(SHARE_BAR_W * ratio)) : 0
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end', width: '100%' }}>
      <span style={{ width: SHARE_BAR_W, height: 6, background: 'var(--border-strong)', borderRadius: 3, overflow: 'hidden', flexShrink: 0 }}>
        <span style={{ display: 'block', width, height: '100%', background: props.color, borderRadius: 3 }} />
      </span>
      <span style={{ ...monoStyle, color: 'var(--text-tertiary)', minWidth: 38, textAlign: 'right' }}>
        {fmtPct1(props.ms, props.wallMs)}
      </span>
    </span>
  )
}

/**
 * waterfall 列：这一条在时间轴上的**位置与长度** —— 左端 = 开始时刻，宽度 = 耗时，颜色 = 记录类型。
 *
 * 与占比列的分工：占比回答「花了多久（占会话总时长的比例）」，这一列回答「什么时候花的」。
 * 两者都读同一个 `row.durationMs`，但一个按总耗时归一、一个按时间轴定位，不是同一件事的两种画法。
 * 区间只有一份定义（`rowSpan`），这里不重算。
 */
function WaterfallCell(props: { row: LogRow; axis: TimeAxis }): JSX.Element {
  const { row, axis } = props
  const span = rowSpan(row)
  const left = axisPos(axis, span.start)
  const width = axisPos(axis, span.end) - left
  const color = LOG_KIND_STYLE[row.kind].color
  // 类型走 kindLabelOf：与时间栏的悬停、类型列的徽章同一个来源（一行不能有两套类型文案）
  const title = `${fmtClock(span.start)} → ${fmtClock(span.end)} · ${kindLabelOf(row)} · ${fmtDuration(row.durationMs)}`
  return (
    <span style={wfTrackStyle} title={title}>
      {width > 0 ? (
        <span style={{ ...wfBarStyle, left: pctOf(left), width: pctOf(width), background: color, minWidth: MIN_MARK_PX }} />
      ) : (
        // 耗时为 0 的记录（没有模型回应的提问、打断标记、贴着上一条事件生成的响应）：
        // 画一道竖直缺口。给它一条宽度等于谎报时长
        <span style={{ ...wfBarStyle, left: `calc(${pctOf(left)} - ${MIN_MARK_PX / 2}px)`, width: MIN_MARK_PX, background: color }} />
      )}
    </span>
  )
}

/** 展开详情：完整 ID + 操作按钮 + 请求/响应并排面板 */
/**
 * ID 旁边那句提示。按记录类型说清「为什么没有树节点」——
 * 模型响应与等用户在树上是**类别汇总**（compute 是补集算出来的一个数），本来就不逐条上树；
 * 只有工具/委派行找不到节点才是真异常，那句提示留给它。
 */
function locateHint(row: LogRow, locatable: boolean): string {
  if (locatable) return '· 点 ID 可在树视图定位该记录'
  if (row.kind === 'llm') return '· 模型响应按类别汇总进「模型思考」，不逐条上树'
  if (row.kind === 'wait') return '· 等用户按类别汇总，不逐条上树'
  return '· 该记录没有对应的树节点'
}

function DetailPanels(props: {
  row: LogRow
  locatable: boolean
  onCopy: (text: string, tip: string) => void
  onLocate: (toolUseId: string) => void
}): JSX.Element {
  const { row, onCopy, onLocate } = props
  const actions: { label: string; run: () => void }[] = [
    { label: '复制 ID', run: () => onCopy(row.fullId, '已复制记录 ID') },
    { label: '复制摘要', run: () => onCopy(row.summary, '已复制摘要') },
  ]
  if (props.locatable) actions.push({ label: '在树视图定位', run: () => onLocate(row.fullId) })

  return (
    <div style={detailStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
        <span
          style={{ ...monoStyle, color: 'var(--text)', fontWeight: 700, cursor: props.locatable ? 'pointer' : 'default' }}
          title={props.locatable ? '在树视图定位该记录' : undefined}
          onClick={() => {
            if (props.locatable) onLocate(row.fullId)
          }}
        >
          {row.fullId}
        </span>
        <span style={{ color: 'var(--text-faint)', fontSize: 'var(--fs-xs)' }}>{locateHint(row, props.locatable)}</span>
        <div style={{ flex: 1, height: 1 }} />
        {actions.map((a) => (
          <button key={a.label} type="button" onClick={a.run} style={detailBtnStyle}>
            {a.label}
          </button>
        ))}
      </div>
      {groupPanels(row.panels).map(([group, panels]) => {
        // 同一排共用一档限高，且矮面板两两叠进一列 —— 两者合起来才让一排卡片等高（见 packColumns）
        const cap = rowCapOf(panels)
        return (
          <div key={group} style={panelGroupStyle}>
            {/* 合并行有几块（提问那半 / 模型那半 / 某个工具那半），各自起个名；没分组就不画标题 */}
            {group === '' ? null : <div style={panelGroupTitleStyle}>{group}</div>}
            <div style={panelRowStyle}>
              {packColumns(panels).map((column, i) => (
                <div key={i} style={columnStyle(column)}>
                  {column.map((p, j) => (
                    <Panel key={`${p.label}-${j}`} panel={p} cap={cap} />
                  ))}
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** 列最小宽度（px）：分宽只吃「多余的那部分」，权重再极端也不该把哪一列挤到读不了 */
const PANEL_MIN_W = 210
/** 文本面板正文的限高（px）：约九行，够看清一段内容怎么起头；多了就该点「展开」 */
const PANEL_MAX_H = 130
/** code 面板（JSON 入参 / 工具输出）的限高：行更长更密，多给一点 */
const PANEL_CODE_MAX_H = 180
/**
 * 矮面板的行数上限：估算正文不到这么多行的面板（运行情况这种几行的文本块），
 * 与同为矮的伙伴叠进同一列。
 *
 * 取 4 而不是更小：两块叠起来刚好与「一块满限高的卡片 + 两个标题行」差不多高（约 150px），
 * 再高这一列就会顶着整排变高；再小则连四五行的短面板都算不进去，而那正是最该叠的一块。
 */
const SHORT_PANEL_LINES = 4
/** 文本正文的行数估算：等宽 11px、列最窄 210px 时一行大约这么多字符 */
const CHARS_PER_LINE = 40
/** 段的最小宽度（px）：窄到装不下两段时它们会换行上下叠，而不是并排成两条读不了的窄缝 */
const SECTION_MIN_W = 190
/** 判定「超出」时的容差（px）：亚像素布局下 scrollHeight 常比 clientHeight 大 1 */
const OVERFLOW_SLACK_PX = 1
/** 面板右上角那个开关的两个字面 */
const PANEL_EXPAND = '展开'
const PANEL_COLLAPSE = '收起'

/**
 * 一块面板：标题行（名字 · meta · 耗时徽标 · 展开）+ 正文。
 *
 * 正文默认**限高内滚**，真的超出一屏时标题行右侧才出现「展开」（点了不限高）—— 一条两万字符的
 * 工具输出摊开会把整页顶得看不见列表，而多数时候只需要扫一眼开头。
 *
 * `cap` 是**这一排共用的那一档**（见 `rowCapOf`）：同一排的面板上限相同，卡片才会等高；
 * 正文自身 `flex: 1`，内容不到上限时把卡片填满，不在下半张卡里留一块白。
 *
 * 折行按 `format` 分：code（JSON 入参 / 工具输出）不折行、横向滚；文本折行。
 * 带 `sections` 的面板里每段各自成块、各自滚（见 `LogPanel.sections`：合进一个滚动框时
 * 思考一长就把输出顶到看不见），限高落在**整排段**上而不是每段上 —— 否则分段面板会比同排的
 * 普通面板高出一个段标题行，等高就破了。
 */
function Panel(props: { panel: LogPanel; /** 这一排共用的正文限高（px） */ cap: number }): JSX.Element {
  const { panel, cap } = props
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  /** 正文那一块（普通面板是那个 `<pre>`，分段面板是整排段）—— 双击 / Cmd+A 选中的就是它的内容 */
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const code = panel.format === 'code'

  // 真的超出去才给「展开」：不超出时那个按钮点了什么也不会变。
  // 量的是面板里那几个 <pre>（正文只有它们是滚动框），宽度变化也会改高度，所以两个尺寸都观察。
  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const boxes = [...box.querySelectorAll('pre')]
    const measure = (): void => {
      const over = boxes.some((n) => n.scrollHeight > n.clientHeight + OVERFLOW_SLACK_PX)
      setOverflowing((prev) => (prev === over ? prev : over))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(box)
    for (const n of boxes) ro.observe(n)
    return () => ro.disconnect()
  }, [panel, expanded])

  return (
    <div
      ref={boxRef}
      style={panelStyle}
      // 可聚焦才能接住 Cmd+A：点一下卡片就落在它身上，此时全选的是这张卡的正文而不是整个页面
      tabIndex={0}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
          e.preventDefault()
          e.stopPropagation()
          selectNodeText(bodyRef.current)
        }
      }}
      onDoubleClick={(e) => {
        // 标题行上的按钮有自己的连击语义（点了就是点了），别把它吃掉
        if ((e.target as HTMLElement).closest('button')) return
        e.preventDefault()
        selectNodeText(bodyRef.current)
      }}
    >
      <div style={panelHeadStyle}>
        <span style={panelLabelStyle}>{panel.label}</span>
        <div style={{ flex: 1, height: 1 }} />
        {panel.meta ? <span style={panelMetaStyle}>{panel.meta}</span> : null}
        {panel.durationMs === undefined ? null : <DurationBadge ms={panel.durationMs} />}
        {overflowing || expanded ? (
          <button type="button" onClick={() => setExpanded((e) => !e)} style={panelToggleStyle}>
            {expanded ? PANEL_COLLAPSE : PANEL_EXPAND}
          </button>
        ) : null}
      </div>
      {panel.sections ? (
        <div style={sectionsStyle} ref={bodyRef}>
          {panel.sections.map((s) => (
            <div key={s.title} style={sectionStyle(weightOf(s.body.length))}>
              <div style={panelHeadStyle}>
                <span style={sectionTitleStyle}>{s.title}</span>
                <div style={{ flex: 1, height: 1 }} />
                {s.meta ? <span style={panelMetaStyle}>{s.meta}</span> : null}
              </div>
              <pre style={bodyStyle(false, expanded, cap)}>{s.body}</pre>
            </div>
          ))}
        </div>
      ) : (
        // 包一层只为挂 ref：普通面板与分段面板因此共用同一个「正文块」的概念
        <div ref={bodyRef} style={panelBodyWrapStyle}>
          <pre style={bodyStyle(code, expanded, cap)}>{panel.body ?? ''}</pre>
        </div>
      )}
    </div>
  )
}

/** 普通面板正文的外壳：把 `<pre>` 撑满卡片余高，同时给「正文块」一个挂 ref 的地方 */
const panelBodyWrapStyle: React.CSSProperties = {
  display: 'flex',
  flex: '1 1 auto',
  minHeight: 0,
}

/**
 * 选中一个元素里的全部文本（双击 / Cmd+A 用）。
 *
 * 走 DOM Selection 而不是自己拼字符串写剪贴板：选中态是**用户自己按 Cmd+C** 的前提，
 * 而且他能看见选了哪些、能再用鼠标微调范围 —— 这是「复制卡片内的全部」这个诉求的最小实现。
 */
function selectNodeText(node: HTMLElement | null): void {
  if (!node) return
  const selection = window.getSelection()
  if (!selection) return
  const range = document.createRange()
  range.selectNodeContents(node)
  selection.removeAllRanges()
  selection.addRange(range)
}

/**
 * 分宽权重：按字符数的**立方根**。
 *
 * 为什么不是线性：一份两万字符的工具输出线性加权会把旁边那栏挤成一条缝，而它自己再宽也只多显示
 * 那么几行。开立方把四十倍的差距压到三倍多 —— 长的仍然明显更宽，短的也还读得了。
 * 下界 1 让空内容（比如「无输出」）也参与分配、点得到。
 */
function weightOf(chars: number): number {
  return Math.max(1, Math.cbrt(chars))
}

/** 一块面板的权重：看它全部正文的长度（分段面板取各段之和），标题与 meta 不参与 */
function panelWeight(p: LogPanel): number {
  return weightOf(bodyLengthOf(p))
}

/** 面板正文的字符数（分段面板取各段之和）。分宽只看正文 —— 标题与 meta 不参与 */
function bodyLengthOf(p: LogPanel): number {
  if (p.sections) return p.sections.reduce((n, s) => n + s.body.length, 0)
  return (p.body ?? '').length
}

/**
 * 耗时筛选：操作符下拉 + 输入框 + 单位下拉。
 *
 * 输入值原样存字符串（敲到一半的 `1.`、`abc` 都不该被改写），解析与边界判定在
 * `core/view/logView.ts::durationBounds`（可单测）；`withDurationOp` 负责切换操作符时
 * 把阈值搬到保持原意的字段上。
 */
function DurationFilter(props: { value: DurationQuery; onChange: (q: DurationQuery) => void }): JSX.Element {
  const { op, a, b, unit } = props.value
  const set = (patch: Partial<DurationQuery>): void => props.onChange({ ...props.value, ...patch })
  const between = op === 'between'
  return (
    <>
      <span style={filterLabelStyle}>耗时</span>
      <select
        value={op}
        onChange={(e) => props.onChange(withDurationOp(props.value, e.target.value as DurationOp))}
        aria-label="耗时比较方式"
        style={selectStyle}
      >
        {DURATION_OPS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <input
        value={a}
        onChange={(e) => set({ a: e.target.value })}
        inputMode="decimal"
        placeholder={between ? '下限' : '阈值'}
        title="含边界"
        aria-label={between ? '耗时下限' : '耗时阈值'}
        style={thresholdInputStyle}
      />
      {between ? (
        <>
          <span style={{ color: 'var(--text-faint)', fontSize: 'var(--fs-xs)' }}>～</span>
          <input
            value={b}
            onChange={(e) => set({ b: e.target.value })}
            inputMode="decimal"
            placeholder="上限"
            title="含边界"
            aria-label="耗时上限"
            style={thresholdInputStyle}
          />
        </>
      ) : null}
      <select
        value={unit}
        onChange={(e) => set({ unit: e.target.value as DurationScale })}
        aria-label="耗时单位"
        style={selectStyle}
      >
        {DURATION_UNITS.map((u) => (
          <option key={u} value={u}>
            {u}
          </option>
        ))}
      </select>
    </>
  )
}

function Chip(props: { active: boolean; onClick: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <button type="button" onClick={props.onClick} aria-pressed={props.active} style={props.active ? chipActiveStyle : chipStyle}>
      {props.children}
    </button>
  )
}

/**
 * 时间选区的 chip：在时间栏上拉出来的那一段。
 *
 * 它**不是**附加装饰而是筛选栏的一员（选区就是一条筛选条件），所以放在这里与类型/状态并列。
 * 条数必须写出来：相交判定是双闭的，贴边的相邻记录也算在内 —— 看到「12 条」的反应是
 * 「边界那条也算」，看不到就会怀疑筛选漏了或多了。
 */
function SelectionChip(props: { selection: ViewWindow; count: number; onClear: () => void }): JSX.Element {
  const { start, end } = props.selection
  return (
    <span style={selectionChipStyle}>
      选区 {fmtClock(start)} → {fmtClock(end)} · {fmtDuration(end - start)} · {props.count} 条
      <button
        type="button"
        onClick={props.onClear}
        aria-label="清除时间选区"
        title="清除时间选区（也可以聚焦手柄按 Esc）"
        style={selectionClearStyle}
      >
        ✕
      </button>
    </span>
  )
}

/** 占比条宽度 */
const SHARE_BAR_W = 90
/**
 * 真实存在但极短的记录必须看得见（最短 2px）—— 占比条与 waterfall 的条共用这一条约定，
 * 两处各写一个 2 迟早会一处改了一处没改。
 */
const MIN_MARK_PX = 2

/** waterfall 列的轨道：一条贯穿列宽的横槽，条在里面按百分比定位 */
const wfTrackStyle: React.CSSProperties = {
  position: 'relative',
  width: '100%',
  height: 8,
  background: 'var(--bg-active)',
  borderRadius: 3,
  overflow: 'hidden',
}

const wfBarStyle: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  bottom: 0,
  borderRadius: 3,
}

const wrapStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
  background: 'var(--bg)',
}

/** 分析面板展开时的高度上限（px）：够读一段报告，又不至于把记录表挤没 */
const ANALYSIS_PANEL_MAX_H = 340
/**
 * 分析面板被挤时的下限（px）= 折叠头自身的高度。
 *
 * 面板与记录表**等权分摊剩余高度**（两者都从 0 起 `flex: 1 1 0`，面板另加一个上限），
 * 于是任何窗口尺寸下两者都非 0、加起来永远等于容器高 —— 页不溢出、记录表也不会被压没。
 *
 * 为什么不给面板一个固定高 + 「按比例缩」的上限：百分比是相对**面板自己**的内容高解析的
 * （面板本身是 auto 高），实测 45% 得到 147px，上限从未生效、反而在所有尺寸下把正文压成一半，
 * 面板底还留一条 147px 的死区。flex 分摊不依赖百分比解析，就没有这类循环依赖。
 */
const ANALYSIS_PANEL_MIN_H = 28

const summaryBarStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 18,
  padding: '8px 12px',
  borderBottom: '1px solid var(--border)',
  flexShrink: 0,
}

const summaryLabelStyle: React.CSSProperties = {
  fontSize: 'var(--fs-xs)',
  color: 'var(--text-tertiary)',
  whiteSpace: 'nowrap',
}

const summaryValueStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 15,
  fontWeight: 700,
  whiteSpace: 'nowrap',
}

const recordCountStyle: React.CSSProperties = {
  fontSize: 'var(--fs-xs)',
  color: 'var(--text-faint)',
  whiteSpace: 'nowrap',
}

const filterBarStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '7px 12px',
  borderBottom: '1px solid var(--border)',
  background: 'var(--bg-subtle)',
  flexWrap: 'wrap',
  flexShrink: 0,
}

const filterLabelStyle: React.CSSProperties = {
  fontSize: 'var(--fs-xs)',
  color: 'var(--text-tertiary)',
  whiteSpace: 'nowrap',
}

const dividerStyle: React.CSSProperties = {
  width: 1,
  height: 16,
  background: 'var(--border)',
  flexShrink: 0,
}

const chipStyle: React.CSSProperties = {
  padding: '3px 10px',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-sm)',
  background: 'var(--bg-elevated)',
  color: 'var(--text-tertiary)',
  fontSize: 'var(--fs-xs)',
  fontWeight: 600,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const chipActiveStyle: React.CSSProperties = {
  ...chipStyle,
  background: 'var(--accent-soft)',
  border: '1px solid var(--accent)',
  color: 'var(--accent)',
}

/** 选区 chip：与「已选中的 chip」同一套强调色（它同样是「筛得只剩一部分」的状态） */
const selectionChipStyle: React.CSSProperties = {
  ...chipActiveStyle,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontFamily: 'var(--font-mono)',
  cursor: 'default',
}

const selectionClearStyle: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  lineHeight: 1,
  padding: '0 2px',
  cursor: 'pointer',
}

const selectStyle: React.CSSProperties = {
  padding: '3px 4px',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-sm)',
  background: 'var(--bg-elevated)',
  color: 'var(--text-secondary)',
  fontSize: 'var(--fs-xs)',
  cursor: 'pointer',
  flexShrink: 0,
}

/** 下拉的定位上下文：菜单相对按钮展开（筛选条不裁剪溢出，所以菜单能盖到表上） */
const kindSelectWrapStyle: React.CSSProperties = {
  position: 'relative',
  display: 'inline-flex',
  flexShrink: 0,
}

function kindBtnStyle(open: boolean, filtered: boolean): React.CSSProperties {
  return {
    ...selectStyle,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    maxWidth: 160,
    // 名字个数有上限，兜底仍给上：菜名再长也不该把这行挤成两行
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    // 有类型被选中时换成强调色：筛选生效这件事必须一眼看得出
    color: filtered ? 'var(--accent)' : 'var(--text-secondary)',
    border: `1px solid ${open || filtered ? 'var(--accent)' : 'var(--border)'}`,
  }
}

const kindMenuStyle: React.CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 4px)',
  left: 0,
  zIndex: 20,
  minWidth: '100%',
  padding: 4,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-sm)',
  boxShadow: '0 4px 12px rgba(0,0,0,0.18)',
}

const kindListStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
}

/** 全选/清空：动作按钮，不是可勾的项 —— 所以不画勾选框，只用一条分隔线与上面五类分开 */
const kindActionStyle: React.CSSProperties = {
  padding: '4px 8px',
  border: 'none',
  borderTop: '1px solid var(--border-subtle)',
  background: 'transparent',
  color: 'var(--accent)',
  fontSize: 'var(--fs-xs)',
  fontWeight: 600,
  textAlign: 'left',
  cursor: 'pointer',
}

function kindItemStyle(active: boolean): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 8px',
    border: 'none',
    borderRadius: 'var(--r-sm)',
    background: active ? 'var(--bg-active)' : 'transparent',
    fontSize: 'var(--fs-xs)',
    textAlign: 'left',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  }
}

function kindCheckStyle(active: boolean): React.CSSProperties {
  return {
    width: 12,
    height: 12,
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 2,
    border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
    background: active ? 'var(--accent)' : 'transparent',
    color: 'var(--on-accent)',
    fontSize: 9,
    lineHeight: 1,
  }
}

const thresholdInputStyle: React.CSSProperties = {
  width: 56,
  padding: '3px 6px',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-sm)',
  background: 'var(--bg-elevated)',
  color: 'var(--text)',
  fontSize: 'var(--fs-xs)',
  fontFamily: 'var(--font-mono)',
  outline: 'none',
  flexShrink: 0,
}

const searchBoxStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  width: 230,
  padding: '4px 10px',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-sm)',
  background: 'var(--bg-elevated)',
  flexShrink: 0,
}

const searchInputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  border: 'none',
  outline: 'none',
  background: 'transparent',
  color: 'var(--text)',
  fontSize: 'var(--fs-xs)',
  fontFamily: 'inherit',
}

const analyzeBtnStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '4px 10px',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-sm)',
  background: 'var(--bg-elevated)',
  color: 'var(--text)',
  fontSize: 'var(--fs-xs)',
  fontWeight: 600,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

/**
 * 分析面板：折叠头一行高；展开时才参与高度分摊（见 analysisPanelOpenStyle）。
 *
 * 三个 flex 分量**一律用长写**：React 在同一个元素上混用 `flex` 简写与 `flexShrink` 长写时，
 * 会在重渲时丢掉冲突的那条属性（并打一条 dev 告警）—— 折叠 ⇄ 展开来回切一次，
 * `flex-shrink` 就没了。这里两个 style 对象会合并到同一个元素上，所以简写一处都不能用。
 */
const analysisPanelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  flexGrow: 0,
  flexShrink: 0,
  flexBasis: 'auto',
  borderTop: '1px solid var(--border)',
  background: 'var(--bg-subtle)',
}

/**
 * 展开态：与记录表等权分摊剩余高度，自己另加一个上限（够读一段报告）与一个下限（不小于折叠头，
 * 否则窗口一矮连「收起」都点不到）。
 */
const analysisPanelOpenStyle: React.CSSProperties = {
  flexGrow: 1,
  flexShrink: 1,
  flexBasis: 0,
  maxHeight: ANALYSIS_PANEL_MAX_H,
  minHeight: ANALYSIS_PANEL_MIN_H,
  overflow: 'hidden',
}

const analysisHeadStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 12px',
  border: 'none',
  background: 'transparent',
  color: 'var(--text)',
  fontSize: 'var(--fs-xs)',
  textAlign: 'left',
  cursor: 'pointer',
}

const analysisTitleStyle: React.CSSProperties = { fontWeight: 600, whiteSpace: 'nowrap' }

const analysisHintStyle: React.CSSProperties = {
  color: 'var(--text-faint)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const analysisStaleStyle: React.CSSProperties = {
  color: 'var(--accent)',
  whiteSpace: 'nowrap',
}

/** 截断说明：与过期提示同属「这份报告没覆盖你以为的范围」，但它是常态而非异常，故用弱色 */
const analysisNoteStyle: React.CSSProperties = {
  color: 'var(--text-tertiary)',
  whiteSpace: 'nowrap',
}

/** 正文吃掉面板除折叠头以外的全部高度（面板多高由上面那套分摊决定，这里不再自己定高） */
const analysisBodyStyle: React.CSSProperties = {
  flexGrow: 1,
  flexShrink: 1,
  flexBasis: 0,
  minHeight: 0,
  overflow: 'hidden',
  background: 'var(--bg)',
  borderTop: '1px solid var(--border)',
}

const tableStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: 'auto',
  padding: '0 4px',
}

const headRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 12px',
  background: 'var(--bg-subtle)',
  borderBottom: '1px solid var(--border)',
  color: 'var(--text-tertiary)',
  fontSize: 'var(--fs-xs)',
  fontWeight: 700,
  position: 'sticky',
  top: 0,
  zIndex: 1,
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '5px 12px',
  fontSize: 'var(--fs-xs)',
  cursor: 'pointer',
  // 分隔线在 styles.css 的 .lv-row 里：组头要把它去掉（`.lv-row-lead`），行内样式会盖住类名
}

/** 单元格：宽度/对齐来自列定义；摘要列吃掉剩余宽度 */
function cellStyle(c: LogColumn, head: boolean): React.CSSProperties {
  return {
    width: c.width,
    flex: c.width == null ? '1 1 auto' : `0 0 ${c.width}px`,
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: justifyOf(c.align),
    overflow: head ? 'visible' : 'hidden',
    whiteSpace: 'nowrap',
  }
}

function justifyOf(align: LogColumn['align']): string {
  return align === 'right' ? 'flex-end' : align === 'center' ? 'center' : 'flex-start'
}

const monoStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-xs)',
  whiteSpace: 'nowrap',
}

const badgeStyle: React.CSSProperties = {
  fontSize: 'var(--fs-xs)',
  fontWeight: 700,
  padding: '2px 6px',
  borderRadius: 'var(--r-sm)',
  whiteSpace: 'nowrap',
}

/**
 * 展开后的那块：面板与子 agent 记录只是它的**内容**，底色、左侧竖线、外边界统一由外层
 * `.lv-detail` 表达（见 `styles.css`）—— 面板卡片照旧，但整块看起来是上面那条记录往下延伸出来的
 * 一段，而不是另起一块区域。
 *
 * 这里是**布局**：左缩进 12px 与行的内边距对齐（原来是 48px，为了对齐列 —— 但一屏 1200px 宽时
 * 它吃的是正文宽度，也让这块越看越不像行里的东西）。
 */
const detailStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 5,
}

/** 子 agent 记录：只负责块内的排布，底色/边界/竖线归外层 `.lv-detail` */
const childListStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
}

/**
 * 子 agent 的摘要行：折叠时这一行就是它的全部占位（名字 / 条数 / 总耗时）。
 * 纵向留白比原先的块标题小 —— 一次 workflow 展开会连着摆 3–7 行，每行多 4px 就是几十像素。
 */
const childSummaryStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--sp-1)',
  padding: '5px 0',
  color: 'var(--text-tertiary)',
  fontSize: 'var(--fs-xs)',
  fontWeight: 700,
  cursor: 'pointer',
}

/** 子表限高可滚：一个上千条的子会话不该把主表顶得看不见 */
const childTableStyle: React.CSSProperties = {
  maxHeight: 420,
  overflow: 'auto',
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderLeft: '2px solid var(--border-strong)',
  borderRadius: 'var(--r-sm)',
}

const childEmptyStyle: React.CSSProperties = {
  padding: '8px 0',
  color: 'var(--text-faint)',
  fontSize: 'var(--fs-xs)',
}

const detailBtnStyle: React.CSSProperties = {
  padding: '3px 9px',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-sm)',
  background: 'var(--bg-elevated)',
  color: 'var(--text-secondary)',
  fontSize: 'var(--fs-xs)',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

/**
 * 面板右上角的耗时徽标。
 *
 * 前景色与耗时列**同一套**量级口径（ms 灰 / s 蓝 / m 橙）—— 两处各定一套阈值就会出现
 * 「列里是橙的、展开里是蓝的」这种自相矛盾。
 *
 * 底色不按档位变，是统一的：毫秒级那个灰与旁边的灰字 `meta` 是同一个色，光靠加粗根本看不出
 * 「这是个被标出来的数」。一块底色把它变成徽标，档位仍由前景色说 —— 一眼能认出这里有耗时，
 * 再看是蓝还是橙就知道量级。
 */
function DurationBadge(props: { ms: number }): JSX.Element {
  return (
    <span
      style={{
        ...monoStyle,
        fontWeight: 700,
        color: DURATION_SCALE_COLOR[durationScale(props.ms)],
        background: 'var(--bg-active)',
        borderRadius: 'var(--r-sm)',
        padding: '1px 6px',
      }}
    >
      {fmtDuration(props.ms)}
    </span>
  )
}

/**
 * 合并行里的一块区域（提问 / 模型响应 / 某个工具那半）。
 *
 * **不套外框**：原来这里是一层带边框的盒子，面板自己又是一层带边框的盒子，两层框叠起来是这块
 * 最花的地方。现在只留一行小标题做分隔，视觉层级交给标题与缩进说。
 */
const panelGroupStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  width: '100%',
}

const panelGroupTitleStyle: React.CSSProperties = {
  color: 'var(--text-tertiary)',
  fontSize: 'var(--fs-xs)',
  fontWeight: 700,
}

/**
 * 按 `LogPanel.group` 聚拢，保持首次出现的顺序。
 * 未分组的行只有一组（group = ''），视图不画标题 —— 与合并前长得一样。
 */
function groupPanels(panels: LogPanel[]): [string, LogPanel[]][] {
  const out: [string, LogPanel[]][] = []
  for (const p of panels) {
    const name = p.group ?? ''
    const hit = out.find(([g]) => g === name)
    if (hit) hit[1].push(p)
    else out.push([name, [p]])
  }
  return out
}

/**
 * 同排的列：宽度按列内最长那块的 `panelWeight` 分配（`flexBasis: 0` + 按权重 grow），
 * 下界由 `PANEL_MIN_W` 兜。
 *
 * `alignItems: stretch`：一排里的列**等高** —— 这是这版布局的前提，卡片高度由最高的那一列定，
 * 其余列拉齐，不再各是各的高度。
 */
const panelRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'stretch',
  gap: 8,
  width: '100%',
  // 窗口窄时宁可换行，也不把哪一列压到最小宽度以下
  flexWrap: 'wrap',
}

/** 一列：宽度按权重，纵向可以叠一到两块（矮的那些，见 `packColumns`） */
function columnStyle(column: LogPanel[]): React.CSSProperties {
  return {
    flexGrow: Math.max(...column.map(panelWeight)),
    flexShrink: 1,
    flexBasis: 0,
    minWidth: PANEL_MIN_W,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  }
}

/** 卡片：填满所在列（`flex: 1`），内容不到限高时也把卡撑满 —— 同排才不会下沿参差 */
const panelStyle: React.CSSProperties = {
  flex: '1 1 auto',
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '6px 8px',
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-md)',
}

/**
 * 正文估算行数：code 不折行，数换行；文本按每行字数折算；分段面板取最长的那一段。
 *
 * 只是拿来做「这块撑不撑得起一列」的判断，不要求准 —— 判错的代价是叠放与否，
 * 不是内容错位。
 */
function estLines(p: LogPanel): number {
  if (p.sections) return Math.max(...p.sections.map((s) => estLines({ label: s.title, body: s.body })))
  const body = p.body ?? ''
  // code 不折行：有几行就是几行。文本折行：逐行折（整段一起除会漏掉「四行短句」这种）
  if (p.format === 'code') return body.split('\n').length
  return body
    .split('\n')
    .reduce((n, line) => n + Math.max(1, Math.ceil(line.length / CHARS_PER_LINE)), 0)
}

/** 矮面板：估算撑不到 `SHORT_PANEL_LINES` 行 */
function isShortPanel(p: LogPanel): boolean {
  return estLines(p) <= SHORT_PANEL_LINES
}

/**
 * 把一排面板排成列：**高的各占一列，矮的按出现顺序收进同一列上下叠放**。
 *
 * 为什么要合：运行情况这类只有几行的文本块各自占一列时，一行里几列的高度差得远，
 * 矮的下半列全是空白；叠成一列后它们把那一列的高度用起来，同排也就齐了。
 * 叠放列落在**第一个矮面板**出现的位置，其余保持原顺序（面板都自带标题，顺序感不会丢）。
 */
function packColumns(panels: LogPanel[]): LogPanel[][] {
  const columns: LogPanel[][] = []
  const shorts: LogPanel[] = []
  for (const p of panels) {
    if (!isShortPanel(p)) {
      columns.push([p])
      continue
    }
    // 第一次遇到矮面板时先把空列放进去，后续的矮面板都往这一列追加
    if (shorts.length === 0) columns.push(shorts)
    shorts.push(p)
  }
  return columns
}

/** 这一排共用的正文限高：取各块上限的最大值（code 那档更高），同排因此等高 */
function rowCapOf(panels: LogPanel[]): number {
  return Math.max(...panels.map((p) => (p.format === 'code' ? PANEL_CODE_MAX_H : PANEL_MAX_H)))
}

/** 面板与面板内的段共用的一行标题：名字 · 右侧的 meta / 徽标 / 展开都对它对齐 */
const panelHeadStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
}

/**
 * 卡片标题（请求 · tool_use / 响应 · tool_result / 模型响应 …）。
 *
 * 比正文重一档是**层级**，不是装饰：卡片里除标题外全是 `--fs-xs` 的灰字（meta、正文、段名），
 * 标题用全站最重的那档颜色 + 大一档字号，扫一眼先看到「这块是什么」，再决定读不读。
 */
const panelLabelStyle: React.CSSProperties = {
  color: 'var(--text)',
  fontSize: 'var(--fs-sm)',
  fontWeight: 700,
}

/** 段标题（思考 / 输出）：比面板名再轻一档，层级不靠加粗硬撑 */
const sectionTitleStyle: React.CSSProperties = {
  color: 'var(--text-tertiary)',
  fontSize: 'var(--fs-xs)',
  fontWeight: 600,
}

const panelMetaStyle: React.CSSProperties = {
  ...monoStyle,
  color: 'var(--text-faint)',
}

/**
 * 面板内的一段（思考 / 输出）：段名一行 + 各自滚动的正文。
 *
 * 与面板同一套分宽规则（并排、按长度分宽、窄了就换行）—— 思考与输出**并列**看，比上下叠省掉
 * 一半高度；两段各滚各的，思考再长也不会把输出顶出视野。
 */
function sectionStyle(weight: number): React.CSSProperties {
  return {
    flexGrow: weight,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: SECTION_MIN_W,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  }
}

/**
 * 分段面板里的那一排段：只负责把卡片剩下的高度占满。
 *
 * **限高不能放在这一层**：`align-items: stretch` 把段拉到按内容算出的行高，容器的 `max-height`
 * 约束不到它 —— 真机量到 9171px 的正文把整行顶到 9190px，而段里的 `<pre>` 自己不滚
 * （`scrollHeight === clientHeight`），于是溢出检测恒为假、「展开」按钮永远不出现。
 * 限高落在每个 `<pre>` 上（那才是滚动框）；代价是分段卡片比自己带正文的卡片高出一个段标题行，
 * 同排其余卡片被 stretch 拉齐后底部多十几像素空白 —— 换的是卡片一样高。
 */
const sectionsStyle: React.CSSProperties = {
  ...panelRowStyle,
  flex: '1 1 auto',
  minHeight: 0,
}

/** 「展开 / 收起」：内容真的超出一屏时才出现，所以不占常驻版面 */
const panelToggleStyle: React.CSSProperties = {
  padding: 0,
  border: 'none',
  background: 'transparent',
  color: 'var(--accent)',
  fontSize: 'var(--fs-xs)',
  fontWeight: 600,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

/**
 * 正文滚动框：默认限高，`expanded` 时不限高。
 *
 * code（JSON 入参 / 工具输出）**不折行**：折了之后缩进与对齐全乱，反倒更难读 —— 宽度不够就横向滚。
 */
function bodyStyle(code: boolean, expanded: boolean, cap: number): React.CSSProperties {
  return {
    ...bodyBase(code),
    // 撑满卡片剩下的高度：内容不到限高时也让卡片是满的，同排下沿才齐
    flex: '1 1 auto',
    minHeight: 0,
    maxHeight: expanded ? undefined : cap,
  }
}

/** 正文的字体与折行规矩（限高与撑高分给上面两个） */
function bodyBase(code: boolean): React.CSSProperties {
  return {
    margin: 0,
    overflow: 'auto',
    whiteSpace: code ? 'pre' : 'pre-wrap',
    wordBreak: code ? 'normal' : 'break-word',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--fs-xs)',
    lineHeight: 1.55,
    color: 'var(--text-secondary)',
  }
}

const emptyStyle: React.CSSProperties = {
  padding: 'var(--sp-5)',
  textAlign: 'center',
  color: 'var(--text-faint)',
  fontSize: 'var(--fs-sm)',
}
