/**
 * `src/api/tauri.ts` 的端到端验证。
 *
 * 这是 Stage 2.1 的关键证据：证明 **Tauri 那条代码路径真的能跑通** ——
 * `scanProjects`（异步 readDir/stat + readHead）→ `loadSession`（异步 readText + parseJsonlText +
 * 异步 linkSubagents 递归读子 transcript）。
 *
 * 为什么能在 vitest 里跑：`src/api/tauri.ts` 刻意**不直接**调 invoke 做文件操作，而是走
 * `core/fsBridge`（见 core/fsBridge.ts 的设计）。所以测试只需：
 *   1) 用全局 setup 装好的 **Node 桥** 提供真实文件读写；
 *   2) 用 `vi.mock` 只把 `home_dir` 这一个纯环境查询命令替换掉。
 * 这样测的是真实实现，不是替身 —— 只有"家目录从哪来"被隔离。
 *
 * 它同时充当"桥的双实现一致性"检查：Node 桥 + Tauri 业务代码若与迁移前 Electron 语义有偏差，
 * 这里会以断言失败暴露。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { META_CACHE_VERSION, type MetaCache } from '../core/discovery/metaCache'
import { buildLogRows } from '../core/view/logView'

/** hoisted 持有者：mock 工厂在 import 之前求值，所以只能通过它拿到运行期才确定的临时目录 */
const h = vi.hoisted(() => ({
  home: '',
  floatEnters: 0,
  /** 原生（asset 协议）读取的计数与开关：验证「优先原生、失败/超范围回退 IPC」 */
  nativeFetches: [] as string[],
  nativeFails: false,
  writes: [] as { path: string; contents: string }[],
  /** 保存对话框替身：记住调用参数，并回一个「用户选中的路径」（null = 取消） */
  saveCalls: [] as { defaultPath?: string; filters?: unknown }[],
  saveResult: null as string | null,
}))

vi.mock('@tauri-apps/api/core', () => ({
  // asset 协议 URL 的构造是纯字符串拼接，测试里按真实形状（编码后的绝对路径）给
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'home_dir') return h.home
    // 监控两项现在经 IPC；这里给出"代理未就绪"的值，让断言仍覆盖 IPC 路径
    // 元数据缓存的落盘位置与写入：走真实命令名，写进内存由断言取用
    if (cmd === 'app_data_dir') return `${h.home}/appdata`
    if (cmd === 'write_text') {
      // 替身也**真落盘**（与 Rust 命令同语义）：后续的读回走真实文件，往返才作数
      const { path, contents } = args as { path: string; contents: string }
      const { writeFileSync } = await import('node:fs')
      writeFileSync(path, contents, 'utf8')
      h.writes.push({ path, contents })
      return undefined
    }
    if (cmd === 'monitor_port') return 0
    if (cmd === 'monitor_ping') return false
    // 悬浮窗：`plugin:float|enter` 是唯一从主窗口发出的悬浮窗命令
    // （见 src-tauri/src/float_window.rs）。计一次数，让「dashboard 的悬浮框按钮
    // 真的落到 IPC」这件事可断言 —— 而不是只断言"没抛异常"。
    if (cmd === 'plugin:float|enter') {
      h.floatEnters += 1
      return undefined
    }
    // 其它命令（read_dir/stat/read_text/read_head）在测试里不应被调用 ——
    // 文件读写走 FsBridge 的 Node 实现；真调用到说明架构偏离了设计。
    throw new Error(`测试里出现了非预期的 invoke: ${cmd} ${JSON.stringify(args ?? {})}`)
  },
}))

const { tauriApi } = await import('../src/api/tauri')

/**
 * `onImportSession` 用的 `@tauri-apps/api/event` 假实现。
 *
 * 为什么要接管它：菜单「导入会话」的契约是「宿主先 `emit`、渲染层 `listen`」，
 * 而 `HostApi` 又要求 `onImportSession` **同步返回**取消函数，Tauri 的 `listen` 却是异步的。
 * 这段「同步登记取消意图 + 异步补上 unlisten」的胶水（尤其"取消早于 resolve"那条竞态分支）
 * 是最容易静默写错的地方，所以用一个可控的假 `listen` 把两条分支都钉死。
 */
const ev = vi.hoisted(() => ({
  /** 当前注册的 handler（按事件名） */
  handlers: new Map<string, (e: { payload: unknown }) => void>(),
  /** 底层 unlisten 被调用的次数 */
  unlistened: 0,
  /** true = 让 listen 的 Promise 悬着，等测试手动 settle（复刻竞态） */
  hold: false,
  pending: null as null | (() => void),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: (name: string, handler: (e: { payload: unknown }) => void) =>
    new Promise<() => void>((resolve) => {
      const settle = (): void => {
        ev.handlers.set(name, handler)
        resolve(() => {
          ev.unlistened += 1
          ev.handlers.delete(name)
        })
      }
      if (ev.hold) ev.pending = settle
      else settle()
    }),
}))

/**
 * `@tauri-apps/plugin-dialog` 假实现。
 *
 * 「保存对话框 + 写盘」现在是两步（`chooseSavePath` → `writeTextFile`），两步之间的
 * 「按扩展名决定内容」在调用方 —— 这里要钉住的是：过滤器/默认文件名真的传给了对话框，
 * 取消返回 null（调用方据此不写盘），以及写盘走的是真实命令名。
 */
vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: async (opts: { defaultPath?: string; filters?: unknown }) => {
    h.saveCalls.push(opts)
    return h.saveResult
  },
}))

/**
 * asset 协议的替身：把 asset:// URL 解回路径并真读文件。
 *
 * 这里**必须是真读**：这条链路的价值就是「同一份字节换个通道」，替身若回假数据，
 * 「原生与 IPC 读到的东西一致」这个判据就不成立了。
 */
const realFetch = globalThis.fetch
beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    const m = /^asset:\/\/localhost\/(.+)$/.exec(url)
    if (!m) return new Response('not found', { status: 404 })
    h.nativeFetches.push(decodeURIComponent(m[1]))
    if (h.nativeFails) return new Response('boom', { status: 500 })
    const bytes = readFileSync(decodeURIComponent(m[1]))
    return new Response(bytes, { status: 200 })
  }) as typeof fetch
})

// ── 构造一份最小但真实的会话目录 ──────────────────────────────────────
// main.jsonl 里发起一个 Agent 调用，subagents/agent-child1.jsonl 是对应的子 transcript。
// 这条链路会同时打到 buildAgentIndex（列目录）、parseJsonlText（解析）与
// linkSubagents（异步递归读子文件）。
const user = (uuid: string, ts: string, content: unknown, sid: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'user',
    uuid,
    parentUuid: null,
    timestamp: ts,
    sessionId: sid,
    ...extra,
    message: { role: 'user', content },
  })

const toolUse = (uuid: string, parent: string, ts: string, id: string, name: string, sid: string) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    parentUuid: parent,
    timestamp: ts,
    sessionId: sid,
    message: {
      model: 'x',
      role: 'assistant',
      content: [{ type: 'tool_use', id, name, input: {} }],
      usage: {},
    },
  })

/**
 * 子 transcript 的每一条记录都带 `isSidechain: true`（本机 1502 份里抽 200 份逐个统计，
 * 非 sidechain 的 user/assistant 记录 **0 条**）。fixture 必须跟上这个字段 —— 少了它，
 * 解析子 transcript 时漏传 `subagent: true` 这类缺陷在测试里就看不见。
 */
const sidechain = (line: string): string => JSON.stringify({ ...JSON.parse(line), isSidechain: true })

const agentResult = (
  uuid: string,
  parent: string,
  ts: string,
  id: string,
  sid: string,
  tur: Record<string, unknown>,
  text: string,
) =>
  JSON.stringify({
    type: 'user',
    uuid,
    parentUuid: parent,
    timestamp: ts,
    sessionId: sid,
    toolUseResult: tur,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
  })

const assistantText = (uuid: string, parent: string, ts: string, sid: string, text: string) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    parentUuid: parent,
    timestamp: ts,
    sessionId: sid,
    message: { model: 'x', role: 'assistant', content: [{ type: 'text', text }], usage: {} },
  })

let root = '' // 临时 HOME
let sessionDir = ''
let mainPath = ''

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ccsa-tauri-api-'))
  h.home = root

  // 真实目录布局（必须照抄，否则扫描不到）：
  //   projects/<proj>/<sessionId>.jsonl          ← 主文件
  //   projects/<proj>/<sessionId>/subagents/*.jsonl  ← 子 transcript 目录
  const projDir = join(root, '.claude', 'projects', 'proj-a')
  sessionDir = join(projDir, 'sess-main')
  mainPath = join(projDir, 'sess-main.jsonl')
  mkdirSync(join(sessionDir, 'subagents'), { recursive: true })

  writeFileSync(
    mainPath,
    [
      user('u1', '2026-04-24T12:00:00.000Z', 'go', 'sess-main'),
      toolUse('a1', 'u1', '2026-04-24T12:00:01.000Z', 't1', 'Agent', 'sess-main'),
      agentResult('u2', 'a1', '2026-04-24T12:00:05.000Z', 't1', 'sess-main', { agentId: 'child1' }, 'done'),
      assistantText('a2', 'u2', '2026-04-24T12:00:06.000Z', 'sess-main', '完成'),
    ].join('\n') + '\n',
    'utf8',
  )

  writeFileSync(
    join(sessionDir, 'subagents', 'agent-child1.jsonl'),
    [
      sidechain(user('cu', '2026-04-24T12:00:02.000Z', 'sub', 'child1')),
      sidechain(assistantText('ca', 'cu', '2026-04-24T12:00:03.000Z', 'child1', 'leaf done')),
      sidechain(toolUse('cb', 'ca', '2026-04-24T12:00:03.500Z', 'ct1', 'Bash', 'child1')),
      sidechain(agentResult('cr', 'cb', '2026-04-24T12:00:04.000Z', 'ct1', 'child1', {}, 'ok')),
    ].join('\n') + '\n',
    'utf8',
  )
})

afterAll(() => {
  globalThis.fetch = realFetch
  rmSync(root, { recursive: true, force: true })
})

describe('tauriApi（真实代码路径 + Node 桥）', () => {
  it('scanProjects：经 home_dir 定位 ~/.claude/projects，只出骨架（不读文件内容）', async () => {
    const sessions = await tauriApi.scanProjects()
    expect(sessions).toHaveLength(1)
    const s = sessions[0]
    expect(s.sessionId).toBe('sess-main')
    expect(s.project).toBe('proj-a')
    expect(s.path.endsWith('sess-main.jsonl')).toBe(true)
    expect(s.sizeBytes).toBeGreaterThan(0)
    expect(s.mtimeMs).toBeGreaterThan(0)
    // 元数据不在扫描里读（那是启动卡顿的来源）——按需路径见下一条
    expect(s.userPrompt).toBeUndefined()
  })

  it('readSessionMeta：经 readHead + TS 提取拿到元数据（按需读的真实代码路径）', async () => {
    const meta = await tauriApi.readSessionMeta(mainPath)
    expect(meta.userPrompt).toBe('go')
  })

  it('元数据缓存：读不到文件给空缓存，写出后能再读回来（经 app_data_dir + write_text 真实命令名）', async () => {
    expect((await tauriApi.loadMetaCache()).entries).toEqual({}) // 首次：文件还不存在
    const cache: MetaCache = {
      version: META_CACHE_VERSION,
      entries: { '/p/a.jsonl': { mtimeMs: 1, sizeBytes: 2, meta: { cwd: '/x' } } },
    }
    // 目录由 Rust 的 app_data_dir 命令保证存在；测试里替身只回路径，故这里自己建
    mkdirSync(join(h.home, 'appdata'), { recursive: true })
    await tauriApi.saveMetaCache(cache)
    expect(h.writes).toHaveLength(1)
    expect(h.writes[0].path.endsWith('/appdata/meta-cache.json')).toBe(true)

    // 经真实读写路径往返：宿主写下的与 core 解析的是同一个形状
    expect(await tauriApi.loadMetaCache()).toEqual(cache)
  })

  it('loadSession：异步 readText + parseJsonlText + 异步 linkSubagents 递归挂载子 agent', async () => {
    const session = await tauriApi.loadSession(mainPath)
    expect(session.sessionId).toBe('sess-main')
    expect(session.turns.length).toBeGreaterThan(0)

    const agentTc = session.turns.flatMap((t) => t.toolCalls).find((tc) => tc.name === 'Agent')
    expect(agentTc, '没找到 Agent 调用').toBeDefined()
    // 关键断言：子 transcript 是经 **异步** 桥读进来的
    expect(agentTc!.childSession, 'childSession 未挂载 —— 异步 ParseChild 路径没生效').toBeDefined()
    expect(agentTc!.childSession!.sessionId).toBe('child1')
    expect(agentTc!.childSession!.turns.length).toBeGreaterThan(0)
    // 子会话必须能产出**逐条记录**：子 transcript 的记录全带 isSidechain，读取处漏传
    // `subagent: true` 时会只剩「用户」那一行（钻取子表因此空白）。这条断言就是那个判据 ——
    // 注意第一行是子会话自己那对开场问答（提问 cu + 回答 ca），第二行是「想 + 做」（cb + 它发起的 Bash）。
    const childRows = buildLogRows(agentTc!.childSession!)
    expect(childRows.map((r) => r.kind)).toEqual(['llm', 'tool'])
    expect(childRows[0].mergedWith).toBe('user')
    expect(childRows[0].panels[0].body).toBe('sub')
    expect(childRows[1].mergedWith).toBe('tool')
  })

  it('订阅类返回可调用的取消函数、监控类给安全默认值（否则页面会白屏）', async () => {
    // 订阅类必须返回可调用的取消函数（组件 mount 时会直接调用）。
    // onImportSession 的完整契约在下面单独的 describe 里；这里只做形状检查后立刻取消。
    const offImport = tauriApi.onImportSession(() => {})
    expect(typeof offImport).toBe('function')
    offImport()
    // 监控类给安全默认值，保证 MonitorPage 能正常渲染
    expect(await tauriApi.getMonitorPort()).toBe(0)
    expect(await tauriApi.pingMonitor()).toBe(false)
  })

  it('enterFloatMode：落到 plugin:float|enter，而不是空实现', async () => {
    // dashboard 的悬浮框按钮 → iframe postMessage → MonitorPage → 这里。
    // 这条断言钉住"渲染层真的把请求发给了 Rust 悬浮窗插件"（命令名的前缀与名字都不能变，
    // 见 src-tauri/src/float_window.rs 的 BRIDGE 与 capabilities/float.json）。
    const before = h.floatEnters
    await expect(tauriApi.enterFloatMode()).resolves.toBeUndefined()
    expect(h.floatEnters).toBe(before + 1)
  })

  it('非法 claudeId → 守卫早返回，不碰 bridge（不 spawn 终端）', async () => {
    const t = await tauriApi.openTerminal('not-a-uuid')
    expect(t.ok).toBe(false)
    expect(t.error).toContain('sessionId 非法')
  })

  it('未 loadSession 就 analyzeReport → 明确的"会话未加载"，且不触碰 CLI', async () => {
    const r = await tauriApi.analyzeReport('/not/loaded.jsonl', { kind: 'whole' })
    expect(r.ok).toBe(false)
    expect(r.text).toBe('')
    expect(r.error).toContain('会话未加载')
  })

  it('analyzeReport：用缓存会话组装提示词，并把 delta 广播给 onAnalyzeChunk 订阅者', async () => {
    // 装**假的 ProcBridge** 拦住真实子进程 —— 测试绝不能真去调 claude（会打网络、会产生费用）
    const { setProcBridge } = await import('../core/procBridge')
    const lines = [
      '{"type":"system","subtype":"init","session_id":"sess-main"}',
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"OK"}}}',
      '{"type":"result","session_id":"sess-main","total_cost_usd":0.02,"duration_ms":10,"num_turns":1}',
    ]
    let seenStdin = ''
    let seenCmd = ''
    setProcBridge({
      platform: 'darwin',
      async execText(cmd) {
        return {
          ok: true,
          out: cmd === 'which' || cmd === 'where' ? '/usr/local/bin/claude' : 'stream-json include-partial-messages',
        }
      },
      async runLines(cmd, _args, stdinText, onLine) {
        seenCmd = cmd
        seenStdin = stdinText
        for (const l of lines) onLine(l)
        return { ok: true, stderr: '' }
      },
    })

    try {
      const chunks: Array<{ sessionPath: string; tag: string; text: string }> = []
      const off = tauriApi.onAnalyzeChunk((c) => chunks.push(c))
      await tauriApi.loadSession(mainPath) // 必须先加载：analyzeReport 靠 sessionCache 取会话
      const r = await tauriApi.analyzeReport(mainPath, { kind: 'whole' })
      off()

      expect(r.ok).toBe(true)
      expect(r.text).toBe('OK')
      expect(r.costUsd).toBe(0.02)
      // chunk 带 sessionPath + tag —— 渲染端靠前者区分会话、靠后者区分同一个会话上的两份报告
      expect(chunks).toEqual([{ sessionPath: mainPath, tag: 'tree', text: 'OK' }])
      // 提示词确实 inline 进了 stdin（而不是塞进 argv）
      expect(seenStdin).toContain('# 待分析数据')
      expect(seenStdin.length).toBeGreaterThan(100)
      expect(seenCmd).toBe('claude')

      // 取消订阅后不再收到
      const off2 = tauriApi.onAnalyzeChunk((c) => chunks.push(c))
      off2()
      expect(chunks).toHaveLength(1)

      // 日志分析走同一个广播通道，但归属是 'log' —— 两边各自认领自己的 chunk
      seenStdin = ''
      chunks.length = 0
      const off3 = tauriApi.onAnalyzeChunk((c) => chunks.push(c))
      const logRes = await tauriApi.analyzeReport(mainPath, {
        kind: 'log',
        scope: {
          rows: [],
          total: 0,
          filterLabel: '未筛选（全部记录）',
          sortLabel: '',
          spanLabel: '01-02 10:00 ~ 10:01',
        },
        summary: { wallMs: 1000, waitUserMs: 0, localToolMs: 0, directMs: 0, delegatedMs: 0, workflowMs: 0, computeMs: 1000 },
      })
      off3()

      expect(logRes.ok).toBe(true)
      expect(chunks).toEqual([{ sessionPath: mainPath, tag: 'log', text: 'OK' }])
      expect(seenStdin).toContain('# 会话记录摘要')
    } finally {
      // 还原 Node 桥，避免污染后续用例
      const { installNodeProcBridge } = await import('../core/procBridgeNode')
      installNodeProcBridge()
    }
  })
})

/**
 * 读会话正文的通道选择：`~/.claude/projects` 内走 asset 协议（WebView 原生读文件），
 * 范围外或失败则回退 IPC。
 *
 * 为什么值得钉：本机 26MB 会话实测 639ms（IPC）vs 19ms（asset），差的是 24MB 走 JSON 的搬运 ——
 * 回退分支若写错，要么「导入的会话打不开」，要么「慢得莫名其妙」，两种都是用户直接感知的故障。
 */
describe('读正文：原生优先、IPC 兜底', () => {
  it('scope 内 → 走 asset 协议，且读到的内容与 IPC 逐字符相同', async () => {
    h.nativeFetches = []
    const viaNative = await tauriApi.loadSession(mainPath)
    expect(h.nativeFetches).toContain(mainPath)
    // 子 transcript 同样走原生通道
    expect(h.nativeFetches.some((p) => p.endsWith('agent-child1.jsonl'))).toBe(true)

    // 对照：把原生通道关掉（模拟协议被禁）→ 回退 IPC，结果一模一样
    h.nativeFails = true
    h.nativeFetches = []
    const viaFallback = await tauriApi.loadSession(mainPath)
    h.nativeFails = false
    expect(h.nativeFetches.length).toBeGreaterThan(0) // 确实试过原生
    expect(viaFallback.sessionId).toBe(viaNative.sessionId)
    expect(viaFallback.turns.length).toBe(viaNative.turns.length)
    expect(JSON.stringify(viaFallback)).toBe(JSON.stringify(viaNative))
  })

  it('scope 外（导入的会话）→ 不碰 asset 协议，直接 IPC', async () => {
    const outside = join(root, 'imported.jsonl')
    writeFileSync(outside, user('iu', '2026-04-24T12:00:00.000Z', 'hi', 'imported'), 'utf8')
    h.nativeFetches = []
    const session = await tauriApi.loadSession(outside)
    expect(h.nativeFetches).toEqual([])
    expect(session.sessionId).toBe('imported')
  })
})

/**
 * 菜单「文件 → 导入会话」的宿主→渲染层契约。
 *
 * 这条链路是：Rust 菜单点击 → 系统文件选择框 → `app.emit('session:import', path)`
 * → 渲染层 `listen('session:import')` → `AsyncPage.load(path)`。
 * 菜单点击与系统对话框点不动，但**渲染层这一段胶水**可以用假 `listen` 完整钉住 ——
 * 它也是整条链路上唯一有异步竞态的地方。
 */
describe('onImportSession：菜单导入的渲染层这一段', () => {
  it('订阅 session:import、把 path 原样交给回调，取消时调用底层 unlisten', async () => {
    const before = ev.unlistened
    const got: string[] = []
    const off = tauriApi.onImportSession((p) => got.push(p))
    // 等 listen 的 then 落地（此时 unlisten 才被赋值）
    await new Promise((r) => setTimeout(r, 0))
    expect([...ev.handlers.keys()]).toEqual(['session:import'])

    // 模拟宿主 emit：payload 就是 Rust 侧 emit 的那个 path 字符串
    ev.handlers.get('session:import')!({ payload: '/tmp/x.jsonl' })
    expect(got).toEqual(['/tmp/x.jsonl'])

    off()
    expect(ev.unlistened).toBe(before + 1)
    expect(ev.handlers.size).toBe(0)
  })

  it('listen 还没 resolve 就取消 → 迟到的 unlisten 立刻被调用，不漏订阅', async () => {
    const before = ev.unlistened
    ev.hold = true
    const off = tauriApi.onImportSession(() => {})
    off() // 取消先发生（组件已卸载）
    ev.pending!() // listen 这时才 resolve
    ev.pending = null
    ev.hold = false
    await new Promise((r) => setTimeout(r, 0))
    expect(ev.unlistened).toBe(before + 1)
    expect(ev.handlers.size).toBe(0)
  })
})

/**
 * 保存链路：`chooseSavePath`（只选路径）与 `writeTextFile`（只写盘）两步。
 *
 * 拆成两步是因为**写什么由调用方决定**（报告正文在页面手里，两种报告的文件名也不同），
 * 宿主只该回答「存哪儿」和「写进去」；合成一个方法就得把内容也塞进签名。
 */
describe('保存链路：选路径与写盘分开', () => {
  it('过滤器与默认文件名原样传给对话框，取消时返回 null', async () => {
    h.saveCalls = []
    h.saveResult = null
    const path = await tauriApi.chooseSavePath('记录分析报告-abcd1234.md', [
      { name: 'Markdown', extensions: ['md'] },
    ])
    expect(path).toBeNull() // 取消 —— 调用方据此不写盘
    expect(h.saveCalls).toHaveLength(1)
    expect(h.saveCalls[0].defaultPath).toBe('记录分析报告-abcd1234.md')
    expect(h.saveCalls[0].filters).toEqual([{ name: 'Markdown', extensions: ['md'] }])
  })

  it('选中路径后写盘：内容经真实 write_text 命令落到磁盘', async () => {
    const target = join(h.home, 'export-test.md')
    h.saveResult = target
    h.writes = []
    h.saveCalls = []
    const path = await tauriApi.chooseSavePath('记录分析报告-abcd1234.md', [
      { name: 'Markdown', extensions: ['md'] },
    ])
    expect(path).toBe(target)
    expect(h.saveCalls[0].filters).toEqual([{ name: 'Markdown', extensions: ['md'] }])
    await tauriApi.writeTextFile(target, '# 概览\n')
    expect(h.writes.map((w) => w.path)).toEqual([target])
    expect(readFileSync(target, 'utf8')).toBe('# 概览\n')
    rmSync(target, { force: true })
  })
})
