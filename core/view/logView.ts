import type { ApiError, AssistantMsg, ContentBlock, NodeTime, Session, StructuredResult, ToolCall, TurnDuration, Usage, UserMsg, WorkflowRun } from '../parser/types'
import { WORKFLOW_STATUS_COMPLETED } from '../parser/workflowRun'
import { classifyTool } from '../model/classify'
import { breakdownOf, interTurnGaps } from '../model/timeBreakdown'
import { subtractInterval, unionDuration, type Interval } from '../model/timeline'
import { CATEGORY_COLORS, childWallOf } from './treeView'
import { fmtClock, fmtDuration, fmtMs, fmtTokens, fmtTs, shortModel, unitToMs, type DurationScale } from './format'
import type { ViewWindow } from './window'

/**
 * 日志视图（页签「日志视图」）的数据模型：把一个 Session 摊成一条条**按时序排列的记录**，
 * 每行 = 一次用户提问（轮首）/ 一次 LLM 响应 / 一次工具调用 / 一次委派 / 一段等用户。
 *
 * 与树视图的分工：树视图回答「时间花在哪一类上」（分类汇总，同一秒只归一类），
 * 日志视图回答「这一步具体是什么、花了多久、成了没有」（逐条记录，允许并行重叠）。
 * 两者读的是同一份解析结果与同一份类别配色，差别只在聚合粒度。
 */

export type LogRowKind = 'llm' | 'tool' | 'subagent' | 'workflow' | 'wait' | 'user'
export type LogRowStatus = 'ok' | 'error' | 'na'

/** 面板正文的呈现方式：`code`（JSON 入参 / 工具输出）不折行、限高更高。不填按文本处理。 */
export type PanelFormat = 'text' | 'code'

/** 面板正文里的一段（模型那半的「思考」「输出」）。 */
export interface LogPanelSection {
  /** 段名 */
  title: string
  body: string
  /** 段标题右侧的体量说明（字数） */
  meta?: string
}

/** 展开详情里的一个面板（请求/响应/思考/输出）。 */
export interface LogPanel {
  label: string
  meta?: string
  /**
   * 这块面板对应的耗时。单独一个字段而不是塞进 `meta` 字符串里 —— 视图要按量级给它上色
   * （与耗时列同一套：ms 灰 / s 蓝 / m 橙），字符串里夹着的数字没法单独着色。
   */
  durationMs?: number
  /**
   * 面板属于哪一块区域。不填 = 该行只有一块，视图按现在这样横排渲染。
   *
   * 只有「提问 + 模型响应」合并成的那一行会带两块（提问那半 / 模型那半）：
   * 不分块的话，「我问了什么」和「它答了什么」会混在一摊面板里看不出谁是谁。
   */
  group?: string
  format?: PanelFormat
  /** 单段正文。与 `sections` 二选一。 */
  body?: string
  /**
   * 分段正文：同一块面板里的各段**各自成块、各自限高滚动**。
   *
   * 为什么不由 `body` 拼好一整段：两段塞进同一个滚动框时，前一段一长就把后一段顶到框外 ——
   * 一条思考长的响应展开后只看得到「思考」，「输出」得滚到底才露头，读起来像它压根没说话。
   * 分成两段后两段始终同时可见，各滚各的。
   */
  sections?: LogPanelSection[]
}

/**
 * 一条模型响应的 token 账（见 usageInputTokens）。表格列与「模型响应」面板的 meta 读的是同一份数
 * （panelTokenMeta 也走这里），两处不会各写一个数。
 */
export interface LogRowTokens {
  /** 输入 = 非缓存输入 + 缓存写入 + 缓存读取（模型实际读到的上下文量） */
  input: number
  output: number
}

export interface LogRow {
  /** 记录 ID 的短写法（列宽 12 字符），完整值在 fullId */
  id: string
  fullId: string
  kind: LogRowKind
  /** 行的时刻（工具记录用开始时刻） */
  ts: number
  /** 操作列：工具名 / 模型名 / 「—」 */
  action: string
  summary: string
  status: LogRowStatus
  /**
   * 这一行调模型时读进/写出的 token（表格「输入/输出」列）。没有模型那半的行 → null
   * （用户提问、等用户、以及**没有**被任何响应发起的工具行）。
   *
   * 合并过的行（提问+回答 / 想+做）取模型那半的账：那一半本来就在这行的耗时里，
   * 数字跟着它走才对得上「这一步花了多久、用掉多少 token」。
   */
  tokens: LogRowTokens | null
  durationMs: number
  /** 该行属于哪一轮（轮号从 0 起，与 `Turn.index` 一致）。轮间间隙不属于任何一轮 → null。 */
  turn: number | null
  /**
   * 本条响应发起的工具名（只有模型行非空）。
   *
   * 有了它，列表里就能一眼看出「这条模型响应干了什么」—— 纯 tool_use 的响应既没文本也没思考，
   * 不写出来它们在表里就只剩一串 token 数。视图层也用它把这条和紧随的工具行圈成一组。
   */
  invokedTools: string[]
  /** 发起本工具调用的那条模型响应的 uuid（工具行专用，用来跟上一行视觉连贯）。找不到 → null。 */
  leadId: string | null
  /**
   * 这一行由哪两半合并而来（没合并 → null）：
   *  - `user` = 一轮的提问 + 该轮**第一条**响应（开场那一对：问与答，见 `mergeUserLlmRows`）
   *  - `tool` = 模型响应 + 它发起的**那一个**工具（一步「想 + 做」，见 `mergeToolRows`）
   *
   * `kind` 不变（筛选、配色、时间栏都按它走），这个标记只影响**类型列的文字**与下一步合并的取舍：
   * 开场那一对不再与工具合并（它发起的工具单独一行）。
   */
  mergedWith: 'user' | 'tool' | null
  panels: LogPanel[]
  /**
   * 委派行对应的子 agent 会话（没有子 transcript 时为 undefined，见 `linkSubagents`）。
   *
   * 只带引用、不在这里摊开它的记录：子会话可以上千条，每条委派行都预先摊开会让加载成本
   * 按子 agent 数量放大。视图在**展开那一条**时才 `buildLogRows(childSession)`。
   */
  childSession?: Session
  /** workflow 行这一跑下面的子 agent 会话（一次调用背后是一整套）。只有 workflow 行有。 */
  childSessions?: Session[]
  /** workflow 调用对应的运行记录（真实耗时/状态/结果都在这）。只有 workflow 行有。 */
  workflowRun?: WorkflowRun
}

/**
 * 汇总条读的这份数字**就是** `breakdownOf` 的返回（`NodeTime`），不是它的一份改名副本。
 *
 * 曾经这里是重写过的六个字段（少一个 `localToolMs`）—— 于是「本地工具」只能靠三类相加得到，
 * 而它有并集：workflow 在后台跑时相加会把同一秒算几遍，`wallMs = 等用户 + 本地工具 + compute`
 * 当场破掉，同一会话的日志视图与树视图会打出两个百分比。留成同一个类型，这类漂移在编译期就不成立。
 */
export type LogSummary = NodeTime

/** 类型徽章/筛选 chip/占比条共用的「标签 + 配色」，配色直接引用类别色变量（明暗主题自动跟随）。 */
export const LOG_KIND_STYLE: Record<LogRowKind, { label: string; color: string; soft: string }> = {
  llm: { label: 'LLM', color: CATEGORY_COLORS.compute, soft: 'var(--cat-compute-soft)' },
  tool: { label: '工具', color: CATEGORY_COLORS.direct, soft: 'var(--cat-direct-soft)' },
  // 委派用工具名说话（操作列本来就写着 `Agent · explore`）：它是一个独立的类型，
  // 不并入「工具」那一类。
  subagent: { label: 'Agent', color: CATEGORY_COLORS.delegated, soft: 'var(--cat-delegated-soft)' },
  // workflow 同理单列：一次调用背后是一整套跑几分钟的子 agent，与「一次工具调用」不是一回事
  workflow: { label: 'workflow', color: CATEGORY_COLORS.workflow, soft: 'var(--cat-workflow-soft)' },
  wait: { label: '等用户', color: CATEGORY_COLORS.waitUser, soft: 'var(--cat-wait-soft)' },
  // 用户提问自己的色（`--cat-user`，不放进 CATEGORY_COLORS —— 那四色参与时间分解的代数，
  // `wallMs = waitUser + localTool + compute`，日志行类型不进那个等式）。
  // 不能借「等用户」的灰：等待与「人真正说的话」是两回事，撞色会让两种行分不出来。
  user: { label: '用户', color: 'var(--cat-user)', soft: 'var(--cat-user-soft)' },
}

/** 类型筛选的固定顺序（含「全部」），UI 与测试共用一份，避免两处各写一遍。 */
export const LOG_KINDS: LogRowKind[] = ['user', 'llm', 'tool', 'subagent', 'workflow', 'wait']

/** 开场那一对的类型列文字：明说这一行由哪两半组成（用户的提问 + 模型的回答）。 */
export const USER_LLM_KIND_LABEL = '用户+LLM'
/** 「想 + 做」合并行的类型列文字：模型响应 + 它发起的那一个工具。 */
export const MERGED_KIND_LABEL = 'LLM+工具'

/**
 * 类型列的显示文字。**徽章、筛选 chip、交给 claude 的记录表三处都必须走这一个函数** ——
 * 徽章写「LLM+工具」而记录表写「工具」是同一份数据说两套话，正是这套视图最该避免的那类不一致。
 * （`kind` 字段本身不变：筛选用的是 `llm`/`tool`，展示文案不反过来改写数据口径。）
 *
 * 一条不变式：**一个文案只对应一个颜色**（颜色由徽章、筛选 chip、占比条、时间栏块、waterfall 条
 * 各自读 `LOG_KIND_STYLE[row.kind]` 得到）。委派与 workflow 行因此都不吃「LLM+工具」的通用文案 ——
 * 它们也由「模型响应 + 派出去的那个工具」合并而来，但读的人先要认出「这一步把活交出去了」；
 * 否则同一个「LLM+工具」会既是蓝的（直连工具）又是橙的（委派）/紫的（workflow），而这两类往往
 * 又都超过一分钟，看着像「按耗时变色」。
 */
export function kindLabelOf(row: LogRow): string {
  if (row.mergedWith === 'user') return USER_LLM_KIND_LABEL
  if (row.mergedWith === 'tool') {
    const style = LOG_KIND_STYLE[row.kind]
    return row.kind === 'subagent' || row.kind === 'workflow' ? style.label : MERGED_KIND_LABEL
  }
  return LOG_KIND_STYLE[row.kind].label
}

/**
 * 耗时列的量级配色：毫秒级灰、秒级蓝、分钟级橙。越慢越热。
 *
 * 档位由 `durationScale` 判定，**与印出来的单位同源** —— 颜色说「秒级」而数字写着 `88ms`
 * 是这类界面上最伤信任的一类错，所以两者共用一个边界函数，并有测试钉住一致性。
 * 复用类别色变量（而不是新造一组色号）：它们本来就在同一套明暗 token 里，且与占比条同色系。
 */
export const DURATION_SCALE_COLOR: Record<DurationScale, string> = {
  ms: 'var(--text-tertiary)',
  s: CATEGORY_COLORS.direct,
  m: CATEGORY_COLORS.delegated,
}

/** 记录 ID 列宽 12 字符 */
const SHORT_ID_LEN = 12
/** 摘要列的文本预览上限 */
const SUMMARY_MAX = 60
const ELLIPSIS = '…'
/** 摘要里标记「这条响应发起了哪些工具」的前缀，视图层据此把下一行圈进同一组 */
export const ARROW_INVOKE = '→'
/** 「想 + 做」合并行的操作列前缀：`tool_use + Bash` —— 明说这一行由哪两半组成 */
export const TOOL_USE_LABEL = 'tool_use'
/** 用户提问行的操作列/面板标题。合并行的操作列靠它拼出 `提问 + <模型名>`。 */
export const USER_ASK_LABEL = '提问'
/** 打断标记那一行的操作列/面板标题：cc 写的标记，不是用户说的话（见 UserMsg.isInterrupt）。 */
export const USER_INTERRUPT_LABEL = '用户打断'
/** 合并行里模型那一半的面板所属区域名，同时也是「思考 + 输出」那块面板的名字（同一件东西）。 */
export const GROUP_LLM = '模型响应'
/** 「思考 + 输出」那块面板正文里两段的段名。 */
const THINKING_LABEL = '思考'
const OUTPUT_LABEL = '输出'
/** 「运行情况」面板的标题：cc 自报的这次执行情况（中文名，不把解析器的术语端上界面）。 */
const RUN_INFO_LABEL = '运行情况'
/** 「workflow 结果」面板的标题：workflow 脚本自己写进 run 记录的 result。 */
const WORKFLOW_RESULT_LABEL = 'workflow 结果'
/** 工具那半的两块面板：请求（参数）与响应（输出）。委派行只留这两块，所以标题要能按名字找到。 */
const REQUEST_LABEL = '请求 · tool_use'
const RESULT_LABEL = '响应 · tool_result'

/** 上游 API 错误行的摘要抬头（`API Error (rate_limit 429): …`）。视图层不单独用，不导出。 */
const API_ERROR_LABEL = 'API Error'
/** cc 没给出可分类的错误名（本机 86 条里 44 条如此）时抬头里写的兜底，与状态码查不到回退「未知」同一套。 */
const API_ERROR_KIND_FALLBACK = '未知'
/**
 * 归类名长过这个数就不往抬头里放。
 *
 * 真样本 86 条的归类全是短标识（最长 `model_not_found`，15 字符）。这是给「万一某个 cc 版本把堆栈或
 * 整段正文写进 `error`」兜底：抬头是一行摘要，塞进几百字符的堆栈就整行读不成话了 —— 宁可回退「未知」，
 * 正文在展开面板里一字不少。
 */
const API_ERROR_KIND_MAX_LEN = 32
/** 错误正文自带的抬头（`API Error: 400 …`）：摘要外层写着同一个词，剥掉它免得念两遍。 */
const API_ERROR_TEXT_PREFIX = /^API Error:\s*/i
/** 正文抬头后紧跟的 HTTP 码（`400 Model do not support…` 里的那个 400）。 */
const API_ERROR_STATUS_PREFIX = /^\d{3}\s+/

/**
 * 把会话摊成日志行（按时序，同刻内 LLM 在其工具之前）。
 *
 * 耗时口径逐类不同，且都不是「猜」的：
 *  - 工具/委派：解析器实测（工具 = tool_use→tool_result；委派 = 子 agent 真实区间，见 childWallOf）
 *  - LLM：本条时刻 − 上一条事件的结束（即两件事之间的纯等待/生成时间；
 *    会话首条则从会话开始算）→ 于是所有行的耗时加起来 ≈ 会话总耗时
 *  - 等用户：轮间间隙（与分解模型同一个 interTurnGaps），并裁掉已被前面记录覆盖的部分
 *    （人在等、后台 agent 在跑时，那段时间算 agent 的不算空闲）
 */
export function buildLogRows(session: Session): LogRow[] {
  const pending: LogRow[] = []

  for (const turn of session.turns) {
    // 一轮的起点：用户提问。没有它，日志里看不出「这轮我是怎么开的场」，轮边界只能靠
    // 「等待用户输入」那行往下猜。空文本的 user 消息（纯工具回执那类）不建行。
    if (turn.userMsg && turn.userMsg.text.trim()) pending.push(userRow(turn.userMsg, turn.index))
    const msgs = [...turn.assistantMsgs].sort((a, b) => a.ts - b.ts)
    // 配对按 tool_use 块的 id，不按时刻：一条消息的多个块来自多条 jsonl 记录，
    // 而消息的时刻是最后那条记录（见 types.ts::AssistantMsg），拿它跟工具的开始时刻对不上。
    const issued = new Set<string>()
    for (const msg of msgs) {
      pending.push(llmRow(msg, turn.index))
      // 该条响应发起的工具紧随其后，先出模型行再出工具行
      for (const tc of turn.toolCalls) {
        if (!invokedToolIds(msg).includes(tc.toolUseId)) continue
        issued.add(tc.toolUseId)
        pending.push(callRow(tc, turn.index, msg.uuid))
      }
    }
    // 没有对应 assistant 消息的工具调用（结果回执先到等罕见情形）：补在轮末，不丢记录
    for (const tc of turn.toolCalls) {
      if (!issued.has(tc.toolUseId)) pending.push(callRow(tc, turn.index, null))
    }
  }

  const gaps = interTurnGaps(session)
  gaps.forEach((iv, i) => pending.push(gapRow(iv, i + 1)))

  // 稳定排序：ts 相同则保持插入顺序（LLM 在其工具之前）
  const rows = pending
    .map((row, seq) => ({ row, seq }))
    .sort((a, b) => a.row.ts - b.row.ts || a.seq - b.seq)
    .map((x) => x.row)

  assignDurations(rows, session)
  const merged = mergeToolRows(mergeUserLlmRows(rows))
  attachTurnReconciliation(merged, session)
  return merged
}

/**
 * 把每一轮的提问行与这一轮**第一条**模型响应并成一行。
 *
 * 为什么按这一对并：「我问了什么 / 它答了什么」是一次往返，读的时候是一件事 —— 分开成两行时，
 * 提问行恒为 0ms 的孤行，而模型的思考/正文却挂在别处。工具执行不是这次往返的一部分，
 * 各自成行（委派也一样），于是「这一步跑了什么、跑了多久」不再被回答那半的耗时污染。
 *
 * 按**轮**配对而不是按相邻两行：cc 会先落盘工具记录、后落盘那条消息的收尾记录（本机 40 个大会话里
 * 48 轮如此，占已作答轮次的约一成），于是提问行与响应行之间会夹着那个工具行。按相邻配，
 * 这些轮的提问就永远是孤行。
 */
function mergeUserLlmRows(rows: LogRow[]): LogRow[] {
  const userAt = new Map<number, number>()
  const llmAt = new Map<number, number>()
  rows.forEach((r, i) => {
    if (r.turn === null) return
    if (r.kind === 'user' && !userAt.has(r.turn)) userAt.set(r.turn, i)
    else if (r.kind === 'llm' && !llmAt.has(r.turn)) llmAt.set(r.turn, i)
  })

  const merged = new Map<number, LogRow>()
  const absorbed = new Set<number>()
  for (const [turn, userIdx] of userAt) {
    const llmIdx = llmAt.get(turn)
    if (llmIdx === undefined) continue // 这一轮没有响应：提问行自己留着（打断标记多属此类）
    merged.set(llmIdx, mergedUserRow(rows[userIdx], rows[llmIdx]))
    absorbed.add(userIdx)
  }
  return rows.flatMap((r, i) => (absorbed.has(i) ? [] : [merged.get(i) ?? r]))
}

/**
 * 一次问答 = 提问那半（用户的话）+ 模型那半（token / 思考 / 正文 / 它发起的工具）。
 *
 * 以模型那半为主体：ID、状态、位置都取它。耗时改成**提问 → 答完** —— 这一步就是从提问那一刻起算的。
 * （模型那条响应自己的口径是「距上一条事件」，两者在常规情形下同值；差在工具记录先落盘那种情形，
 * 那时按「距上一条事件」算会把「提问到开始生成」的一段漏在行外。反过来，用户打断之后那段没被 cc
 * 记录的生成时间会因此不在任何一行里。）
 * `ts` 保持「答完的时刻」，于是 `rowSpan` 原样成立：`[ts − durationMs, ts]` = 提问 → 答完，
 * 正是这一步占的那一段（时间栏、waterfall、选区都读它这一份定义）。
 */
function mergedUserRow(user: LogRow, llm: LogRow): LogRow {
  return {
    ...llm,
    durationMs: llm.ts - user.ts,
    action: `${user.action} + ${llm.action}`,
    mergedWith: 'user',
    // 两半各自成组（与「模型响应 / 工具名」同一套渲染）：展开后一眼分得清哪块是问、哪块是答
    panels: [
      ...user.panels.map((p) => ({ ...p, group: user.action })),
      ...llm.panels.map((p) => ({ ...p, group: GROUP_LLM })),
    ],
  }
}

/**
 * 把「发起了一个工具的模型响应」与它发起的那**一个**工具并成一行 —— 一步「想 + 做」。
 *
 * 一轮的**第一条**响应不吃这条：它已经与提问并成开场那一对，它发起的工具因此单独一行
 * （那一步的问与答已经交代完了，工具执行是接下来的一件事）。
 *
 * 配对按 `leadId`（发起它的那条响应的 uuid）而不是相邻两行：cc 会先落盘工具记录、后落盘那条
 * 消息的收尾记录，工具行于是可能排在它的响应行**前面**（本机实测这类轮次约占一成）。
 * 位置取两行里靠前的那个，让数组尽量还按时序。
 */
function mergeToolRows(rows: LogRow[]): LogRow[] {
  const toolAt = new Map<string, number>()
  rows.forEach((r, i) => {
    if (r.leadId === null || r.kind === 'wait' || toolAt.has(r.leadId)) return
    toolAt.set(r.leadId, i)
  })

  const merged = new Map<number, LogRow>()
  const absorbed = new Set<number>()
  rows.forEach((r, i) => {
    if (r.kind !== 'llm' || r.mergedWith !== null || r.invokedTools.length !== 1) return
    const toolIdx = toolAt.get(r.fullId)
    if (toolIdx === undefined) return
    merged.set(Math.min(i, toolIdx), mergedToolRow(r, rows[toolIdx]))
    absorbed.add(Math.max(i, toolIdx))
  })
  return rows.flatMap((r, i) => (absorbed.has(i) ? [] : [merged.get(i) ?? r]))
}

/** 一步「想 + 做」 = 模型那半（token / 思考 / 正文）+ 工具那半（请求 / 响应 / 运行情况）。 */
function mergedToolRow(llm: LogRow, tool: LogRow): LogRow {
  const thinkMs = llm.durationMs
  // 这一步占的那一段 = 模型那半的区间 ∪ 工具那半的区间。两段在常规情形下首尾相接（工具在消息写完
  // 那一刻开跑），相加即并集；工具记录先落盘那种情形下两者会重叠，取并集才不会把同一秒算两遍。
  const start = Math.min(llm.ts - thinkMs, tool.ts)
  const end = Math.max(llm.ts, tool.ts + tool.durationMs)
  return {
    // 以工具那半为主体：ID 可定位、状态是工具的成败、运行情况面板也在它身上
    ...tool,
    ts: start,
    // token 账取模型那半（工具那半本来没有）：这一步的「想」用了多少 token 是这一步的属性 ——
    // 与耗时已经含模型那半同一个道理。委派行也一样：它整块的账在子 agent 列表里，那是另一回事。
    tokens: llm.tokens,
    durationMs: Math.max(0, end - start),
    action: `${TOOL_USE_LABEL} + ${tool.action}`,
    turn: llm.turn,
    mergedWith: 'tool',
    // 委派行不给模型那半的面板（模型只是把活交出去，思考/输出的账在子 agent 的列表里）；
    // 也不分组 —— 只剩一组时那个组名是多余的
    panels:
      tool.kind === 'subagent'
        ? tool.panels
        : [
            ...llm.panels.map((p) => ({ ...p, group: GROUP_LLM })),
            ...tool.panels.map((p) => ({ ...p, group: tool.action })),
          ],
  }
}


/** cc 自报的轮耗时与本地记录就对到多近算同一轮（该事件紧跟轮内最后一条 assistant 之后几十毫秒）。 */
const RECONCILE_TOLERANCE_MS = 5_000

/** 差值超过多少才在面板上标「值得看」：口径本身有几秒级的抖动（事件自身发出的延迟）。 */
const RECONCILE_NOTABLE_MS = 30_000

/**
 * 把 cc 自报的每轮耗时挂到该轮第一条记录的展开面板里，跟本地记录之和并列。
 *
 * 为什么值得对账：本地的分解全是推导出来的（LLM 行 = 距上一条事件的间隔，工具行 = 实测配对），
 * 而 `turn_duration` 是 cc 自己记的第三方数字。两者对不上就说明本地有没解释的时间。
 *
 * 匹配按**时刻就近**而不是按顺序：这个事件不是每轮都发（本机抽 40 个会话，37 个条数与轮数不等），
 * 顺序对齐会整体错位。对不上的轮不显示面板，所以有面板的轮才是可信的对账。
 */
function attachTurnReconciliation(rows: LogRow[], session: Session): void {
  if (session.systemTurnDurations.length === 0) return

  const byTurn = new Map<number, LogRow[]>()
  for (const row of rows) {
    if (row.turn === null) continue
    const list = byTurn.get(row.turn)
    if (list) list.push(row)
    else byTurn.set(row.turn, [row])
  }

  const taken = new Set<number>()
  for (const [turn, list] of byTurn) {
    // 轮的结束时刻：模型行的 ts 就是它生成完的时刻（其 durationMs 是**之前**的等待，不能加）；
    // 工具/等待行才要加上自身时长。
    const endTs = Math.max(...list.map((r) => (r.kind === 'llm' ? r.ts : r.ts + r.durationMs)))
    let best = -1
    let bestGap = RECONCILE_TOLERANCE_MS
    session.systemTurnDurations.forEach((td, i) => {
      if (taken.has(i)) return
      // cc 只会在该轮结束**之后**发这条事件，配到轮结束之前的一定是配错了轮
      if (td.ts < endTs - RECONCILE_TOLERANCE_MS) return
      const gap = Math.abs(td.ts - endTs)
      if (gap <= bestGap) {
        bestGap = gap
        best = i
      }
    })
    if (best < 0) continue
    taken.add(best)
    // 挂在该轮**第一条工作记录**上，不是轮首那条提问行：对账是「这一轮花了多久」的账，
    // 属于模型/工具那几条，不属于「我问了什么」。整轮只有提问行时就没有可挂的地方。
    const host = list.find((r) => r.kind !== 'user')
    if (host) host.panels.push(reconcilePanel(turn, list, session.systemTurnDurations[best]))
  }
}

function reconcilePanel(turn: number, list: LogRow[], td: TurnDuration): LogPanel {
  const waits = list.filter((r) => r.kind === 'wait')
  const localWait = waits.reduce((a, r) => a + r.durationMs, 0)
  // 本地这一轮覆盖了多长的墙上时间。两道口径缺一不可：
  //   合并区间而不是求和 —— 并行的工具/子 agent 区间重叠，求和会把同一秒算几遍
  //     （本机实测某轮求和 1h17m38s 而并集只有 32m13s）；
  //   再减掉等待区间 —— cc 的 turn_duration 把轮内 AskUserQuestion 的**整段**排除了，连
  //     等待期间还在跑的工具也一并排除（本机逐轮验证：轮跨度 − cc自报 ≡ AskUserQuestion 时长）。
  const waitSpans = waits.map(rowSpan)
  const active = list.filter((r) => r.kind !== 'wait').map(rowSpan)
  const kept = active.flatMap((iv) =>
    waitSpans.reduce<Interval[]>((segs, w) => segs.flatMap((s) => subtractInterval(s, w)), [iv]),
  )
  const localWall = unionDuration(kept)
  const diff = localWall - td.durationMs
  return {
    label: '本轮对账 · cc 自报',
    meta: `第 ${turn + 1} 轮`,
    body: [
      `cc 自报      ${fmtMs(td.durationMs)}`,
      `本地覆盖     ${fmtMs(localWall)}（该轮活动区间并集，并行重叠只算一次）`,
      `轮内等用户   ${fmtMs(localWait)}（AskUserQuestion，两边都不算它）`,
      `差值         ${fmtMs(diff)}${Math.abs(diff) > RECONCILE_NOTABLE_MS ? ' ← 两边对不上，这一轮值得看' : ''}`,
      `记录条数     ${list.length}（其中等待 ${waits.length} 条）`,
    ].join('\n'),
  }
}

/**
 * 一行在时间轴上占的区间：模型行是「生成完的时刻往前推 durationMs」，其余是「本行时刻起这么长」。
 *
 * 导出是因为**这是全仓唯一一份「一行占哪一段时间」的定义** —— 时间标尺、时间栏的位置与宽度、
 * waterfall 的条、时间选区的相交判定全都读它。视图层不许再手写一遍区间，否则四处的横轴会各自漂移。
 */
export function rowSpan(r: LogRow): Interval {
  return r.kind === 'llm' ? { start: r.ts - r.durationMs, end: r.ts } : { start: r.ts, end: r.ts + r.durationMs }
}

/**
 * 时间栏上的一块：位置与宽度都已归一化到 0~1，视图层只需乘容器宽度。
 *
 * 不在这里塞像素：容器多宽是渲染层的事，core 只回答「在整段时长的哪个位置、占多少」。
 * 最小可见宽度也归视图层 —— 一个 88ms 的记录在 2 小时的会话里宽度是 0.001%，那是真实的，
 * 渲染层给它一个最小像素宽只是为了点得到。
 */
export interface TimelineBlock {
  /** 点击后要跳到的日志行（= `LogRow.fullId`） */
  id: string
  start: number
  width: number
  /**
   * 耗时轻重，0~1（本会话里最长的那条 = 1）。
   *
   * 为什么不能只靠 `width`：上千条记录摊在容器宽度里，88ms 与 30min 的宽度都是几个像素 ——
   * 宽度这个维度早就用尽了。要靠高度（波形图那样）才看得出「哪几段最耗时」。
   */
  intensity: number
  color: string
  /** 悬停提示：时刻 · 类型 · 耗时 · 动作 */
  label: string
  /**
   * 落在时间选区之外。
   *
   * 仍然画在原位（全景不能被选区吃掉），只是变暗、不可点 —— 它对应的行已被选区筛掉、
   * 不在 DOM 里，可直接点击会静默无反应，比不可点更糟。
   */
  dimmed: boolean
}

/**
 * 时间轴标尺：`lo` = 最早一条记录的起点，`total` = 全跨度，`maxDurationMs` = 最长那条的耗时。
 *
 * 三个字段一起打包，因为它必须是**同一把尺**：时间栏的位置、waterfall 的条、块的高度全都读它。
 * `maxDurationMs` 是强度（对数高度）的分母，锚在**全部行**上 —— 若按当前筛选的那批算，
 * 筛到只剩短记录时每条都变成满高，「哪段最耗时」当场失效（旧实现的隐患，本次一并修掉）。
 */
export interface TimeAxis {
  lo: number
  total: number
  maxDurationMs: number
}

/**
 * 从一批行算标尺。
 *
 * 空数组也要给出安全值：`buildTimeline(rows, axis = timeAxisOf(rows))` 的默认参数在
 * rows 为空时**照样会被求值**，函数体里的早退保不住它（`Math.min(...[])` 是 `Infinity`）。
 */
export function timeAxisOf(rows: readonly LogRow[]): TimeAxis {
  if (rows.length === 0) return { lo: 0, total: 1, maxDurationMs: 1 }
  const spans = rows.map(rowSpan)
  const lo = Math.min(...spans.map((s) => s.start))
  const hi = Math.max(...spans.map((s) => s.end))
  return {
    lo,
    // 全部记录同刻（或耗时为 0）时分母会归零 → 退回 1ms，位置全落 0 而不是 NaN
    total: Math.max(1, hi - lo),
    maxDurationMs: Math.max(1, ...rows.map((r) => r.durationMs)),
  }
}

/** 绝对时刻 → 0~1（越界 clamp 到轴内）。 */
export function axisPos(axis: TimeAxis, ts: number): number {
  return clamp01((ts - axis.lo) / axis.total)
}

/**
 * 放大到选区的标尺：有选区就只画选区那一段，没有就整条时间轴。
 *
 * waterfall 列用它：2 小时的会话里选 30 秒，若仍按整段定位，留下的十几条会挤成几个像素。
 * 吃 `TimeAxis` 而不是 rows —— 每次渲染只为取 `maxDurationMs` 再扫一遍一千多行是白费。
 */
export function axisForWindow(axis: TimeAxis, w: ViewWindow | null): TimeAxis {
  if (w === null) return axis
  const total = w.end - w.start
  return total > 0 ? { lo: w.start, total, maxDurationMs: axis.maxDurationMs } : axis
}

/**
 * 记录与时间选区是否有交集（**双闭**：端点上的记录算在内）。
 *
 * 双闭不是为了宽容，而是**吸附的前提**：能吸附的边界就是记录的起止时刻，而用户提问那类
 * 零耗时的行，它的边界正是它自己的时刻 —— 半开区间会把刚吸附上来的那条记录自己排除掉。
 * 零耗时行在双闭下恰好退化成「点落在区间内」，不需要额外分支。
 */
export function intersectsWindow(span: Interval, w: ViewWindow | null): boolean {
  if (w === null) return true
  return span.start <= w.end && span.end >= w.start
}

/** 时间选区松手吸附的候选边界：所有记录的起止时刻，升序去重。 */
export function logBoundaries(rows: readonly LogRow[]): number[] {
  const all = new Set<number>()
  for (const row of rows) {
    const s = rowSpan(row)
    all.add(s.start)
    all.add(s.end)
  }
  return [...all].sort((a, b) => a - b)
}

/**
 * 会话时间轴上的概览：把每条记录按「时刻定位、耗时定宽、耗时轻重定高」摊成一块。
 *
 * 传进来的行必须是**按时刻排的**（`sortLogRows(rows, 'normal')` 那一份）：位置取自 `ts`，
 * 而这套坐标只对时间序成立（见 `DurationSortOption.keepsTimeline`）。
 *
 * `axis` 由调用方给，且**必须取自全部行**而不是这批行：轴一随筛选变，块就会在你敲搜索词时
 * 整条横移，选区框也失去参照。默认值只是为了兼容「就这几行、轴自然就是它」的调用。
 * `window` 只决定 `dimmed`，不影响位置 —— 有选区时块集排除选区（见视图层），
 * 但被排除的邻域仍需显示在正确的时刻上。
 */
export function buildTimeline(
  rows: readonly LogRow[],
  axis: TimeAxis = timeAxisOf(rows),
  window: ViewWindow | null = null,
): TimelineBlock[] {
  if (rows.length === 0) return []
  // 对数刻度：耗时跨四个数量级（88ms → 1h），线性会让短的全压成 0，看着像没有活动
  const denom = Math.log10(1 + axis.maxDurationMs)
  return rows.map((row) => {
    const span = rowSpan(row)
    const style = LOG_KIND_STYLE[row.kind]
    const start = axisPos(axis, span.start)
    return {
      id: row.fullId,
      start,
      width: Math.max(0, axisPos(axis, span.end) - start),
      intensity: clamp01(Math.log10(1 + Math.max(0, row.durationMs)) / denom),
      color: style.color,
      // 类型走 kindLabelOf：悬停说「LLM」而徽章写「用户+LLM」是同一行两套话
      label: `${fmtClock(row.ts)} · ${kindLabelOf(row)} · ${fmtDuration(row.durationMs)} · ${row.action}`,
      dimmed: window !== null && !intersectsWindow(span, window),
    }
  })
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

/**
 * 逐行走一遍时间游标，补上「距上一条事件多久」（只有模型行与等用户行需要）。
 * 游标只前进不后退：并行的工具调用（同时开始）不会把后一条的耗时刻意拉长。
 */
function assignDurations(rows: LogRow[], session: Session): LogRow[] {
  // 每轮的起点＝那次用户提问的时刻
  const turnStart = new Map<number, number>()
  for (const t of session.turns) if (t.userMsg) turnStart.set(t.index, t.userMsg.ts)

  let cursor = session.startedAt ?? 0
  let first = true
  for (const row of rows) {
    if (row.kind === 'llm') {
      // 第一行没有「上一条事件」，用它所在轮的提问时刻当起点 —— **不能**用 `session.startedAt`：
      // 那是文件里所有事件（含 attachment/快照）的最早时间戳，拿它当分母会把「这个文件从什么时候
      // 开始写的」到「模型第一次回话」之间的全部时间算成模型思考（本机 35 个会话因此虚高，
      // 最大 68h）。
      if (first && row.turn !== null) {
        const start = turnStart.get(row.turn)
        if (start != null) cursor = Math.max(cursor, start)
      }
      first = false
      row.durationMs = Math.max(0, row.ts - cursor)
      cursor = Math.max(cursor, row.ts)
    } else if (row.kind === 'wait' && row.durationMs > 0) {
      // 等用户行自带区间（ts 起、durationMs 长），裁掉已被前面记录覆盖的部分
      const end = row.ts + row.durationMs
      const start = Math.max(row.ts, cursor)
      row.durationMs = Math.max(0, end - start)
      row.ts = start
      cursor = Math.max(cursor, end)
    } else if (row.durationMs > 0) {
      cursor = Math.max(cursor, row.ts + row.durationMs)
    }
  }
  return rows
}

/**
 * 用户提问行：一轮的起点。操作列说的是**这条记录实际是什么**：cc 写的打断标记写「用户打断」，
 * 本地命令记录（`/compact`、`/clear`…）写命令名，只有真人打的字才写「提问」。
 *
 * 耗时恒为 0 且**不推进游标** —— 提问本身不占时间，它是标记而不是「一步」；下面第一条模型行的
 * 耗时正是从这一刻算起的（见 assignDurations）。
 */
function userRow(msg: UserMsg, turn: number): LogRow {
  const text = msg.text.trim()
  // 命令记录的摘要照旧是原文（面板里那行也一样）：`/compact`、`<local-command-stdout>…` 都是原文
  const label = msg.commandName ?? (msg.isInterrupt ? USER_INTERRUPT_LABEL : USER_ASK_LABEL)
  return {
    id: shortId(msg.uuid),
    fullId: msg.uuid,
    kind: 'user',
    ts: msg.ts,
    action: label,
    summary: compact(text, SUMMARY_MAX),
    status: 'na',
    tokens: null,
    durationMs: 0,
    turn,
    invokedTools: [],
    leadId: null,
    mergedWith: null,
    panels: [{ label, body: text }],
  }
}

/**
 * 上游 API 错误行的摘要抬头：`API Error (<归类> <HTTP 码>)`。
 *
 * 归类缺失或长到不像归类名 → 兜底「未知」；HTTP 码缺失就只写归类 —— 缺的东西不拿 `unknown` / `0`
 * 这种像读数的占位去填（同 `tokensOf` 对空 token 账的处理）。
 */
function apiErrorHead(err: ApiError): string {
  const kind = err.kind !== null && err.kind.length <= API_ERROR_KIND_MAX_LEN ? err.kind : API_ERROR_KIND_FALLBACK
  const parts = err.status === null ? [kind] : [kind, String(err.status)]
  return `${API_ERROR_LABEL} (${parts.join(' ')})`
}

/**
 * 错误正文去掉与抬头重复的部分，留下真正的错误说明（展开面板里仍是原文，一字未动）。
 *
 * HTTP 码只在抬头已经写了时才跟着剥：`apiErrorStatus` 缺失的那 17 条（响应超限 7 条 + 连不上 / 超时 /
 * 连接中断 10 条）正文里就算写了码，那也是唯一的一份，剥了就真没了。
 */
function apiErrorBody(err: ApiError, raw: string): string {
  const rest = raw.replace(API_ERROR_TEXT_PREFIX, '')
  return err.status === null ? rest : rest.replace(API_ERROR_STATUS_PREFIX, '')
}

function llmRow(msg: AssistantMsg, turn: number): LogRow {
  const text = blocksText(msg, 'text')
  const thinking = blocksText(msg, 'thinking')
  const tokens = tokensOf(msg.usage)
  // 上游报错也是一条 assistant 记录，但它的正文就是错误说明本身（没有思考那一段）：正文里重复的
  // 抬头由 apiErrorBody 剥掉，改由 apiErrorHead 统一写成带归类的那种
  const raw = text || thinking
  const preview = compact(msg.apiError ? apiErrorBody(msg.apiError, raw) : raw, SUMMARY_MAX)
  const invokedTools = invokedToolNames(msg)
  // 发起的工具排在文本预览之前：纯 tool_use 的响应没有文本，这一项就是它唯一的「干了什么」
  const head = msg.apiError
    ? apiErrorHead(msg.apiError)
    : invokedTools.length > 0
      ? `${ARROW_INVOKE} ${invokedTools.join('、')}`
      : ''
  return {
    id: shortId(msg.uuid),
    fullId: msg.uuid,
    kind: 'llm',
    ts: msg.ts,
    action: shortModel(msg.model) || '—',
    summary: [head, preview].filter(Boolean).join(' · ') || '（无文本输出）',
    // 上游报错是「跑完了但失败」，与工具失败的 error 同一档；`isSynthetic` 只管「不是模型生成的」
    // 那半（`/compact` 摘要），不能盖过它
    status: msg.apiError ? 'error' : msg.isSynthetic ? 'na' : 'ok',
    tokens,
    durationMs: 0, // 由 assignDurations 填（= 距上一条事件的间隔）
    turn,
    invokedTools,
    leadId: null,
    mergedWith: null,
    // 没有「响应明细」那一块：这条响应的 token 账在输入/输出列上（`tokens`），
    // 结束后自不必念一遍 —— 展开一块只装了「刚才那几列已经写过」的东西，白占一列
    panels: contentPanel(thinking, text, panelTokenMeta(tokens)),
  }
}

/**
 * 模型行的 token 账。两个数都是 0 → `null`（合成出来的响应没有 usage）：
 * 与「没有模型那半的行留空」同一套写法，界面上不会出现 `0 / 0` 这种像读数、其实是没数据的东西。
 */
function tokensOf(usage: Usage): LogRowTokens | null {
  const input = usageInputTokens(usage)
  return input + usage.output > 0 ? { input, output: usage.output } : null
}

/** 表格「输入/输出」列的写法（列头写单位，格子里只写两个数）；没有模型那半的行 → 空串。 */
export function fmtRowTokens(tokens: LogRowTokens | null): string {
  return tokens ? `${fmtTokens(tokens.input)} / ${fmtTokens(tokens.output)}` : ''
}

/**
 * 展开面板的 meta 写法：`in 4.2k / out 380`。
 *
 * 与表格列写同一份数字、排版不同 —— 面板那一行是「组名 · meta · 耗时徽标」并排，
 * 光写 `4.2k / 380` 会被读成耗时（紧挨着的徽标正是 ms/s）。列头写得下单位，这里写不下。
 */
function panelTokenMeta(tokens: LogRowTokens | null): string {
  return tokens ? `in ${fmtTokens(tokens.input)} / out ${fmtTokens(tokens.output)}` : ''
}

/**
 * 模型那半的内容面板：**思考与输出是一对**（同一份响应的两段：它怎么想的 + 它说了什么），
 * 合成一块面板、各起一个小标题、**各滚各的**（见 `LogPanel.sections`）。
 *
 * 只有真实存在的那一段才写（两段都空就不出这块面板：空面板比没有更让人困惑）。
 */
function contentPanel(thinking: string, text: string, meta: string): LogPanel[] {
  const sections: LogPanelSection[] = []
  if (thinking !== '') sections.push({ title: THINKING_LABEL, body: thinking, meta: charCount(thinking.length) })
  if (text !== '') sections.push({ title: OUTPUT_LABEL, body: text, meta: charCount(text.length) })
  return sections.length === 0 ? [] : [{ label: GROUP_LLM, meta: meta || undefined, sections }]
}

function callRow(tc: ToolCall, turn: number, leadId: string | null): LogRow {
  const kind = rowKindOf(tc)
  const wall = childWallOf(tc)
  // 委派与 workflow 的耗时都取「派出去的那个东西实际跑了多久」（见 childWallOf）：
  // 父侧那条 tool_use→tool_result 对 workflow 只有几百毫秒（异步发起），拿它当运行时长差三个数量级
  const durationMs =
    kind === 'subagent' || kind === 'workflow'
      ? (wall ? wall.end - wall.start : (tc.durationMs ?? 0))
      : (tc.durationMs ?? 0)
  const status: LogRowStatus = tc.isError ? 'error' : tc.tsEnd == null ? 'na' : 'ok'
  const io = [requestPanel(tc), resultPanel(tc, status, durationMs)]
  const run = tc.workflowRun
  return {
    id: shortId(tc.toolUseId),
    fullId: tc.toolUseId,
    kind,
    ts: wall ? wall.start : tc.tsStart,
    action: toolAction(tc),
    summary: toolSummary(tc),
    status,
    // 工具自己不调模型：账在发起它的那条响应上（那条行合并时会把账带过来，见 mergedToolRow）
    tokens: null,
    durationMs,
    turn,
    invokedTools: [],
    leadId,
    mergedWith: null,
    childSession: tc.childSession,
    childSessions: tc.childSessions,
    workflowRun: run,
    // 委派行只留这两块：子 agent 自己的记录就列在它下面（`childSession`），
    // cc 自报的那几个数（耗时/token/工具次数）在那里能逐条看回来，再抄一遍只是占地方。
    // workflow 行反过来 —— 它的子 agent 就是记录本身，运行记录（状态/阶段/token/结果）别处没有，
    // 所以要给；回执那块（`Workflow launched in background…`）只在没有运行记录时才留着。
    panels:
      kind === 'subagent'
        ? io
        : run
          ? [requestPanel(tc), workflowRunPanel(run), ...workflowResultPanels(run)]
          : [...io, ...runInfoPanel(tc)],
  }
}

/**
 * 工作运行记录面板：这一跑的状态与体量。
 *
 * 只在非正常状态时才念状态（与「运行情况」面板同一条口径）；日志逐条列出来 —— workflow 脚本
 * 写进 `logs` 的就是「哪一阶段出了什么事」，那是排查一跑为什么没成时唯一想看的东西。
 */
function workflowRunPanel(run: WorkflowRun): LogPanel {
  const lines = [
    `状态 ${run.status || '未知'}${run.status === WORKFLOW_STATUS_COMPLETED ? '' : ' ← 没跑完'}`,
    `子 agent ${run.agentCount} 个`,
    run.durationMs > 0 ? `运行时长 ${fmtMs(run.durationMs)}` : '',
    run.totalTokens == null ? '' : `token ${fmtTokens(run.totalTokens)}`,
    run.totalToolCalls == null ? '' : `工具调用 ${run.totalToolCalls} 次`,
    run.phases.length > 0 ? `阶段 ${run.phases.join(' → ')}` : '',
    ...run.logs,
  ].filter(Boolean)
  return { label: RUN_INFO_LABEL, meta: run.workflowName || undefined, body: lines.join('\n') }
}

/**
 * workflow 结果面板：脚本自己写的 `result`（评审分数、判定、产物清单…）。
 *
 * 序列化成 JSON 而不是替它排版：结果长什么样完全由脚本决定（本机见过 56 字符的，也见过
 * 53080 字符的），照文本给是唯一不撒谎的呈现。
 */
function workflowResultPanels(run: WorkflowRun): LogPanel[] {
  return run.resultText === ''
    ? []
    : [{ label: WORKFLOW_RESULT_LABEL, format: 'code', body: run.resultText }]
}

/** 请求面板：这一步让工具做了什么（参数原文，缩进过的 JSON）。 */
function requestPanel(tc: ToolCall): LogPanel {
  return { label: REQUEST_LABEL, meta: tc.toolUseId, format: 'code', body: prettyJson(tc.input) }
}

/** 响应面板：工具的成败与体量。耗时单独给 `durationMs`（视图按量级着色），不塞进 meta 字符串。 */
function resultPanel(tc: ToolCall, status: LogRowStatus, durationMs: number): LogPanel {
  return {
    label: RESULT_LABEL,
    format: 'code',
    meta: [status, tc.result == null ? '' : `${charCount(tc.result.length)}${tc.resultTruncated ? '（已截断）' : ''}`]
      .filter(Boolean)
      .join(' · '),
    durationMs,
    body: tc.result == null ? '（无输出）' : tc.result + (tc.resultTruncated ? `\n${ELLIPSIS}（已截断）` : ''),
  }
}

/**
 * 运行情况面板：cc 在 `toolUseResult` 里自报的这次执行的情况（不是工具的输出内容 —— 输出在上一块）。
 *
 * 只写两类：「不正常」（中断了、撞上超时上限、走了异步）和「体量」（吐了多少、扫了多少文件）。
 * 「中断 否」「超时 无」这种把默认值念一遍的行，占着地方却没人读 —— 没有消息就是好消息。
 */
function runInfoPanel(tc: ToolCall): LogPanel[] {
  const lines = (tc.structuredResult ? runFacts(tc.structuredResult) : []).filter(Boolean)
  if (lines.length === 0) return []
  return [{ label: RUN_INFO_LABEL, meta: tc.structuredResult?.toolName ?? '', body: lines.join('\n') }]
}

/** 非默认值才算信息：正常情况返回空串，由调用方过滤掉。 */
function runFacts(sr: StructuredResult): string[] {
  switch (sr.toolName) {
    case 'Bash':
      return [
        sr.interrupted ? '已中断' : '',
        sr.timedOutAfterMs == null ? '' : `超时上限 ${fmtMs(sr.timedOutAfterMs)}`,
        sizeLine([
          ['stdout', sr.stdout.length],
          ['stderr', sr.stderr.length],
        ]),
      ]
    case 'Grep':
      return [
        sr.mode == null ? '' : `模式 ${sr.mode}`,
        `命中文件 ${sr.numFiles}${sr.numLines == null ? '' : ` · 命中行 ${sr.numLines}`}`,
        sr.totalLines == null ? '' : `扫描总行数 ${sr.totalLines}`,
      ]
    case 'Glob':
      return [
        `命中文件 ${sr.numFiles}`,
        sr.totalMatches == null ? '' : `匹配项 ${sr.totalMatches}`,
        sr.durationMs == null ? '' : `工具自报耗时 ${fmtDuration(sr.durationMs)}`,
      ]
    case 'Edit':
      return [sr.replaceAll ? '替换全部匹配' : '']
    case 'Write':
      return [sr.created ? '新建文件' : '']
    case 'Agent':
      return [
        sr.isAsync ? '异步子 agent' : '',
        sr.totalDurationMs == null ? '' : `子 agent 自报耗时 ${fmtDuration(sr.totalDurationMs)}`,
        sr.totalTokens == null ? '' : `子 agent token ${fmtTokens(sr.totalTokens)}`,
        sr.totalToolUseCount == null ? '' : `子 agent 工具调用 ${sr.totalToolUseCount} 次`,
        sr.resolvedModel == null ? '' : `实际模型 ${shortModel(sr.resolvedModel)}`,
      ]
    default:
      return []
  }
}

/** 体量行：空的那项不写（0 字符没有信息量）。 */
function sizeLine(parts: ReadonlyArray<readonly [string, number]>): string {
  return parts
    .filter(([, n]) => n > 0)
    .map(([name, n]) => `${name} ${charCount(n)}`)
    .join(' · ')
}

/** 字符数的统一写法（响应长度、两个流的长度都用它，免得一处 KB 一处字符）。 */
function charCount(n: number): string {
  return `${fmtTokens(n)} 字符`
}

function gapRow(iv: { start: number; end: number }, n: number): LogRow {
  return {
    id: `gap#${n}`,
    fullId: `gap#${n}`,
    kind: 'wait',
    ts: iv.start,
    action: '—',
    summary: '等待用户输入（轮间间隙）',
    status: 'na',
    tokens: null, // 等人，没有模型那半
    durationMs: iv.end - iv.start,
    turn: null, // 轮间间隙不属于任何一轮（它是两轮之间的那段）
    invokedTools: [],
    leadId: null,
    mergedWith: null,
    panels: [
      {
        label: '等待区间',
        meta: `${fmtClock(iv.start)} → ${fmtClock(iv.end)}`,
        body: '轮间间隙：上一条活动结束 → 下一条用户输入',
      },
    ],
  }
}

/**
 * 类别 → 日志行类型：委派与 workflow 各单列（委派是「一次调用背后有一整个会话」，workflow 是
 * 「一次调用背后有一整套会话」），等用户只认 AskUserQuestion。
 */
function rowKindOf(tc: ToolCall): LogRowKind {
  const k = classifyTool(tc.name)
  if (k === 'delegated') return 'subagent'
  if (k === 'workflow') return 'workflow'
  return k === 'wait-user' ? 'wait' : 'tool'
}

/** 操作列：委派带上 agent 类型（Agent · explore），workflow 带上流程名，其余用工具名。 */
function toolAction(tc: ToolCall): string {
  const sr = tc.structuredResult
  if (sr?.toolName === 'Agent' && sr.agentType) return `${tc.name} · ${sr.agentType}`
  const wf = tc.workflowRun?.workflowName
  if (wf) return `${tc.name} · ${wf}`
  return tc.name
}

/**
 * 摘要列：这一条在干什么（命令 / 文件路径 / 搜索词 / 提问），取不到就给输入的首个短字符串。
 * 优先结构化结果（那是解析器已经认出来的字段），再退回原始输入。
 */
function toolSummary(tc: ToolCall): string {
  const sr = tc.structuredResult
  const input = tc.input
  const candidates: unknown[] = []
  switch (sr?.toolName) {
    case 'Read':
    case 'Write':
    case 'Edit':
      candidates.push(sr.filePath)
      break
    case 'Bash':
      candidates.push(input.command)
      break
    case 'Grep':
    case 'Glob':
      candidates.push(input.pattern)
      break
    case 'Agent':
      candidates.push(sr.description, input.description)
      break
    case 'Workflow':
      // 摘要优先用流程自己的说明（脚本 meta.description）—— 它比脚本路径有用得多；
      // 没有运行记录时退回脚本路径，至少说得出「跑的是哪个脚本」
      candidates.push(tc.workflowRun?.summary, sr.scriptPath, input.scriptPath)
      break
  }
  candidates.push(input.command, input.file_path, input.filePath, input.pattern, input.description, input.prompt)
  candidates.push(firstQuestion(input.questions))
  for (const c of candidates) {
    const s = compact(typeof c === 'string' ? c : '', SUMMARY_MAX)
    if (s) return s
  }
  return compact(firstStringValue(input), SUMMARY_MAX) || '—'
}

function firstQuestion(questions: unknown): string {
  if (!Array.isArray(questions)) return ''
  const q = questions[0]
  if (!q || typeof q !== 'object') return ''
  const text = (q as Record<string, unknown>).question
  return typeof text === 'string' ? text : ''
}

/** 输入里第一个非空字符串值（工具名不认识时的兜底，总比一行空白强）。 */
function firstStringValue(input: Record<string, unknown>): string {
  for (const v of Object.values(input)) if (typeof v === 'string' && v.trim()) return v
  return ''
}

/** 本条响应里的 tool_use 块（按出现顺序）。空数组 = 没发起工具（纯文本回复或合成消息）。 */
function toolUseBlocks(msg: AssistantMsg): Extract<ContentBlock, { type: 'tool_use' }>[] {
  return msg.blocks.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
}

function invokedToolNames(msg: AssistantMsg): string[] {
  return toolUseBlocks(msg).map((b) => b.name)
}

/** 本条响应发起的工具 id：用它把响应行与解析器配对出来的工具调用对上（同一份块的两种视图）。 */
function invokedToolIds(msg: AssistantMsg): string[] {
  return toolUseBlocks(msg).map((b) => b.id)
}

function blocksText(msg: AssistantMsg, type: 'text' | 'thinking'): string {
  return msg.blocks
    .filter((b): b is Extract<typeof b, { type: typeof type }> => b.type === type)
    .map((b) => b.text)
    .join('\n\n')
    .trim()
}

function prettyJson(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return '（无法序列化）'
  }
}

/** 单行化 + 截断：摘要是表格里的一个单元格，换行会把行高撑破。 */
function compact(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max) + ELLIPSIS : one
}

function shortId(id: string): string {
  return id.length > SHORT_ID_LEN ? id.slice(0, SHORT_ID_LEN) : id
}

/** 汇总条：直接复用分解模型（与树视图/报告同源，不存在第二套口径）。 */
export function logSummary(session: Session): LogSummary {
  return breakdownOf(session)
}

/** 耗时筛选的比较方式（UI 那个下拉的三个选项） */
export type DurationOp = 'gt' | 'lt' | 'between'

/**
 * 耗时筛选的输入：操作符 + 两个文本框（原样字符串）+ 单位。
 *
 * 两个框在三种模式下的含义：`gt` / `lt` 只用 `a`（单框），`between` 用 `a`（下限）与 `b`（上限）。
 * 「低于」阈值也放在 `a` 而不是 `maxText`，是为了让「唯一那个阈值」始终待在同一个字段里 ——
 * 切到区间时它才有确定的位置（见 `withDurationOp`）。
 */
export interface DurationQuery {
  op: DurationOp
  a: string
  b: string
  unit: DurationScale
}

export const EMPTY_DURATION_QUERY: DurationQuery = { op: 'gt', a: '', b: '', unit: 's' }

/** 归一化后的耗时边界（毫秒）；null = 该侧不限。 */
export interface DurationBounds {
  minMs: number | null
  maxMs: number | null
}

export const NO_DURATION_BOUNDS: DurationBounds = { minMs: null, maxMs: null }

/**
 * 文本 → 毫秒。空串/非数字/负数一律当「没填」（返回 null）：
 * 筛选框没有提交按钮，敲到一半就必然存在非法值，报错比忽略更烦人。
 */
function parseThreshold(text: string, unit: DurationScale): number | null {
  const raw = text.trim()
  if (!raw) return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return null
  return n * unitToMs(unit)
}

/**
 * 换成毫秒边界（含边界：高于 2s 含整整 2.00s 那条 —— 阈值是整数，排除它只会让人怀疑「为什么差一条」）。
 * 区间写反了自动对调（1.5～60 与 60～1.5 是同一个意思，不值得为此报错）。
 */
export function durationBounds(q: DurationQuery): DurationBounds {
  if (q.op === 'gt') return { minMs: parseThreshold(q.a, q.unit), maxMs: null }
  if (q.op === 'lt') return { minMs: null, maxMs: parseThreshold(q.a, q.unit) }
  const lo = parseThreshold(q.a, q.unit)
  const hi = parseThreshold(q.b, q.unit)
  if (lo != null && hi != null) return lo <= hi ? { minMs: lo, maxMs: hi } : { minMs: hi, maxMs: lo }
  return { minMs: lo, maxMs: hi }
}

/**
 * 切换操作符时把已填的阈值搬到对应字段，**保持它原来的意思**：
 *  - 低于 → 区间：60 是上限，所以落到 `b`（下限留空 = 不限）
 *  - 区间 → 低于：取上限（`b`）继续当那个唯一阈值
 *  - 其余情况（高于 ⇄ 区间、低于 ⇄ 高于）`a` 本来就是唯一阈值，不动
 * 不搬的话，「低于 60」切成区间会变成「高于 60」—— 同一个数字换了意思，是最容易让人误判列表的一类错。
 */
export function withDurationOp(q: DurationQuery, op: DurationOp): DurationQuery {
  if (op === q.op) return q
  if (op === 'between') return q.op === 'lt' ? { ...q, op, a: '', b: q.a } : { ...q, op }
  if (op === 'lt') return { ...q, op, a: q.op === 'between' ? q.b : q.a, b: q.b }
  // 高于：`a` 本来就是那个阈值（区间时它是下限），原样留下
  return { ...q, op }
}

/**
 * 筛选条件。
 *
 * 类型与状态都是**集合**，两维共用一个语义：**空集 = 不按这一维过滤**。
 * 于是没有「全部」这个取值，也就没有「选了全部等于没选」这种要额外解释的状态 ——
 * 「全选」自然退化成不过滤，不必再写一个分支。
 */
export interface LogFilter {
  /** 选中的类型；空 = 不限 */
  kinds: LogRowKind[]
  /** 选中的状态；空 = 不限 */
  statuses: LogRowStatus[]
  query: string
  /** 耗时区间（含边界）；两侧都可为 null = 不限 */
  duration: DurationBounds
  /** 时间选区（在时间栏上拉出来的那一段）；null = 不限 */
  window: ViewWindow | null
}

export const EMPTY_LOG_FILTER: LogFilter = {
  kinds: [],
  statuses: [],
  query: '',
  duration: NO_DURATION_BOUNDS,
  window: null,
}

/**
 * 筛选：类型多选 + 状态多选 + 关键词（记录 ID / 操作 / 摘要，不分大小写）+ 耗时区间 + 时间选区。
 *
 * 时间选区是**一条普通筛选条件**（不是视图装饰）：表格、行数、导出都跟着它走，
 * 于是「导出即所见」这条对导出也成立。判定用 `intersectsWindow`（双闭，端点算在内）。
 */
export function filterLogRows(rows: readonly LogRow[], filter: LogFilter): LogRow[] {
  const q = filter.query.trim().toLowerCase()
  const { minMs, maxMs } = filter.duration
  return rows.filter((r) => {
    if (filter.kinds.length > 0 && !filter.kinds.includes(r.kind)) return false
    if (filter.statuses.length > 0 && !filter.statuses.includes(r.status)) return false
    if (minMs != null && r.durationMs < minMs) return false
    if (maxMs != null && r.durationMs > maxMs) return false
    if (!intersectsWindow(rowSpan(r), filter.window)) return false
    if (!q) return true
    return (
      r.id.toLowerCase().includes(q) ||
      r.fullId.toLowerCase().includes(q) ||
      r.action.toLowerCase().includes(q) ||
      r.summary.toLowerCase().includes(q) ||
      // token 账另占一列后也要能被搜到：`4.2k` 直接查不出来会很意外（它明明就在表上）
      fmtRowTokens(r.tokens).toLowerCase().includes(q)
    )
  })
}

/** 耗时列的排序档位：原序（时序）/ 大到小 / 小到大 */
export type DurationSort = 'normal' | 'desc' | 'asc'

export interface DurationSortOption {
  value: DurationSort
  /** 表头与提示文案里的名字 */
  label: string
  /** 表头上的方向指示：↕ 未排序 · ↓ 大到小 · ↑ 小到大 */
  indicator: string
  /**
   * 这一档下时间栏还成不成立。
   *
   * 时间栏的横轴是**钟表时刻**（位置＝几点、宽度＝多久）。按耗时重排之后，「排在第一位的」
   * 不再是最早发生的那条，横轴与那些块再也对不上 —— 把它们按名次重新摆开画出来的是另一张图
   * （耗时分布），却还穿着时间轴的外衣。所以排序生效时时间栏不显示，视图只留一行说明。
   */
  keepsTimeline: boolean
}

/**
 * 三个档位的唯一定义：表头文字、指示箭头、切换顺序、时间栏判据都读它，
 * 免得「按钮上写着倒序、实际排成原序」这类两处各写一份的错。
 */
export const DURATION_SORTS: DurationSortOption[] = [
  { value: 'normal', label: '正常', indicator: '↕', keepsTimeline: true },
  { value: 'desc', label: '倒序', indicator: '↓', keepsTimeline: false },
  { value: 'asc', label: '正序', indicator: '↑', keepsTimeline: false },
]

/** 档位定义；查不到就回退首项（原序）—— 宁可少排一次，不可显示成另一档。 */
export function durationSortOption(sort: DurationSort): DurationSortOption {
  return DURATION_SORTS.find((o) => o.value === sort) ?? DURATION_SORTS[0]
}

/** 点一下表头切到下一档：正常 → 倒序 → 正序 → 正常。 */
export function nextDurationSort(sort: DurationSort): DurationSort {
  const i = DURATION_SORTS.findIndex((o) => o.value === sort)
  return DURATION_SORTS[(i + 1) % DURATION_SORTS.length].value
}

/**
 * 按耗时重排。`normal` 原样返回（连引用都不换，视图的 memo 因此不必重建）。
 * 耗时相同的行保持原有先后：`Array.prototype.sort` 自 ES2019 起保证稳定，
 * 于是「同样慢的两条」仍然按发生的先后读。
 */
export function sortLogRows(rows: readonly LogRow[], sort: DurationSort): readonly LogRow[] {
  if (sort === 'normal') return rows
  const dir = sort === 'desc' ? -1 : 1
  return [...rows].sort((a, b) => dir * (a.durationMs - b.durationMs))
}

/** 状态标签：筛选 chip 与交给 claude 的记录表共用一份，两边不会一个写「成功」一个写 `ok`。 */
export const LOG_STATUS_LABEL: Record<LogRowStatus, string> = {
  ok: '成功',
  error: '失败',
  na: '未跑完',
}

/**
 * 筛选条件的人话说明：筛选栏的「分析范围」提示与 digest 头部共用**同一句**。
 *
 * 为什么要有它：报告是对着**筛出来的一批**下的结论，读的人必须能一眼看出模型看的是哪一批。
 * 它同时是「筛选已变化，建议重新生成」的判据 —— 两处比的是同一个字符串，不会各判各的。
 */
export function describeLogFilter(filter: LogFilter): string {
  const parts: string[] = []
  if (filter.kinds.length) parts.push(`类型=${filter.kinds.map((k) => LOG_KIND_STYLE[k].label).join(',')}`)
  if (filter.statuses.length) parts.push(`状态=${filter.statuses.map((s) => LOG_STATUS_LABEL[s]).join(',')}`)
  // 耗时两侧都可为 null（= 不限）；写出来的阈值与筛选框里填的单位同源（都从 ms 反向格式化）
  if (filter.duration.minMs != null) parts.push(`耗时≥${fmtDuration(filter.duration.minMs)}`)
  if (filter.duration.maxMs != null) parts.push(`耗时≤${fmtDuration(filter.duration.maxMs)}`)
  // 换行压成空格：这句会被原样拼进 digest 的 `- 筛选条件：` 行，带着换行就把那一行拆成两行。
  // `<input type=text>` 本身吃 CR/LF（UI 上到不了这里），但这是 core 的入口，不该指望调用方
  const q = filter.query.replace(/[\r\n]+/g, ' ').trim()
  if (q) parts.push(`关键词「${q}」`)
  if (filter.window) {
    parts.push(`时间选区 ${fmtClock(filter.window.start)}~${fmtClock(filter.window.end)}`)
  }
  return parts.length > 0 ? parts.join('；') : UNFILTERED_LABEL
}

/** 一条筛选都没设时 `describeLogFilter` 的返回值：它是「没筛」这件事本身，不是空串 */
export const UNFILTERED_LABEL = '未筛选（全部记录）'

/**
 * 一批记录覆盖的绝对时间范围（`MM-DD HH:mm ~ MM-DD HH:mm`），给报告那行「覆盖哪段时间」用。
 *
 * 取的是**这批行**的首尾，不是会话首尾：2 小时会话里拉 30 秒选区是最常见的操作，
 * 报会话首尾会得到一句与事实相反的话。结束时刻按「开始 + 耗时」算 —— 一条跑了 5 分钟的
 * 记录在 10:00 开始，它覆盖到 10:05。
 *
 * 放在 core 而不是视图里：它是个纯函数，而视图那一层没有测试基建，算错了没人拦得住。
 */
export function logSpanLabel(rows: readonly LogRow[]): string {
  if (rows.length === 0) return '(无记录)'
  let lo = Infinity
  let hi = -Infinity
  for (const r of rows) {
    if (r.ts < lo) lo = r.ts
    const end = r.ts + r.durationMs
    if (end > hi) hi = end
  }
  return `${fmtTs(lo)} ~ ${fmtTs(hi)}`
}

/** usage 里「进去多少」的口径：非缓存输入 + 缓存写入 + 缓存读取（= 模型实际读到的上下文量）。 */
function usageInputTokens(usage: Usage): number {
  return usage.input + usage.cacheCreation + usage.cacheRead
}
