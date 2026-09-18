import { fsBridge } from '../fsBridge'
import { joinPath } from '../paths'
import { parseWorkflowRun, workflowRunPath } from '../parser/workflowRun'
import type { Session, ToolCall } from '../parser/types'
import { linkSubagents, type ParseChild } from './linkSubagents'

/** workflow 子 agent 的文件名（与 cc 一致：`agent-<id>.jsonl`） */
const AGENT_FILE = /^agent-(.+)\.jsonl$/

export interface WorkflowLinkResult {
  session: Session
  /** 发起了、但 run 记录读不出来（缺失或坏 JSON）的 workflow 调用（诊断用，不阻断）。 */
  unresolved: ToolCall[]
}

/**
 * 把 workflow 的运行记录与它的子 agent 挂到对应的 `Workflow` 调用上。
 *
 * 两件事，都是「调用自己给不出」的：
 *  - **真实耗时**：`Workflow` 异步发起，调用自己的时长只有几百毫秒；`<sessionDir>/workflows/<runId>.json`
 *    里的 `durationMs` 才是它跑的时间（本机中位 4 分 16 秒）。
 *  - **子 agent**：一次调用背后是一整套子 agent（本机实测 3–7 个），落在
 *    `<sessionDir>/subagents/workflows/<runId>/agent-*.jsonl`。`agentIndex` 会扫到这些文件，
 *    但没人把结果挂回调用 —— 主 transcript 里**没有**任何一条 Agent 调用指向它们。
 *
 * run 记录读不出来（本机 84 次已发起的 workflow 里 5 次）不算错误：那条调用保留自己那个几百毫秒的
 * 区间，并进 `unresolved` 供诊断，其余照常。
 *
 * 递归：子 agent 自己的 Agent 委派继续链接（`linkSubagents`），它若是再发起 workflow 也照样接上。
 */
export async function linkWorkflows(
  session: Session,
  sessionDir: string,
  index: Map<string, string>,
  parseChild: ParseChild,
): Promise<WorkflowLinkResult> {
  const unresolved: ToolCall[] = []

  const link = async (s: Session, dir: string): Promise<void> => {
    for (const turn of s.turns) {
      for (const tc of turn.toolCalls) {
        const runId = workflowRunIdOf(tc)
        if (runId === null) continue
        const run = await readRun(dir, runId)
        if (run === null) {
          unresolved.push(tc)
          continue
        }
        tc.workflowRun = run
        const childDir = workflowAgentDir(dir, runId)
        const children = await readChildren(childDir, parseChild)
        if (children.length > 0) tc.childSessions = children
        for (const child of children) {
          // 子 agent 里可能还有委派（`Agent`）或更内层的 workflow —— 各自按自己的目录找
          await linkSubagents(child, index, parseChild)
          await link(child, childDir)
        }
      }
    }
  }

  await link(session, sessionDir)
  return { session, unresolved }
}

/** 这一条调用发起的 workflow runId（不是 workflow 调用 / 回执没给 runId → null）。 */
function workflowRunIdOf(tc: ToolCall): string | null {
  const sr = tc.structuredResult
  return sr !== null && sr.toolName === 'Workflow' && sr.runId ? sr.runId : null
}

async function readRun(sessionDir: string, runId: string): Promise<ReturnType<typeof parseWorkflowRun>> {
  try {
    return parseWorkflowRun(runId, await fsBridge().readText(workflowRunPath(sessionDir, runId)))
  } catch {
    return null
  }
}

/** workflow 子 agent 的目录：`<sessionDir>/subagents/workflows/<runId>` */
function workflowAgentDir(sessionDir: string, runId: string): string {
  return joinPath(sessionDir, 'subagents', 'workflows', runId)
}

/**
 * 读一个 workflow 下的全部子 agent 会话，按文件名排序（cc 的 id 是随机的，文件名序只是「稳定」，
 * 不代表运行顺序；要顺序得看各自的记录时刻）。
 *
 * 单个子 agent 解析失败只跳过它自己 —— 一个坏文件不该让整个 workflow 钻不进去。
 */
async function readChildren(dir: string, parseChild: ParseChild): Promise<Session[]> {
  let names: string[]
  try {
    names = (await fsBridge().readDir(dir)).map((e) => e.name)
  } catch {
    return [] // 没有这个目录 = 这一跑没留下子 agent 记录
  }
  const out: Session[] = []
  for (const name of names.filter((n) => AGENT_FILE.test(n)).sort()) {
    try {
      out.push(await parseChild(joinPath(dir, name)))
    } catch {
      continue
    }
  }
  return out
}
