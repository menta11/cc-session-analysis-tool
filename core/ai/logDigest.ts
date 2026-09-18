import { kindLabelOf, LOG_STATUS_LABEL, type LogRow, type LogSummary } from '../view/logView'
import { fmtClock, fmtDuration, fmtMs, fmtTokens } from '../view/format'
import { breakdownLines } from './prompt'

/**
 * 日志视图交给分析的「所见」：**筛选后**的行 + 这份所见是怎么来的。
 *
 * 为什么把说明与行放在一起而不是各传各的：三者是同一时刻的快照，分开传迟早会出现
 * 「行按新筛选、说明还是旧筛选」—— 报告写着「筛选=error」而表里全是 ok，读的人无从解释。
 * 同一个对象一次交出，两者必然同源。
 */
export interface LogScope {
  /** 筛选后的行，已按当前排序（给模型的就是屏幕上从上到下那个顺序） */
  rows: readonly LogRow[]
  /** 筛选前的总条数（「全量 N → 本次 M」用） */
  total: number
  /** 筛选条件的人话说明（`describeLogFilter` 产出） */
  filterLabel: string
  /** 当前排序说明；空串 = 原始时序（既不声明排序，就不该印一个「正常」让人猜是什么意思） */
  sortLabel: string
  /**
   * **这批记录**覆盖的绝对时间范围（`MM-DD HH:mm ~ MM-DD HH:mm`），取自筛选后的行，不是会话首尾。
   * 行里只有时刻，跨天会话光看时刻读不出是哪天；而模板让模型写的是「这批记录覆盖哪段时间」，
   * 拿会话首尾冒充会让「2 小时会话里选 30 秒」这种最常见的操作得到一句与事实相反的话。
   */
  spanLabel: string
}

/** 记录表列宽的兜底：摘要本就很短，这里只防某条异常长的输入把整个提示词撑爆 */
const MAX_CELL_CHARS = 200

/**
 * 记录表最多给模型多少行。
 *
 * 300 行 ≈ 12k token，与树视图 digest（时序分桶 + 子 agent 全量表）同量级；
 * 超出的部分**不静默丢**：按耗时降序取前 N 并在表头写明被截掉多少条 ——
 * 「我筛出来的 412 条」与「模型看到的 300 条」是两件事，不说清就等于让模型对着残缺数据下结论。
 *
 * 导出给视图用：面板得把同一件事告诉用户，否则只有模型知道数据被截过。
 */
export const MAX_DIGEST_ROWS = 300

/**
 * 表格单元格：`|` 与换行会把 markdown 表格切碎，必须转义（摘要里是 bash 命令，带竖线是常态）。
 *
 * **反斜杠必须先转**：转义后的 `\|` 本身就是个反斜杠 + 竖线，若先转竖线再转反斜杠，
 * 原本就带反斜杠的 `a\|b`（bash 的「或」写法，极常见）会变成 `a\\|b` —— 转义被自己抵消，
 * 竖线仍然生效，那一行当场多切一列。
 */
function cell(text: string): string {
  const flat = text
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/[\r\n]+/g, ' ')
  return flat.length > MAX_CELL_CHARS ? `${flat.slice(0, MAX_CELL_CHARS)}…` : flat
}

/** 某行在表里的耗时写法：与界面的耗时列同一把尺（单条记录的量级，非总耗时） */
function rowDuration(row: LogRow): string {
  return fmtDuration(row.durationMs)
}

/** 筛选后的类型分布：条数 + 耗时合计（让模型不必自己数表，也给出「哪类占了大头」） */
function kindDistribution(rows: readonly LogRow[]): { label: string; count: number; ms: number }[] {
  const acc = new Map<string, { count: number; ms: number }>()
  for (const r of rows) {
    const label = kindLabelOf(r)
    const cur = acc.get(label) ?? { count: 0, ms: 0 }
    acc.set(label, { count: cur.count + 1, ms: cur.ms + r.durationMs })
  }
  return [...acc.entries()]
    .map(([label, v]) => ({ label, ...v }))
    .sort((a, b) => b.ms - a.ms)
}

/**
 * 记录表 digest（`buildLogAnalyzeRequest` 的 userMessage 主干）。
 *
 * 与树视图 digest 的分工：那份按**类别聚合**回答「时间花在哪」，这份按**逐条记录**回答
 * 「筛出来的这些步骤具体是什么」。所以这里给的是表格而不是分桶，且**不重算任何时间** ——
 * 每一格都是 `LogRow` 上已有的数字，模型只负责读，不负责从原始时间戳推。
 *
 * `summary` 是**整会话**的耗时分解（来自 `logSummary(session)` = `breakdownOf`），不是筛选后的合计；
 * 行内明确标注，否则模型会把「筛选出 5 条的耗时」与「整会话 2h14m」当成一回事。
 */
export function buildLogDigest(scope: LogScope, summary: LogSummary): string {
  const { rows, total, filterLabel, sortLabel, spanLabel } = scope
  const truncated = rows.length > MAX_DIGEST_ROWS
  const lines: string[] = []

  lines.push('# 会话记录摘要（筛选后的记录表）')
  lines.push('')
  lines.push(`- 筛选条件：${filterLabel}`)
  lines.push(`- 范围：全量 ${total} 条 → 本次分析 ${rows.length} 条`)
  // 截断会重排表体（按耗时降序），所以「排列」必须与截断声明分开写、如实说清哪个才是表里的顺序 ——
  // 合成一句会出现「排列 正序」和一张倒序的表，读的人无从判断该信哪句
  lines.push(
    truncated
      ? `- 排列：${sortLabel || '时序（未重排）'}；**超出行数上限**，记录表按耗时降序取最慢的 ${MAX_DIGEST_ROWS} 条（其余见「筛选后分布」）`
      : `- 排列：${sortLabel || '时序（未重排）'}`,
  )
  lines.push(`- 时间范围：${spanLabel}`)
  lines.push('- 整会话耗时分解（**整个会话**的口径，不是筛选后的合计）：')
  lines.push(`  - 总耗时 ${fmtMs(summary.wallMs)}`)
  // 与树视图 digest 读同一个函数：本地工具取并集，`wallMs = 等用户 + 本地工具 + compute` 不会被破
  for (const l of breakdownLines(summary, 10)) lines.push(`  ${l}`)
  lines.push('')

  lines.push('## 筛选后分布')
  const dist = kindDistribution(rows)
  if (dist.length === 0) {
    lines.push('(筛选后没有记录)')
  } else {
    lines.push('| 类型 | 条数 | 耗时合计 |')
    lines.push('|---|---|---|')
    for (const d of dist) lines.push(`| ${cell(d.label)} | ${d.count} | ${fmtMs(d.ms)} |`)
  }
  lines.push('')

  lines.push(...recordTable(rows, truncated))
  return lines.join('\n')
}

/**
 * 记录表主体：正常时全量列出，超上限时按耗时降序取前 N 并把截断写明。
 * `truncated` 由调用方判一次传进来 —— 头部那行与这里说的是同一件事，各判各的迟早会各说各的。
 */
function recordTable(rows: readonly LogRow[], truncated: boolean): string[] {
  const lines: string[] = []
  if (rows.length === 0) {
    lines.push('## 记录表')
    lines.push('(筛选后没有记录：当前筛选条件一条都不匹配)')
    return lines
  }

  const shown = truncated
    ? [...rows].sort((a, b) => b.durationMs - a.durationMs).slice(0, MAX_DIGEST_ROWS)
    : rows
  lines.push(
    truncated
      ? `## 记录表（共 ${rows.length} 条，按耗时降序取前 ${MAX_DIGEST_ROWS} 条；其余 ${rows.length - MAX_DIGEST_ROWS} 条未列出）`
      : `## 记录表（共 ${rows.length} 条，全部列出）`,
  )
  lines.push('| 记录ID | 时间 | 类型 | 操作 | 摘要 | 耗时 | 输入tok | 输出tok | 状态 |')
  lines.push('|---|---|---|---|---|---|---|---|---|')
  for (const r of shown) {
    lines.push(
      `| ${cell(r.id)} | ${fmtClock(r.ts)} | ${cell(kindLabelOf(r))} | ${cell(r.action)} | ${cell(r.summary)} | ${rowDuration(r)} | ${r.tokens ? fmtTokens(r.tokens.input) : ''} | ${r.tokens ? fmtTokens(r.tokens.output) : ''} | ${LOG_STATUS_LABEL[r.status]} |`,
    )
  }
  return lines
}
