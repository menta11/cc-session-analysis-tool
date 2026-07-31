import { describe, it, expect } from 'vitest'
import { parseLines } from '../core/parser/parse'
import type { Session } from '../core/parser/types'
import { linkSubagents } from '../core/discovery/linkSubagents'

const user = (uuid: string, ts: string, content: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'user', uuid, parentUuid: null, timestamp: ts, sessionId: 'm', ...extra, message: { role: 'user', content } })

const agentCall = (uuid: string, parent: string, ts: string, id: string) =>
  JSON.stringify({ type: 'assistant', uuid, parentUuid: parent, timestamp: ts, sessionId: 'm', message: { model: 'x', role: 'assistant', content: [{ type: 'tool_use', id, name: 'Agent', input: {} }], usage: {} } })

const agentResult = (uuid: string, parent: string, ts: string, id: string, tur: Record<string, unknown> | null, text: string) =>
  JSON.stringify({ type: 'user', uuid, parentUuid: parent, timestamp: ts, sessionId: 'm', ...(tur ? { toolUseResult: tur } : {}), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } })

const leaf = (id: string): Session =>
  parseLines(
    [
      user('cu', '2026-04-24T12:00:01.000Z', 'leaf'),
      JSON.stringify({ type: 'assistant', uuid: 'ca', parentUuid: 'cu', timestamp: '2026-04-24T12:00:02.000Z', sessionId: id, message: { model: 'x', role: 'assistant', content: [{ type: 'text', text: 'leaf done' }], usage: {} } }),
    ],
    id,
  )

describe('linkSubagents', () => {
  it('attaches a child session for an Agent call with a matching agentId', () => {
    const index = new Map([['child1', '/fake/child1.jsonl']])
    const main = parseLines(
      [
        user('u1', '2026-04-24T12:00:00.000Z', 'go'),
        agentCall('a1', 'u1', '2026-04-24T12:00:01.000Z', 't1'),
        agentResult('u2', 'a1', '2026-04-24T12:00:02.000Z', 't1', { agentId: 'child1', agentType: 'general-purpose' }, 'done'),
      ],
      'm',
    )
    const child = leaf('child1')
    const parseChild = (p: string) => (p === '/fake/child1.jsonl' ? child : (() => { throw new Error('unknown') })())

    const { session, unresolved } = linkSubagents(main, index, parseChild)
    expect(session.turns[0].toolCalls[0].childSession).toBe(child)
    expect(unresolved).toHaveLength(0)
  })

  it('recurses: a child’s own Agent call links to a grandchild', () => {
    const index = new Map([
      ['child1', '/fake/child1.jsonl'],
      ['grand1', '/fake/grand1.jsonl'],
    ])
    const main = parseLines(
      [
        user('u1', '2026-04-24T12:00:00.000Z', 'go'),
        agentCall('a1', 'u1', '2026-04-24T12:00:01.000Z', 't1'),
        agentResult('u2', 'a1', '2026-04-24T12:00:05.000Z', 't1', { agentId: 'child1' }, 'done'),
      ],
      'm',
    )
    // child1 自己又派发了一个 Agent → grand1
    const child1 = parseLines(
      [
        user('cu1', '2026-04-24T12:00:01.500Z', 'sub'),
        agentCall('ca1', 'cu1', '2026-04-24T12:00:02.000Z', 'tg'),
        agentResult('cu2', 'ca1', '2026-04-24T12:00:03.000Z', 'tg', { agentId: 'grand1' }, 'sub done'),
      ],
      'child1',
    )
    const grand1 = leaf('grand1')
    const parseChild = (p: string): Session => {
      if (p === '/fake/child1.jsonl') return child1
      if (p === '/fake/grand1.jsonl') return grand1
      throw new Error('unknown')
    }

    const { session } = linkSubagents(main, index, parseChild)
    const child = session.turns[0].toolCalls[0].childSession!
    const grand = child.turns[0].toolCalls[0].childSession
    expect(child).toBe(child1)
    expect(grand).toBe(grand1)
  })

  it('falls back to tool_result text regex for async agents without structuredResult.agentId', () => {
    const index = new Map([['async1', '/fake/async1.jsonl']])
    const main = parseLines(
      [
        user('u1', '2026-04-24T12:00:00.000Z', 'go'),
        agentCall('a1', 'u1', '2026-04-24T12:00:01.000Z', 't1'),
        // 无 toolUseResult（structuredResult=null），但 result 文本里带 agentId
        agentResult('u2', 'a1', '2026-04-24T12:00:02.000Z', 't1', null, 'Started background agent async1 (agentId: async1, internal ID)'),
      ],
      'm',
    )
    const asyncChild = leaf('async1')
    const parseChild = (p: string) => (p === '/fake/async1.jsonl' ? asyncChild : (() => { throw new Error('unknown') })())

    const { session, unresolved } = linkSubagents(main, index, parseChild)
    expect(session.turns[0].toolCalls[0].childSession).toBe(asyncChild)
    expect(unresolved).toHaveLength(0)
  })

  it('records unresolved Agent calls (no agentId, no regex hit)', () => {
    const index = new Map([['child1', '/fake/child1.jsonl']])
    const main = parseLines(
      [
        user('u1', '2026-04-24T12:00:00.000Z', 'go'),
        agentCall('a1', 'u1', '2026-04-24T12:00:01.000Z', 't1'),
        agentResult('u2', 'a1', '2026-04-24T12:00:02.000Z', 't1', null, 'no id here'),
      ],
      'm',
    )
    const { session, unresolved } = linkSubagents(main, index, () => { throw new Error('should not be called') })
    expect(session.turns[0].toolCalls[0].childSession).toBeUndefined()
    expect(unresolved).toHaveLength(1)
  })
})
