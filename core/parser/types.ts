// 递归 Session 树的数据模型（P0：解析填充的字段；kind/structuredResult/childSession 留待后续阶段）
// 字段命名遵循 camelCase；时间一律用 ms epoch（number）。

export interface Usage {
  input: number
  cacheCreation: number
  cacheRead: number
  output: number
  serviceTier: string | null
  ephemeral5m: number
  ephemeral1h: number
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; signature: string | null }
  | {
      type: 'tool_use'
      id: string
      name: string
      input: Record<string, unknown>
      caller: Record<string, unknown> | null
    }

export interface AssistantMsg {
  uuid: string
  parentUuid: string | null
  ts: number
  model: string
  blocks: ContentBlock[]
  usage: Usage
  isSidechain: boolean
  isSynthetic: boolean
}

export interface UserMsg {
  uuid: string
  parentUuid: string | null
  ts: number
  text: string
  hasToolResults: boolean
}

export interface ToolCall {
  toolUseId: string
  name: string
  input: Record<string, unknown>
  result: string | null
  isError: boolean
  tsStart: number
  tsEnd: number | null
  durationMs: number | null
  resultTruncated: boolean
  // 后续阶段填充
  kind?: 'direct' | 'delegated' | 'wait-user'
  structuredResult: StructuredResult | null
  childSession?: Session
}

export interface Turn {
  index: number
  userMsg: UserMsg | null
  assistantMsgs: AssistantMsg[]
  toolCalls: ToolCall[]
}

export interface Session {
  sessionId: string
  cwd: string | null
  gitBranch: string | null
  version: string | null
  /** 是否为子 agent transcript（解析时由 subagent 选项标记）。子 agent 不与人交互：无等用户。 */
  isSubagent: boolean
  startedAt: number | null
  endedAt: number | null
  turns: Turn[]
  sidechainMsgs: AssistantMsg[]
  unmatchedToolUses: ContentBlock[]
  systemTurnDurationsMs: number[]
  skippedCounts: Record<string, number>
  parseWarnings: string[]
}

// 顶层 toolUseResult 按工具名特化的结构化结果（P1）。未知工具落到 raw 兜底，不丢数据。
export type StructuredResult =
  | { toolName: 'Bash'; stdout: string; stderr: string; interrupted: boolean; timedOutAfterMs: number | null }
  | { toolName: 'Edit'; filePath: string; oldString: string; newString: string; replaceAll: boolean; structuredPatch: unknown }
  | { toolName: 'Write'; filePath: string; created: boolean }
  | { toolName: 'Read'; filePath: string }
  | { toolName: 'Grep'; mode: string | null; numFiles: number; numLines: number | null; totalLines: number | null }
  | { toolName: 'Glob'; numFiles: number; totalMatches: number | null; durationMs: number | null }
  | {
      toolName: 'Agent'
      agentId: string | null
      agentType: string | null
      totalDurationMs: number | null
      totalTokens: number | null
      totalToolUseCount: number | null
      isAsync: boolean
      description: string | null
      resolvedModel: string | null
    }

/** 节点墙钟时间分解（P3，对齐后模型）。wallMs = waitUser + localTool + compute。 */
export interface NodeTime {
  wallMs: number
  waitUserMs: number // 轮间间隙(等用户输入) + AskUserQuestion 区间
  localToolMs: number // merged（direct ∪ delegated）
  directMs: number // Bash/other merged
  delegatedMs: number // Agent/Task 委派调度区间 merged（递归）
  computeMs: number // 模型思考（派生 = wallMs − waitUser − localTool；含微量网络，不单列）
}
