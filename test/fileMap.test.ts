import { describe, it, expect } from 'vitest'
import { parseLines } from '../core/parser/parse'
import { buildFileMap } from '../core/ai/prompt'

const lines = [
  '{"type":"user","uuid":"u1","timestamp":"2026-04-24T12:00:00.000Z","sessionId":"m","message":{"role":"user","content":"go"}}',
  '{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-04-24T12:00:01.000Z","sessionId":"m","message":{"model":"x","role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"npm test"}}],"usage":{}}}',
  '{"type":"user","uuid":"u2","parentUuid":"a1","timestamp":"2026-04-24T12:00:04.000Z","sessionId":"m","toolUseResult":{"stdout":"pass","stderr":"","interrupted":false},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"pass"}]}}',
  '{"type":"assistant","uuid":"a2","parentUuid":"u2","timestamp":"2026-04-24T12:00:04.000Z","sessionId":"m","message":{"model":"x","role":"assistant","content":[{"type":"tool_use","id":"t2","name":"Agent","input":{"description":"重构认证"}}],"usage":{}}}',
  '{"type":"user","uuid":"u3","parentUuid":"a2","timestamp":"2026-04-24T12:00:34.000Z","sessionId":"m","toolUseResult":{"agentId":"c","agentType":"general-purpose","totalDurationMs":30000,"totalTokens":2000,"description":"重构认证"},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t2","content":"done"}]}}',
]

describe('buildFileMap', () => {
  const session = parseLines(lines, 'm')
  const agentIndex = new Map<string, string>([['c', '/fake/root/subagents/agent-c.jsonl']])
  const map = buildFileMap(session, {
    projectsRoot: '/fake/root',
    mainFilePath: '/fake/root/main.jsonl',
    agentIndex,
  })

  it('含主文件 + 子agent文件 + 深挖线索段', () => {
    expect(map).toContain('文件地图')
    expect(map).toContain('## 主文件')
    expect(map).toContain('## 子agent 文件')
    expect(map).toContain('## 深挖线索')
  })

  it('主文件显示相对路径', () => {
    expect(map).toContain('main.jsonl')
  })

  it('子agent 行含 agentId + 相对路径 + 耗时', () => {
    expect(map).toContain('agentId=c')
    expect(map).toContain('subagents/agent-c.jsonl')
    expect(map).toContain('30s') // Agent 30s
  })

  it('深挖线索含父调用位置（turn / toolUseId / sync）', () => {
    // mini fixture 的 Agent 无 childSession → 无"子内最慢"行，但父调用行必有
    expect(map).toContain('父调用')
    expect(map).toContain('turn')
    expect(map).toContain('sync')
  })

  it('单 agent 无并行组段', () => {
    expect(map).not.toContain('## 并行组')
  })
})

describe('buildFileMap 真实传参形态（projectsRoot = 会话所在目录）', () => {
  const session = parseLines(lines, 'm')
  // 与迁移前 Electron 主进程 session:load 的缓存形态一致（该壳已删除，此处保留其传参形态）：
  // mainFilePath = 绝对路径 <projects>/<cwd>/<id>.jsonl
  // projectsRoot = dirname(去掉 .jsonl 的会话目录) = <projects>/<cwd>
  const id = 'abc-123'
  const projectsRoot = '/fake/projects/F--repo'
  const mainFilePath = `${projectsRoot}/${id}.jsonl`
  const agentIndex = new Map<string, string>([['c', `${projectsRoot}/${id}/subagents/agent-c.jsonl`]])

  it('主文件剥成 <sessionId>.jsonl 而非 ".jsonl"', () => {
    const map = buildFileMap(session, { projectsRoot, mainFilePath, agentIndex })
    expect(map).toContain(`## 主文件\n- ${id}.jsonl`)
    expect(map).not.toContain('main.jsonl')
  })

  it('子agent 文件带会话目录前缀，可拼回绝对路径', () => {
    const map = buildFileMap(session, { projectsRoot, mainFilePath, agentIndex })
    expect(map).toContain(`${id}/subagents/agent-c.jsonl`)
    // projectsRoot 基准行存在，claude 可拼接
    expect(map).toContain(`projectsRoot = ${projectsRoot}`)
  })

  it('mainFilePath 为空串时主文件显示 (未找到文件)', () => {
    const map = buildFileMap(session, { projectsRoot, mainFilePath: '', agentIndex })
    expect(map).toContain('- (未找到文件)')
  })
})
