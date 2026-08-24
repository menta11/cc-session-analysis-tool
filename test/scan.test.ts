import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { scanProjects, readSessionMeta } from '../core/discovery/scan'

const ROOT = fileURLToPath(new URL('./fixtures/scan-projects', import.meta.url))

describe('scanProjects', () => {
  it('extracts cwd real path from session jsonl', async () => {
    const sessions = await scanProjects(ROOT)
    const s1 = sessions.find((s) => s.sessionId === 'sess-1')
    expect(s1?.cwd).toBe('d:\\project\\请假审批')
  })

  it('extracts aiTitle from ai-title event', async () => {
    const sessions = await scanProjects(ROOT)
    const s1 = sessions.find((s) => s.sessionId === 'sess-1')
    expect(s1?.aiTitle).toBe('请假审批系统Spec开发')
  })

  it('extracts cwd but leaves aiTitle undefined when jsonl has no ai-title', async () => {
    const sessions = await scanProjects(ROOT)
    const s2 = sessions.find((s) => s.sessionId === 'sess-2')
    expect(s2?.cwd).toBe('d:\\project\\普通项目')
    expect(s2?.aiTitle).toBeUndefined()
  })

  it('skips non-jsonl files and subdirectories', async () => {
    const sessions = await scanProjects(ROOT)
    expect(sessions.every((s) => s.sessionId.endsWith('.jsonl') === false)).toBe(true)
    expect(sessions.every((s) => s.path.endsWith('.jsonl'))).toBe(true)
  })

  it('extracts first user prompt (skipping command-message wrapper)', async () => {
    const sessions = await scanProjects(ROOT)
    const s1 = sessions.find((s) => s.sessionId === 'sess-1')
    expect(s1?.userPrompt).toBe('开始请假审批系统')
  })

  it('extracts userPrompt even without ai-title (sess-2 has user message)', async () => {
    const sessions = await scanProjects(ROOT)
    const s2 = sessions.find((s) => s.sessionId === 'sess-2')
    expect(s2?.userPrompt).toBe('普通会话')
  })

  it('leaves userPrompt undefined when no user message has prompt text', async () => {
    const meta = await readSessionMetaFromLines([
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}',
    ])
    expect(meta.userPrompt).toBeUndefined()
  })
})

/** 辅助：从 JSONL 行数组构造临时文件并调 readSessionMeta */
async function readSessionMetaFromLines(lines: string[]): Promise<{ cwd?: string | null; aiTitle?: string | null; userPrompt?: string | null }> {
  const { writeFileSync, mkdtempSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'scan-test-'))
  const file = join(dir, 'tmp.jsonl')
  writeFileSync(file, lines.join('\n'), 'utf8')
  return readSessionMeta(file)
}
