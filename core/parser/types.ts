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

/**
 * 一条 **API 消息**（不是一条 jsonl 记录）。
 *
 * cc 把同一条 API 消息按内容块拆成多条 jsonl 记录（共享 `message.id`，本机实测有的消息拆出
 * 52 条），解析时按 `message.id` 合回一条 —— 否则「模型的这一条响应」在界面上会被拆成好几行，
 * 思考在一行、正文在另一行、它发起的工具又在第三行。
 *
 * 因此：`blocks` 是整条消息的全部块（按记录顺序），`ts` 是**最后一条**记录的时刻（消息写完的时刻，
 * 「这条响应花了多久」的终点就在这），`uuid` / `parentUuid` 取第一条记录（链头）。
 */
/**
 * 上游 API 报错。cc 把它写成一条 `model: "<synthetic>"` 的 assistant 记录（正文就是 `API Error: …`），
 * 并在这条记录上额外写 `isApiErrorMessage` / `error` / `apiErrorStatus`。
 *
 * 本机实测 86 条（71 个会话文件）：归类 `unknown` 44、`server_error` 19、`model_not_found` 11、
 * `max_output_tokens` 7、`rate_limit` 5；HTTP 码 400×41、404×11、500×7、429×5、402×2、503×2、405×1。
 * 其中 25 条落在 `subagents/` 里，含 7 条响应超限被截断 —— 子 agent 被上游打断时，父侧那条委派
 * 记录不带 `is_error`（只有「已在后台启动」），所以这类错误只有钻进子会话才看得见。
 */
export interface ApiError {
  /** cc 给的上游错误归类（`rate_limit` / `max_output_tokens`…）。没写 → null（本机 44 条如此），不猜。 */
  kind: string | null
  /** 上游 HTTP 状态码。cc 并非每条都写（本机 17 条没有）→ null。 */
  status: number | null
}

export interface AssistantMsg {
  uuid: string
  parentUuid: string | null
  ts: number
  model: string
  blocks: ContentBlock[]
  usage: Usage
  /** 上游给的结束原因（`tool_use` / `end_turn` / `max_tokens` …）。缺失 → null，不猜。 */
  stopReason: string | null
  isSidechain: boolean
  isSynthetic: boolean
  /**
   * 这条响应是上游报错，不是模型真的回了话。不是错误 → null。
   *
   * 别拿 `isSynthetic` 代办：`/compact` 生成的摘要同样是 `model: "<synthetic>"`，那是正常消息。
   */
  apiError: ApiError | null
}

export interface UserMsg {
  uuid: string
  parentUuid: string | null
  ts: number
  text: string
  hasToolResults: boolean
  /**
   * 这条记录是 cc 写的**打断标记**，不是用户说的话：按 Esc 打断时 cc 会落一条正文为
   * `[Request interrupted by user]`（打断工具调用则是 `… for tool use]`）的 user 记录，
   * 本机 1189 个会话里共 560 条。它没有任何 assistant 回应，只有标记本身。
   *
   * 与 `AssistantMsg.isSynthetic` 同类：都是「这条记录是 cc 按约定写进去的」。
   */
  isInterrupt: boolean
  /**
   * 这条记录是 cc 的**本地命令**（`/compact`、`/clear`、`/plugin`…）时，命令名（不含前导 `/`）；
   * 不是命令记录 → null。
   *
   * 三种壳都算：裸 `/name`、cc 的 `<command-name>` 回显、命令的 `<local-command-stdout>` 输出。
   * 带 `<command-args>`（用户自己写的话，如 `/loop 30m 检测整个工程`）的技能调用不算 ——
   * 那是用户真的说了话，只是外面套了层命令壳。
   */
  commandName: string | null
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
  kind?: 'direct' | 'delegated' | 'workflow' | 'wait-user'
  structuredResult: StructuredResult | null
  childSession?: Session
  /**
   * workflow 调用（`Workflow`）的那次运行。只有 workflow 调用有 —— 它与 `childSession` 的区别在于
   * 一次调用背后是**一整套**子 agent（本机实测 3–7 个），不是一个。
   */
  workflowRun?: WorkflowRun
  /** workflow 这一跑下面的子 agent 会话（按文件名排序）。只有 workflow 调用有。 */
  childSessions?: Session[]
}

/**
 * 一次 workflow 运行，来自 `<sessionDir>/workflows/<runId>.json`。
 *
 * 为什么非读它不可：`Workflow` 是**异步发起**的（tool_use → tool_result 只有几百毫秒，内容是
 * 「已在后台启动」），所以调用自己的 `durationMs` 与真实运行时长差三个数量级 —— 本机 79 次运行
 * 里中位 4 分 16 秒、最长 77.9 分钟，全都在这个文件里。
 */
export interface WorkflowRun {
  runId: string
  /** workflow 自己的名字（脚本 meta.name，如 `parallel-review`）；缺失 → 空串。 */
  workflowName: string
  /** 脚本 meta.description：这个流程做什么。摘要列用它（比脚本路径有用得多）；缺失 → 空串。 */
  summary: string
  /** 运行结束时 cc 记的状态：`completed` / `killed` / `failed`… */
  status: string
  /** 运行开始的绝对时刻（run 记录的 `startTime`）。缺失 → null，此时区间不可信。 */
  startTs: number | null
  durationMs: number
  agentCount: number
  totalTokens: number | null
  totalToolCalls: number | null
  /** 阶段标题（run 记录的 `phases`），按脚本里声明的顺序。 */
  phases: string[]
  /**
   * 结果（run 记录的 `result`）的序列化文本。脚本自己决定这个对象长什么样，所以只能当文本给；
   * 本机实测中位 56 字符、最长 53080 字符 → 超长的截断并标出来。
   */
  resultText: string
  resultTruncated: boolean
  /** 运行日志（run 记录的 `logs`），逐条一行。 */
  logs: string[]
}

export interface Turn {
  index: number
  userMsg: UserMsg | null
  assistantMsgs: AssistantMsg[]
  toolCalls: ToolCall[]
}

/**
 * `system` / `turn_duration` 事件：cc 自报的一轮耗时。
 *
 * `ts` 是该轮**结束**时刻（cc 发这条事件时，紧跟在轮内最后一条 assistant 之后几十毫秒），
 * 所以它是「哪一轮」的唯一凭据；而它**不是每轮都发** —— 本机抽 40 个会话，37 个的条数与
 * 轮数不等，所以不能按出现顺序当轮号用。
 *
 * `durationMs` 的口径**只对清了一半**：在「提问后立刻开工」的简单轮上，它精确等于
 * 「轮墙上时长 − 轮内 AskUserQuestion 等待」（本机逐轮验证，差值 40~70ms，那点差就是这条
 * 事件自身发出的延迟）。但在长任务轮上不是 —— 26.3MB 那个会话里本地覆盖 2h53m 而 cc 只报
 * 1h58m，差的 54min 落在一段四十多分钟无任何记录的空白里（一个跨空白的工具把本地覆盖撑满）。
 * 所以对账面板只并列两个数，不替用户裁决谁对。
 */
export interface TurnDuration {
  ts: number
  durationMs: number
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
  systemTurnDurations: TurnDuration[]
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
  | {
      toolName: 'Workflow'
      runId: string | null
      taskId: string | null
      workflowName: string | null
      scriptPath: string | null
      /** cc 在发起那一刻给的状态（本机实测恒为 `async_launched`）。运行结果状态在 `WorkflowRun.status`。 */
      status: string | null
    }

/** 节点总耗时时间分解（P3，对齐后模型）。wallMs = waitUser + localTool + compute。 */
export interface NodeTime {
  wallMs: number
  waitUserMs: number // 轮间间隙(等用户输入) + AskUserQuestion 区间
  localToolMs: number // merged（direct ∪ delegated ∪ workflow）
  directMs: number // Bash/other merged
  delegatedMs: number // Agent/Task 委派调度区间 merged（递归）
  workflowMs: number // workflow 运行区间 merged（与直接工具/委派可重叠 —— 它在后台跑，主 agent 照常干活）
  computeMs: number // 模型思考（派生 = wallMs − waitUser − localTool；含微量网络，不单列）
}
