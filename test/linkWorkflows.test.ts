import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { linkWorkflows } from '../core/discovery/linkWorkflows'
import { parseJsonlText, parseLines } from '../core/parser/parse'
import type { Session, ToolCall } from '../core/parser/types'

/**
 * workflow 链接：run 记录给耗时，子 agent 目录给钻取。
 *
 * 用**真临时目录**而不是打桩的 fs —— 这一层要证明的正是「路径拼对了、目录读得到」，
 * 打桩就把最该验的那件事换掉了。
 */

const RUN_ID = 'wf_f5f91388-276'

/** 主 transcript：一条 Workflow 调用 + 它的发起回执（runId 是唯一的钥匙） */
const mainLines = [
  '{"type":"user","uuid":"u1","timestamp":"2026-09-14T10:22:00.000Z","sessionId":"m","message":{"role":"user","content":"跑一遍评审"}}',
  `{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-09-14T10:23:10.245Z","sessionId":"m","message":{"model":"claude-sonnet-4-5-20250929","role":"assistant","content":[{"type":"tool_use","id":"call_wf","name":"Workflow","input":{"scriptPath":"D:/wf/parallel-review.js","args":"{}"}}],"usage":{}}}`,
  `{"type":"user","uuid":"u2","parentUuid":"a1","timestamp":"2026-09-14T10:23:10.582Z","sessionId":"m","toolUseResult":{"status":"async_launched","taskId":"walvv479d","taskType":"local_workflow","workflowName":"parallel-review","runId":"${RUN_ID}","summary":"多专家并行评审","scriptPath":"D:/wf/parallel-review.js"},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_wf","content":"Workflow launched in background."}]}}`,
]

const runJson = (patch: Record<string, unknown> = {}): string =>
  JSON.stringify({
    runId: RUN_ID,
    workflowName: 'parallel-review',
    status: 'completed',
    startTime: Date.parse('2026-09-14T10:23:10.466Z'),
    // 真跑了一分半，而上面那条调用自己的时长只有 337ms —— 差的就是这个数
    durationMs: 90_000,
    agentCount: 2,
    phases: [{ title: 'Review' }],
    logs: [],
    result: { passed: true },
    ...patch,
  })

/** 子 agent transcript：每条记录都带 isSidechain（子 transcript 的固有属性） */
function agentLines(id: string, prompt: string): string {
  return [
    `{"type":"user","uuid":"${id}-u1","timestamp":"2026-09-14T10:23:11.000Z","sessionId":"${id}","isSidechain":true,"message":{"role":"user","content":"${prompt}\\n\\n## 评审目标\\na.md"}}`,
    `{"type":"assistant","uuid":"${id}-a1","parentUuid":"${id}-u1","timestamp":"2026-09-14T10:23:20.000Z","sessionId":"${id}","isSidechain":true,"message":{"model":"claude-sonnet-4-5-20250929","role":"assistant","content":[{"type":"tool_use","id":"${id}-t1","name":"Read","input":{"file_path":"a.md"}}],"usage":{}}}`,
    `{"type":"user","uuid":"${id}-u2","parentUuid":"${id}-a1","timestamp":"2026-09-14T10:23:25.000Z","sessionId":"${id}","isSidechain":true,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"${id}-t1","content":"文件内容"}]}}`,
  ].join('\n')
}

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccsa-wf-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 与宿主同一套装配：子 transcript 一律以 subagent: true 解析（见 src/api/tauri.ts） */
const parseChild = (p: string): Session => parseJsonlText(readFileSync(p, 'utf8'), p, { subagent: true })

function writeRun(patch: Record<string, unknown> = {}, runId = RUN_ID): void {
  mkdirSync(join(dir, 'workflows'), { recursive: true })
  writeFileSync(join(dir, 'workflows', `${runId}.json`), runJson(patch))
}

function writeAgent(id: string, prompt: string): void {
  const d = join(dir, 'subagents', 'workflows', RUN_ID)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, `agent-${id}.jsonl`), agentLines(id, prompt))
}

const mainSession = (): Session => parseLines(mainLines, 'm')
const wfCall = (s: Session): ToolCall => s.turns.flatMap((t) => t.toolCalls).find((tc) => tc.name === 'Workflow')!

describe('linkWorkflows', () => {
  it('挂上 run 记录：真实耗时、状态、体量、阶段、结果', async () => {
    writeRun()
    const session = mainSession()
    const res = await linkWorkflows(session, dir, new Map(), parseChild)

    expect(res.unresolved).toEqual([])
    const run = wfCall(session).workflowRun
    expect(run?.durationMs).toBe(90_000)
    expect(run?.status).toBe('completed')
    expect(run?.agentCount).toBe(2)
    expect(run?.phases).toEqual(['Review'])
    expect(run?.resultText).toContain('"passed": true')
  })

  it('挂上这一跑的全部子 agent（按文件名排序），且它们是**完整**会话', async () => {
    writeRun()
    writeAgent('b2', '你是边界条件专家')
    writeAgent('a1', '你是准确性与一致性专家')
    const session = mainSession()
    await linkWorkflows(session, dir, new Map(), parseChild)

    const kids = wfCall(session).childSessions ?? []
    expect(kids.map((k) => k.sessionId)).toEqual(['a1', 'b2'])
    // 传漏 subagent:true 的话这里是空的（isSidechain 记录全被排除）——
    // 这一条就是钉住那个坑的（见 test/subagent-parse.test.ts）
    expect(kids[0].turns[0].assistantMsgs).toHaveLength(1)
    expect(kids[0].turns[0].toolCalls[0].name).toBe('Read')
    expect(kids[0].turns[0].toolCalls[0].result).toBe('文件内容')
  })

  it('没有 run 记录 → 进 unresolved，调用保留自己那个几百毫秒的区间', async () => {
    const session = mainSession()
    const res = await linkWorkflows(session, dir, new Map(), parseChild)

    expect(res.unresolved).toHaveLength(1)
    expect(res.unresolved[0].name).toBe('Workflow')
    expect(wfCall(session).workflowRun).toBeUndefined()
  })

  it('run 记录坏了（不是 JSON）也进 unresolved，不抛', async () => {
    mkdirSync(join(dir, 'workflows'), { recursive: true })
    writeFileSync(join(dir, 'workflows', `${RUN_ID}.json`), '{ 坏了')
    const res = await linkWorkflows(mainSession(), dir, new Map(), parseChild)
    expect(res.unresolved).toHaveLength(1)
  })

  it('有 run 记录但没有子 agent 目录 → 耗时照挂，childSessions 留空（不回退成空数组）', async () => {
    writeRun()
    const session = mainSession()
    await linkWorkflows(session, dir, new Map(), parseChild)
    expect(wfCall(session).workflowRun?.durationMs).toBe(90_000)
    expect(wfCall(session).childSessions).toBeUndefined()
  })

  it('单个子 agent 文件坏了不影响其余（一个坏文件不该让整个 workflow 钻不进去）', async () => {
    writeRun()
    writeAgent('a1', '你是准确性与一致性专家')
    const d = join(dir, 'subagents', 'workflows', RUN_ID)
    writeFileSync(join(d, 'agent-broken.jsonl'), '{ 不是 JSON')
    const session = mainSession()
    await linkWorkflows(session, dir, new Map(), parseChild)
    // 坏文件解析不出会话，但解析器容错：它照样返回一个空会话 —— 关键是没把整个链接打断
    expect((wfCall(session).childSessions ?? []).length).toBeGreaterThanOrEqual(1)
    expect(wfCall(session).workflowRun?.durationMs).toBe(90_000)
  })
})
