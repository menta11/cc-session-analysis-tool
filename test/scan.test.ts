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

  it('extracts customTitle from custom-title event (user-renamed session)', async () => {
    const sessions = await scanProjects(ROOT)
    const s3 = sessions.find((s) => s.sessionId === 'sess-3')
    expect(s3?.customTitle).toBe('演示会话：采购单列表增加含税单价字段')
  })

  it('skips isMeta user events when collecting first user prompt', async () => {
    const sessions = await scanProjects(ROOT)
    const s3 = sessions.find((s) => s.sessionId === 'sess-3')
    // 首条 user 是 isMeta caveat 系统消息，真实 prompt 是第二条
    expect(s3?.userPrompt).toBe('1. 列表接口新增字段：每行新增返回含税单价（unitPriceWithTax）。\n2. 导出Excel新增“采购单价（含税）”列。')
  })

  it('extracts customTitle from agent-name event as fallback source', async () => {
    const sessions = await scanProjects(ROOT)
    const s4 = sessions.find((s) => s.sessionId === 'sess-4')
    expect(s4?.customTitle).toBe('JLC-TEST-0001')
  })

  it('extracts customTitle and aiTitle independently when both present', async () => {
    const meta = await readSessionMetaFromLines([
      '{"type":"ai-title","aiTitle":"AI自动命名","sessionId":"x"}',
      '{"type":"custom-title","customTitle":"用户重命名","sessionId":"x"}',
    ])
    expect(meta.customTitle).toBe('用户重命名')
    expect(meta.aiTitle).toBe('AI自动命名')
  })

  it('skips system-reminder and local-command tags when extracting user prompt', async () => {
    const meta = await readSessionMetaFromLines([
      '{"type":"user","isMeta":true,"message":{"role":"user","content":"<system-reminder>\\nThe user named this session \\"项目学习\\". This may indicate the session focus.\\n</system-reminder>"}}',
      '{"type":"user","message":{"role":"user","content":"<local-command-stdout>Session not found.</local-command-stdout>"}}',
      '{"type":"user","message":{"role":"user","content":"真实提问"}}',
    ])
    // isMeta 跳过 → 第二条 local-command-stdout 剔除后为空 → 继续找 → 真实提问
    expect(meta.userPrompt).toBe('真实提问')
  })

  it('reads past the 256KB byte window when giant events push the title back', async () => {
    // 巨型附件行（>256KB，模拟新版 hook_success 2.4MB 场景）+ 大量 attachment 噪音行，
    // 把 ai-title 推到 256KB 字节窗口之外 —— 字节预算应放大到 8MB 仍能提取
    const giant = 'x'.repeat(300 * 1024)
    const noise = []
    // 1200 条 attachment 噪音行占满物理行配额
    for (let i = 0; i < 1200; i++) noise.push(`{"type":"attachment","attachment":{"type":"hook_success","hookName":"U${i}"},"sessionId":"big"}`)
    const lines = [
      '{"type":"custom-title","customTitle":"被巨型行推到后面的标题","sessionId":"big"}',
      `{"type":"attachment","attachment":{"type":"hook_success","content":"${giant}"},"sessionId":"big"}`,
      ...noise,
      '{"type":"user","message":{"role":"user","content":"真实提问"},"sessionId":"big"}',
    ]
    const meta = await readSessionMetaFromLines(lines)
    expect(meta.customTitle).toBe('被巨型行推到后面的标题')
    expect(meta.userPrompt).toBe('真实提问')
  })

  it('ignores attachment/system noise lines when counting the line quota', async () => {
    // 噪音行不占 200 行配额：标题在 600 物理行之后（300 条 assistant + 200 条噪音）
    const lines: string[] = []
    // 先铺 300 条 assistant 噪音（物理行）—— 占行但非候选
    for (let i = 0; i < 300; i++) {
      lines.push(`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"t${i}"}]},"sessionId":"q"}`)
    }
    // 再铺 300 条 attachment
    for (let i = 0; i < 300; i++) {
      lines.push(`{"type":"attachment","attachment":{"type":"hook_success","hookName":"Q${i}"},"sessionId":"q"}`)
    }
    // 标题在 600 物理行之后
    lines.push('{"type":"ai-title","aiTitle":"行配额之外的标题","sessionId":"q"}')
    lines.push('{"type":"user","message":{"role":"user","content":"提问"},"sessionId":"q"}')
    const meta = await readSessionMetaFromLines(lines)
    expect(meta.aiTitle).toBe('行配额之外的标题')
    expect(meta.userPrompt).toBe('提问')
  })
})

/** 辅助：从 JSONL 行数组构造临时文件并调 readSessionMeta */
async function readSessionMetaFromLines(lines: string[]): Promise<{ cwd?: string | null; customTitle?: string | null; aiTitle?: string | null; userPrompt?: string | null }> {
  const { writeFileSync, mkdtempSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'scan-test-'))
  const file = join(dir, 'tmp.jsonl')
  writeFileSync(file, lines.join('\n'), 'utf8')
  return readSessionMeta(file)
}
