import { joinPath } from '../paths'
import type { WorkflowRun } from './types'

/**
 * workflow 运行记录（`<sessionDir>/workflows/<runId>.json`）的读取与容错解析。
 *
 * 为什么要有这一层：`Workflow` 是异步发起的，调用自己的时长（tool_use → tool_result）只有几百毫秒，
 * 而真实运行时长（本机 79 次运行：中位 4 分 16 秒、最长 77.9 分钟）只写在这个文件里。
 *
 * 容错口径与 transcript 解析一致：形状不认识 → null，字段缺失给 0/null，**不抛异常** ——
 * 这份文件由 workflow 脚本运行时写，版本之间会加字段（`error`、`workflowProgress` 之类我们都见过）。
 */

/** run 记录所在目录名（与 cc 一致） */
const WORKFLOW_DIR = 'workflows'
const RUN_FILE_EXT = '.json'

/**
 * 结果文本的截断上限。`result` 由脚本自己决定长什么样（评审结果是几百字，也见过 53080 字符的），
 * 面板里摊开一份五万字的 JSON 除了占地方没有别的用 —— 截断并标出来。
 */
const RESULT_MAX = 4_000
const ELLIPSIS = '…'

/**
 * 正常结束的状态。
 *
 * 界面只在**不是**它的时候才把状态写出来（`killed` / `failed` / `inconclusive`…）—— 与
 * 「运行情况」面板同一条口径：把「完成了」念一遍占地方却没人读。
 */
export const WORKFLOW_STATUS_COMPLETED = 'completed'

/** `runId` 对应的 run 记录路径 */
export function workflowRunPath(sessionDir: string, runId: string): string {
  return joinPath(sessionDir, WORKFLOW_DIR, `${runId}${RUN_FILE_EXT}`)
}

/**
 * 解一份 run 记录。`runId` 由调用方给（它就是文件名，比文件里的字段可信）。
 *
 * JSON 本身坏了、或不是个对象 → null（调用方按「没有 run 记录」处理，不猜）。
 */
export function parseWorkflowRun(runId: string, text: string): WorkflowRun | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const result = serializeResult(o.result)
  return {
    runId,
    workflowName: str(o, 'workflowName'),
    summary: str(o, 'summary'),
    status: str(o, 'status'),
    startTs: num(o, 'startTime'),
    durationMs: num(o, 'durationMs') ?? 0,
    agentCount: num(o, 'agentCount') ?? 0,
    totalTokens: num(o, 'totalTokens'),
    totalToolCalls: num(o, 'totalToolCalls'),
    phases: phaseTitles(o.phases),
    resultText: result.text,
    resultTruncated: result.truncated,
    logs: strList(o.logs),
  }
}

/**
 * 结果序列化：本来就是字符串就原样用（不再套一层引号），其余 `JSON.stringify`。
 * 序列化不了（循环引用之类）→ 空串，不抛。
 */
function serializeResult(v: unknown): { text: string; truncated: boolean } {
  if (v == null) return { text: '', truncated: false }
  let text: string
  if (typeof v === 'string') text = v
  else {
    try {
      text = JSON.stringify(v, null, 2) ?? ''
    } catch {
      return { text: '', truncated: false }
    }
  }
  return text.length > RESULT_MAX
    ? { text: text.slice(0, RESULT_MAX) + `\n${ELLIPSIS}（已截断，原始 ${text.length} 字符）`, truncated: true }
    : { text, truncated: false }
}

/** 阶段标题：`phases` 是 `[{title, detail}, …]`，只要标题；没有标题的项不写 */
function phaseTitles(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v
    .map((p) => (p && typeof p === 'object' ? str(p as Record<string, unknown>, 'title') : ''))
    .filter((t) => t !== '')
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function str(o: Record<string, unknown>, k: string): string {
  return typeof o[k] === 'string' ? (o[k] as string) : ''
}

function num(o: Record<string, unknown>, k: string): number | null {
  return typeof o[k] === 'number' && Number.isFinite(o[k]) ? (o[k] as number) : null
}
