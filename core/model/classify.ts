import type { ToolCall } from '../parser/types'

export type ToolKind = 'direct' | 'delegated' | 'wait-user'

/** 工具按时间分解的角色：direct=本地工具(Bash/other)，delegated=委派子agent(Agent/Task)，wait-user=等用户。 */
export function classifyTool(name: string): ToolKind {
  if (name === 'Agent' || name === 'Task') return 'delegated'
  if (name === 'AskUserQuestion') return 'wait-user'
  return 'direct'
}

export function classifyCall(tc: Pick<ToolCall, 'name'>): ToolKind {
  return classifyTool(tc.name)
}
