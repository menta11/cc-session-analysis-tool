import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { scanProjects } from '../core/discovery/scan'

const ROOT = fileURLToPath(new URL('./fixtures/scan-projects', import.meta.url))

describe('scanProjects', () => {
  it('extracts cwd real path from session jsonl', () => {
    const sessions = scanProjects(ROOT)
    const s1 = sessions.find((s) => s.sessionId === 'sess-1')
    expect(s1?.cwd).toBe('d:\\project\\请假审批')
  })

  it('extracts aiTitle from ai-title event', () => {
    const sessions = scanProjects(ROOT)
    const s1 = sessions.find((s) => s.sessionId === 'sess-1')
    expect(s1?.aiTitle).toBe('请假审批系统Spec开发')
  })

  it('extracts cwd but leaves aiTitle undefined when jsonl has no ai-title', () => {
    const sessions = scanProjects(ROOT)
    const s2 = sessions.find((s) => s.sessionId === 'sess-2')
    expect(s2?.cwd).toBe('d:\\project\\普通项目')
    expect(s2?.aiTitle).toBeUndefined()
  })

  it('skips non-jsonl files and subdirectories', () => {
    const sessions = scanProjects(ROOT)
    expect(sessions.every((s) => s.sessionId.endsWith('.jsonl') === false)).toBe(true)
    expect(sessions.every((s) => s.path.endsWith('.jsonl'))).toBe(true)
  })
})
