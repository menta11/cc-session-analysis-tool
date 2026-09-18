import type { StructuredResult } from './types'

type Obj = Record<string, unknown>

const str = (o: Obj, k: string): string => (typeof o[k] === 'string' ? (o[k] as string) : '')
const num = (o: Obj, k: string): number | null => (typeof o[k] === 'number' ? (o[k] as number) : null)
const bool = (o: Obj, k: string): boolean => o[k] === true
const strOrNull = (o: Obj, k: string): string | null => (typeof o[k] === 'string' ? (o[k] as string) : null)

/**
 * 从顶层 toolUseResult 按工具名抽取结构化结果。
 * toolUseResult 多为对象，但少数是数组/字符串（实测 Bash/Agent 偶现）→ 非 plain object 返回 null。
 * 未知工具名落到 { toolName, raw } 兜底，保留原始字段不丢。
 */
export function extractStructuredResult(toolName: string, tur: unknown): StructuredResult | null {
  if (!tur || typeof tur !== 'object' || Array.isArray(tur)) return null
  const o = tur as Obj

  switch (toolName) {
    case 'Bash':
      return {
        toolName: 'Bash',
        stdout: str(o, 'stdout'),
        stderr: str(o, 'stderr'),
        interrupted: bool(o, 'interrupted'),
        timedOutAfterMs: num(o, 'timedOutAfterMs'),
      }
    case 'Edit':
      return {
        toolName: 'Edit',
        filePath: str(o, 'filePath'),
        oldString: str(o, 'oldString'),
        newString: str(o, 'newString'),
        replaceAll: bool(o, 'replaceAll'),
        structuredPatch: o.structuredPatch ?? null,
      }
    case 'Write':
      return { toolName: 'Write', filePath: str(o, 'filePath'), created: str(o, 'type') === 'create' }
    case 'Read': {
      const file = o.file
      const filePath = file && typeof file === 'object' ? str(file as Obj, 'filePath') : str(o, 'file')
      return { toolName: 'Read', filePath }
    }
    case 'Grep':
      return {
        toolName: 'Grep',
        mode: strOrNull(o, 'mode'),
        numFiles: num(o, 'numFiles') ?? 0,
        numLines: num(o, 'numLines'),
        totalLines: num(o, 'totalLines'),
      }
    case 'Glob':
      return {
        toolName: 'Glob',
        numFiles: num(o, 'numFiles') ?? 0,
        totalMatches: num(o, 'totalMatches'),
        durationMs: num(o, 'durationMs'),
      }
    case 'Agent':
      return {
        toolName: 'Agent',
        agentId: strOrNull(o, 'agentId'),
        agentType: strOrNull(o, 'agentType'),
        totalDurationMs: num(o, 'totalDurationMs'),
        totalTokens: num(o, 'totalTokens'),
        totalToolUseCount: num(o, 'totalToolUseCount'),
        isAsync: bool(o, 'isAsync'),
        description: strOrNull(o, 'description'),
        resolvedModel: strOrNull(o, 'resolvedModel'),
      }
    // 这次回执只说「已在后台启动」；真实耗时与结果在 <sessionDir>/workflows/<runId>.json 里，
    // 由 `core/discovery/linkWorkflows.ts` 补上（runId 是唯一的钥匙）。
    case 'Workflow':
      return {
        toolName: 'Workflow',
        runId: strOrNull(o, 'runId'),
        taskId: strOrNull(o, 'taskId'),
        workflowName: strOrNull(o, 'workflowName'),
        scriptPath: strOrNull(o, 'scriptPath'),
        status: strOrNull(o, 'status'),
      }
    default:
      return null
  }
}
