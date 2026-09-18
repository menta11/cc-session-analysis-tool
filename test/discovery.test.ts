import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { buildAgentIndex } from '../core/discovery/agentIndex'

const SESSION_DIR = fileURLToPath(new URL('./fixtures/sample-session', import.meta.url))

describe('buildAgentIndex', () => {
  it('maps agentId → transcript path from subagents/agent-*.jsonl', async () => {
    const idx = await buildAgentIndex(SESSION_DIR)
    expect(idx.has('abc')).toBe(true)
    expect(idx.has('def')).toBe(true)
    expect(idx.get('abc')!).toMatch(/agent-abc\.jsonl$/)
  })

  it('ignores .meta.json (only indexes transcripts)', async () => {
    const idx = await buildAgentIndex(SESSION_DIR)
    expect(idx.size).toBe(2) // abc + def, not the meta.json
  })
})
