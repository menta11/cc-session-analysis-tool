import type { ToolCall } from '../parser/types'

export type ToolKind = 'direct' | 'delegated' | 'workflow' | 'wait-user'

/**
 * 工具按时间分解的角色：
 *  - direct=本地工具(Bash/other)
 *  - delegated=委派子agent(Agent/Task)
 *  - workflow=workflow（一次调用在后台跑一整套子 agent；它的耗时只能从 run 记录读，见 `WorkflowRun`）
 *  - wait-user=等用户
 */
export function classifyTool(name: string): ToolKind {
  if (name === 'Agent' || name === 'Task') return 'delegated'
  if (name === 'Workflow') return 'workflow'
  if (name === 'AskUserQuestion') return 'wait-user'
  return 'direct'
}

export function classifyCall(tc: Pick<ToolCall, 'name'>): ToolKind {
  return classifyTool(tc.name)
}
