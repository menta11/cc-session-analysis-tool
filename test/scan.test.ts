import { afterEach } from 'node:test'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import {
  SMALL_SESSION_BYTES,
  classifyHasRecords,
  hasAssistantRecord,
  readSessionMeta,
  scanProjects,
} from '../core/discovery/scan'
import { joinPath } from '../core/paths'
import {
  installCountingFsBridge,
  installFailingReadBridge,
  restoreNodeFsBridge,
} from './support/fsCounters'

const ROOT = fileURLToPath(new URL('./fixtures/scan-projects', import.meta.url))
/** 会话文件路径（元数据断言一律直接问 `readSessionMeta` —— 扫描本身不再读文件内容） */
const sessFile = (id: string): string => join(ROOT, 'proj-a', `${id}.jsonl`)

afterEach(() => restoreNodeFsBridge())

describe('scanProjects', () => {
  it('扫描只出骨架：不读文件内容，标题/cwd/prompt 一律留空', async () => {
    const sessions = await scanProjects(ROOT)
    expect(sessions.length).toBeGreaterThan(0)
    // 这是「启动不读文件」的核心判据：内容字段全空，只有目录 + stat 来的字段
    expect(sessions.every((s) => s.cwd === undefined && s.customTitle === undefined)).toBe(true)
    expect(sessions.every((s) => s.aiTitle === undefined && s.userPrompt === undefined)).toBe(true)
    expect(sessions.every((s) => s.path.endsWith('.jsonl') && s.mtimeMs > 0 && s.sizeBytes > 0)).toBe(true)
  })

  it('扫描只读「小文件」的头：大文件一个字不读，且永不做整读', async () => {
    const counters = installCountingFsBridge()
    const sessions = await scanProjects(ROOT)
    expect(sessions.length).toBeGreaterThan(0)
    // 契约（2026-09-14 起）：为了把「打开是空表」的会话从列表里去掉，扫描会整读 ≤64KB 的小文件；
    // 大文件不读（判定留待按需），且任何情况下都不走整读原语。夹具都是小文件，故每个都被读过一次。
    expect(counters.readHeads.slice().sort()).toEqual(sessions.map((s) => s.path).sort())
    expect(counters.readTexts).toEqual([])
    // 判定结果：sess-2 是「只有记账事件、没有 assistant」的那一个（见下方空会话用例）
    expect(sessions.find((s) => s.sessionId === 'sess-2')?.hasRecords).toBe(false)
    expect(sessions.filter((s) => s.hasRecords === true).length).toBe(sessions.length - 1)
  })

  it('extracts cwd real path from session jsonl', async () => {
    expect((await readSessionMeta(sessFile('sess-1'))).cwd).toBe('d:\\project\\请假审批')
  })

  it('extracts aiTitle from ai-title event', async () => {
    expect((await readSessionMeta(sessFile('sess-1'))).aiTitle).toBe('请假审批系统Spec开发')
  })

  it('extracts cwd but leaves aiTitle undefined when jsonl has no ai-title', async () => {
    const meta = await readSessionMeta(sessFile('sess-2'))
    expect(meta.cwd).toBe('d:\\project\\普通项目')
    expect(meta.aiTitle).toBeUndefined()
  })

  it('skips non-jsonl files and subdirectories', async () => {
    const sessions = await scanProjects(ROOT)
    expect(sessions.every((s) => s.sessionId.endsWith('.jsonl') === false)).toBe(true)
    expect(sessions.every((s) => s.path.endsWith('.jsonl'))).toBe(true)
  })

  it('extracts first user prompt (skipping command-message wrapper)', async () => {
    expect((await readSessionMeta(sessFile('sess-1'))).userPrompt).toBe('开始请假审批系统')
  })

  it('extracts userPrompt even without ai-title (sess-2 has user message)', async () => {
    expect((await readSessionMeta(sessFile('sess-2'))).userPrompt).toBe('普通会话')
  })

  it('leaves userPrompt undefined when no user message has prompt text', async () => {
    const meta = await readSessionMetaFromLines([
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}',
    ])
    expect(meta.userPrompt).toBeUndefined()
  })

  it('extracts customTitle from custom-title event (user-renamed session)', async () => {
    expect((await readSessionMeta(sessFile('sess-3'))).customTitle).toBe('演示会话：采购单列表增加含税单价字段')
  })

  it('skips isMeta user events when collecting first user prompt', async () => {
    // 首条 user 是 isMeta caveat 系统消息，真实 prompt 是第二条
    expect((await readSessionMeta(sessFile('sess-3'))).userPrompt).toBe(
      '1. 列表接口新增字段：每行新增返回含税单价（unitPriceWithTax）。\n2. 导出Excel新增“采购单价（含税）”列。',
    )
  })

  it('extracts customTitle from agent-name event as fallback source', async () => {
    expect((await readSessionMeta(sessFile('sess-4'))).customTitle).toBe('JLC-TEST-0001')
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

describe('空会话判定（打开只有空表的不进左栏）', () => {
  const JUNK = [
    '{"type":"mode","mode":"acceptEdits","sessionId":"j"}',
    '{"type":"permission-mode","permissionMode":"acceptEdits","sessionId":"j"}',
    '{"type":"file-history-snapshot","messageId":"m1","sessionId":"j"}',
    '{"type":"last-prompt","content":"hi","sessionId":"j"}',
  ]
  const REAL = [
    '{"type":"user","uuid":"u1","timestamp":"2026-04-24T12:00:00.000Z","sessionId":"r","message":{"role":"user","content":"go"}}',
    '{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-04-24T12:00:01.000Z","sessionId":"r","message":{"model":"x","role":"assistant","content":[{"type":"text","text":"ok"}],"usage":{}}}',
  ]
  /** 把一行撑成 padTo 字节以上（真实语料里的巨型 attachment 就是这个形状） */
  const pad = (padTo: number): string =>
    JSON.stringify({ type: 'attachment', sessionId: 'p', blob: 'x'.repeat(padTo) })

  /**
   * 桥**收到**的路径形态 —— 与 `scanProjects` 里的 `joinPath(joinPath(root, proj), f)` 逐字同构。
   *
   * 不能拿 `node:path.join` 拼：那是给文件系统用的原生路径（Windows 上是 `\`），
   * 而桥收到的路径由 `core/paths.ts::joinPath` 产出，分隔符统一是 `/`。两者在 POSIX 上恰好
   * 同形、在 Windows 上恒不同名。
   */
  const bridgePath = (root: string, name: string): string => joinPath(joinPath(root, 'proj-a'), name)

  it('hasAssistantRecord：认紧凑与带空格的写法，正文里被转义的字面量不误命中', () => {
    expect(hasAssistantRecord(REAL.join('\n'))).toBe(true)
    expect(hasAssistantRecord('{"type": "assistant", "message":{}}')).toBe(true)
    expect(hasAssistantRecord(JUNK.join('\n'))).toBe(false)
    expect(hasAssistantRecord('')).toBe(false)
    // 正文里的字面量在合法 JSONL 里必然被转义（引号前有反斜杠）→ 不误命中
    expect(hasAssistantRecord('{"type":"tool_result","content":"他说 \\"type\\":\\"assistant\\""}')).toBe(false)
  })

  it('classifyHasRecords 三态：有记录 / 确定没有（整份在手）/ 判不了（可能还有后续）', () => {
    const cap = SMALL_SESSION_BYTES
    expect(classifyHasRecords(REAL.join('\n'), 10 * 1024 * 1024, cap)).toBe(true)
    expect(classifyHasRecords(JUNK.join('\n'), 2048, cap)).toBe(false)
    // 没有 assistant 且文件比读到的头更大 → 只敢说「不知道」，不隐藏
    expect(classifyHasRecords(JUNK.join('\n'), cap + 1, cap)).toBeUndefined()
  })

  it('扫描：小文件当场判定，大文件不读也不判（算未知，照常显示）', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const root = mkdtempSync(join(tmpdir(), 'scan-empty-'))
    const proj = join(root, 'proj-a')
    mkdirSync(proj)
    const smallJunk = join(proj, 'small-junk.jsonl')
    const smallReal = join(proj, 'small-real.jsonl')
    const bigJunk = join(proj, 'big-junk.jsonl')
    const bigReal = join(proj, 'big-real.jsonl')
    writeFileSync(smallJunk, JUNK.join('\n'), 'utf8')
    writeFileSync(smallReal, REAL.join('\n'), 'utf8')
    writeFileSync(bigJunk, [JUNK.join('\n'), pad(SMALL_SESSION_BYTES * 2)].join('\n'), 'utf8')
    writeFileSync(bigReal, [REAL.join('\n'), pad(SMALL_SESSION_BYTES * 2)].join('\n'), 'utf8')

    const counters = installCountingFsBridge()
    const sessions = await scanProjects(root)
    const byId = Object.fromEntries(sessions.map((s) => [s.sessionId, s]))
    expect(byId['small-junk'].hasRecords).toBe(false)
    expect(byId['small-real'].hasRecords).toBe(true)
    expect(byId['big-junk'].hasRecords).toBeUndefined()
    expect(byId['big-real'].hasRecords).toBeUndefined()
    // 读的只有两个小文件：大文件连头都不碰。
    // 期望值必须用 `joinPath` 拼 —— 桥收到的路径是**生产代码用 `core/paths.ts` 拼出来的**
    // （分隔符统一 `/`），而 `node:path` 在 Windows 上给 `\`，两边恒不相等。
    expect(counters.readHeads.slice().sort()).toEqual(
      [bridgePath(root, 'small-junk.jsonl'), bridgePath(root, 'small-real.jsonl')].sort(),
    )
    const { rmSync } = await import('node:fs')
    rmSync(root, { recursive: true, force: true })
  })

  it('缓存里已有的判定直接生效：连小文件的头都不用再读', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const root = mkdtempSync(join(tmpdir(), 'scan-cache-'))
    const proj = join(root, 'proj-a')
    mkdirSync(proj)
    const junk = join(proj, 'junk.jsonl')
    const real = join(proj, 'real.jsonl')
    writeFileSync(junk, JUNK.join('\n'), 'utf8')
    writeFileSync(real, REAL.join('\n'), 'utf8')

    // 先扫一次拿到准确的 mtime/size，再照抄成缓存条目（真实缓存就是这么键的）
    const first = await scanProjects(root)
    const { emptyMetaCache, storeMeta } = await import('../core/discovery/metaCache')
    const cache = emptyMetaCache()
    for (const s of first) {
      storeMeta(cache, s.path, s.mtimeMs, s.sizeBytes, { hasRecords: s.sessionId === 'junk' ? false : true })
    }

    const counters = installCountingFsBridge()
    const again = await scanProjects(root, cache)
    // 缓存命中 → 一个文件都没读，结论与缓存一致
    expect(counters.readHeads).toEqual([])
    expect(counters.readTexts).toEqual([])
    expect(Object.fromEntries(again.map((s) => [s.sessionId, s.hasRecords]))).toEqual({
      junk: false,
      real: true,
    })
    rmSync(root, { recursive: true, force: true })
  })

  // 读失败**按宿主桥的口径注入**，不用 `chmod 0o000` 造：Windows 的 chmod 只影响只读位、
  // 不产生不可读，文件照常被读到 → 判定从「不知道」错成「没有记录」。
  // 两个口径是真实存在的两条路（Node 桥吞错返回空串 / Tauri 桥抛错），生产代码刻意都不依赖。
  it.each(['empty', 'throw'] as const)(
    '读失败（%s 口径）→ 未知（不隐藏）：不把「读不到」当成「没有」',
    async (mode) => {
      const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
      const { join } = await import('node:path')
      const { tmpdir } = await import('node:os')
      const root = mkdtempSync(join(tmpdir(), 'scan-readfail-'))
      const proj = join(root, 'proj-a')
      mkdirSync(proj)
      const file = join(proj, 'locked.jsonl')
      writeFileSync(file, JUNK.join('\n'), 'utf8')
      // 同一文件，两种拼法：`file` 是给 fs 用的原生路径，`bridgePath` 是桥收到的那个
      installFailingReadBridge(bridgePath(root, 'locked.jsonl'), mode)
      try {
        const sessions = await scanProjects(root)
        expect(sessions).toHaveLength(1)
        expect(sessions[0].hasRecords).toBeUndefined()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  )
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
