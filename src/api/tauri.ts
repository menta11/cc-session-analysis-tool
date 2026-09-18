import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { save } from '@tauri-apps/plugin-dialog'
import { buildAnalyzeRequest, buildLogAnalyzeRequest, type AnalyzeRequest } from '../../core/ai/analyzeRequest'
import { runClaudeStream } from '../../core/ai/claudeCli'
import { buildAgentIndex } from '../../core/discovery/agentIndex'
import { linkSubagents } from '../../core/discovery/linkSubagents'
import { linkWorkflows } from '../../core/discovery/linkWorkflows'
import {
  emptyMetaCache,
  parseMetaCache,
  serializeMetaCache,
  type MetaCache,
} from '../../core/discovery/metaCache'
import { readSessionMeta, scanProjects } from '../../core/discovery/scan'
import { fsBridge } from '../../core/fsBridge'
import { dirName, isPathInside, joinPath } from '../../core/paths'
import { parseJsonlText } from '../../core/parser/parse'
import { openDir as openClaudeDir, openTerminal as openClaudeTerminal } from '../../core/terminal'
import type { Session } from '../../core/parser/types'
import type { AnalyzeChunk, AnalyzeResult, AnalyzeTarget, HostApi } from './hostApi'

/**
 * 读一个会话文件（正文）—— **优先走 WebView 的原生文件通道，IPC 只作兜底**。
 *
 * 为什么不用 `fsBridge().readText`（= `invoke('read_text')`）：那条路要把整份文件当作 JSON 字符串
 * 搬过来，两端各做一次转义/反序列化。本机 26MB 会话实测：`invoke` 通道 **639 ms**，
 * 而 asset 协议直读 **19 ms**（+ 解码 16 ms），字节与字符逐个相同 —— 差的是 24MB 走 JSON 的搬运，
 * 不是读盘（同一文件 Node `readFileSync` 只要 31 ms）。切会话的大部分等待就出在这里。
 *
 * 三条约束：
 *   - **只对放行目录内的路径用原生通道**（`assetProtocol.scope` 配的是 `$HOME/.claude/projects/**`）。
 *     菜单导入的任意 .jsonl 在范围外 → 回退 IPC，功能不受影响，只是慢一点。
 *   - **失败必须回退**：协议被关、权限不符、路径含怪字符都可能失败，回退后最坏结果只是慢，
 *     「打不开会话」才是真故障。
 *   - `cache: 'no-store'`：会话文件是**追加写**的，WebView 若缓存了 asset 响应就会给出旧内容
 *     （那是数据错，不是慢）。
 */
async function readSessionText(path: string): Promise<string> {
  if (!isPathInside(await projectsRoot(), path)) return fsBridge().readText(path)
  try {
    const res = await fetch(convertFileSrc(path), { cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return new TextDecoder().decode(await res.arrayBuffer())
  } catch (err) {
    console.warn('[api/tauri] 原生读取失败，回退 IPC：', path, err)
    return fsBridge().readText(path)
  }
}

/**
 * 一次 claude 分析的超时上限（10 分钟）。
 *
 * 松到这种程度是因为真实大会话的整会话分析按分钟计，而超时一旦触发就是白等 —— 比「多等两分钟」
 * 更糟。真正卡死的兜底在 `claudeCli` 的进程侧（超时后必须杀掉子进程，见其测试）。
 */
const ANALYZE_TIMEOUT_MS = 600_000

/**
 * 与迁移前 Electron 主进程的 `sessionCache` 对应。
 *
 * 结构差异值得记一笔：Electron 版把缓存放在**主进程**（渲染层只拿序列化结果），Tauri 版没有
 * Tauri 没有那种「主进程持有缓存」的结构，业务逻辑就在渲染层，所以缓存也放在渲染层。这不影响对外行为，但意味着
 * 渲染层现在会持有完整 Session 对象（含子 agent 树）——内存占用略高于 Electron 版。
 */
interface CachedSession {
  session: Session
  agentIndex: Map<string, string>
  mainFilePath: string
  projectsRoot: string
}
const sessionCache = new Map<string, CachedSession>()

let cachedProjectsRoot: string | null = null

/** `~/.claude/projects`。家目录由 Rust 命令解析（渲染层没有 `os.homedir`）。 */
async function projectsRoot(): Promise<string> {
  if (cachedProjectsRoot !== null) return cachedProjectsRoot
  const home = await invoke<string>('home_dir')
  cachedProjectsRoot = joinPath(home, '.claude', 'projects')
  return cachedProjectsRoot
}

/**
 * 元数据缓存的落盘位置：`<app_data_dir>/meta-cache.json`。目录由 Rust 的 `app_data_dir` 命令
 * 保证存在（首次运行时它可能还没被创建 —— 不能指望代理建的 `logs/`）。
 */
const META_CACHE_FILE = 'meta-cache.json'
let cachedMetaCachePath: string | null = null

async function metaCachePath(): Promise<string> {
  if (cachedMetaCachePath !== null) return cachedMetaCachePath
  cachedMetaCachePath = joinPath(await invoke<string>('app_data_dir'), META_CACHE_FILE)
  return cachedMetaCachePath
}

/**
 * 读缓存。**任何失败都退化成空缓存**（文件不存在、坏 JSON、权限）—— 最坏后果只是重读一遍文件，
 * 而扫描失败是不可接受的。文件不存在时 `read_text` 会报错，这就是首次运行的那条路径。
 */
async function loadMetaCache(): Promise<MetaCache> {
  try {
    return parseMetaCache(await fsBridge().readText(await metaCachePath()))
  } catch {
    return emptyMetaCache()
  }
}

async function saveMetaCache(cache: MetaCache): Promise<void> {
  try {
    await invoke('write_text', { path: await metaCachePath(), contents: serializeMetaCache(cache) })
  } catch (err) {
    // 写不进去只影响下次刷新的速度，不影响本次结果 → 告警不抛（与 Rust 侧代理启动失败的降级一致）
    console.error('[api/tauri] 元数据缓存写入失败：', err)
  }
}

/**
 * 与迁移前 Electron 主进程 `webContents.send('analyze:chunk', …)` 对应：渲染层内的订阅者注册表。
 *
 * 为什么需要这层间接：`HostApi` 的形状是「先订阅、后触发」（`onAnalyzeChunk` 注册全局回调，
 * `analyzeReport` 触发时把 chunk 广播出去）。Tauri 侧没有主进程转发，所以用这个 Set 复刻同一语义。
 * 广播的载荷带 `sessionPath` + `tag`：前者让并发分析的各会话只收自己的，后者让**同一个会话上的
 * 树视图报告与日志表格分析**也各收各的（见 `AnalyzeTag`）。
 */
const analyzeChunkListeners = new Set<(chunk: AnalyzeChunk) => void>()

/**
 * 组装某次分析的提示词。三种目标的输入形状不同，所以在这里就分岔 ——
 * 分岔点收在一处，`analyzeReport` 剩下的部分（取缓存、广播、起 CLI）才只有一条路径。
 */
function analyzePromptOf(target: AnalyzeTarget, cached: CachedSession): AnalyzeRequest {
  if (target.kind === 'log') {
    return buildLogAnalyzeRequest({
      session: cached.session,
      scope: target.scope,
      summary: target.summary,
      projectsRoot: cached.projectsRoot,
      mainFilePath: cached.mainFilePath,
      agentIndex: cached.agentIndex,
    })
  }
  return buildAnalyzeRequest(cached.session, {
    kind: target.kind,
    projectsRoot: cached.projectsRoot,
    mainFilePath: cached.mainFilePath,
    agentIndex: cached.agentIndex,
    focusToolUseId: target.kind === 'node' ? target.focusToolUseId : undefined,
    window: target.kind === 'whole' ? target.window : undefined,
  })
}

/** chunk 归属：日志视图那份报告是 'log'，树视图那两种（整会话 / 节点）都是 'tree' —— 它们同住一个面板 */
function tagOf(kind: AnalyzeTarget['kind']): AnalyzeChunk['tag'] {
  return kind === 'log' ? 'log' : 'tree'
}

export const tauriApi: HostApi = {
  async scanProjects() {
    // 带上元数据缓存：里面已判定的「有没有记录」直接生效，第二次启动起左栏一开始就是干净的
    // （不读任何文件内容）。缓存读失败由 loadMetaCache 兜成空缓存，不影响扫描。
    return scanProjects(await projectsRoot(), await loadMetaCache())
  },

  // 元数据不在这里批量预读：谁被看见谁才读（见 core/discovery/metaLoader.ts）。宿主只提供
  // 「读一个」「读缓存」「写缓存」三个薄动作，队列/去重/命中判定都在 core 里（可单测）。
  readSessionMeta,

  loadMetaCache,

  saveMetaCache,

  async loadSession(path) {
    const sessionDir = path.replace(/\.jsonl$/, '')
    const index = await buildAgentIndex(sessionDir)
    const session = parseJsonlText(await readSessionText(path), path)
    // 子 transcript 同样走原生通道（一个会话可能有几百个子 agent 文件，IPC 搬运在里面是大头）。
    // `subagent: true` 是子 transcript 的**固有属性**（它的每一条记录都带 `isSidechain: true`），
    // 不是可选偏好：不传的话解析会把全部 assistant 记录判为非主线 —— 子会话只剩一句用户提问，
    // 钻取子表与节点诊断同时变空。
    const parseChild = async (p: string): Promise<Session> =>
      parseJsonlText(await readSessionText(p), p, { subagent: true })
    await linkSubagents(session, index, parseChild)
    // workflow 要另接一次：它的耗时在 `<sessionDir>/workflows/<runId>.json` 里，它的子 agent 也不由
    // 任何一条 Agent 调用引用（见 core/discovery/linkWorkflows.ts）。必须在 linkSubagents 之后 ——
    // 它会给 workflow 的每个子 agent 再跑一遍委派链接。
    await linkWorkflows(session, sessionDir, index, parseChild)
    sessionCache.set(path, {
      session,
      agentIndex: index,
      mainFilePath: path,
      // 基准 = 会话所在目录（与 迁移前 Electron 壳的 index.ts（已删除） 的 dirname(sessionDir) 一致）
      projectsRoot: dirName(sessionDir),
    })
    return session
  },

  async analyzeReport(sessionPath, target): Promise<AnalyzeResult> {
    const cached = sessionCache.get(sessionPath)
    if (!cached) {
      return { ok: false, text: '', error: '会话未加载，请重新选择会话' }
    }
    let req: AnalyzeRequest
    try {
      req = analyzePromptOf(target, cached)
    } catch (err) {
      // 与迁移前同一文案，便于两边对照
      return {
        ok: false,
        text: '',
        error: '组装提示词失败：' + (err instanceof Error ? err.message : String(err)),
      }
    }
    // 提示词在渲染层组装；真正起 claude 子进程的活经 ProcBridge 落到 Rust。
    const tag = tagOf(target.kind)
    return runClaudeStream(
      req.userMessage,
      req.systemPrompt,
      (text) => {
        for (const l of analyzeChunkListeners) l({ sessionPath, tag, text })
      },
      { timeoutMs: ANALYZE_TIMEOUT_MS },
    )
  },

  onAnalyzeChunk(cb) {
    analyzeChunkListeners.add(cb)
    return () => {
      analyzeChunkListeners.delete(cb)
    }
  },

  async chooseSavePath(name, filters) {
    // 保存对话框走官方 dialog 插件（JS 侧 API 比 Rust 侧的回调式 API 直白）；
    // 取消返回 null —— 与迁移前 Electron showSaveDialog 的 canceled 分支一致。
    return await save({ defaultPath: name, filters })
  },

  async writeTextFile(path, text) {
    // 写盘仍走我们自己的 write_text 原语，把 fs 面收敛在一处（见 core/fsBridge 的约定）
    await invoke('write_text', { path, contents: text })
  },

  async openTerminal(claudeId) {
    // 命令构造（含 Linux 的终端探测）在 core/terminal.ts（纯函数、有测试）；
    // 这里只是把「起进程」经 ProcBridge 落到 Rust 的 detached spawn。
    return openClaudeTerminal(claudeId)
  },

  async openDir(dir) {
    return openClaudeDir(dir)
  },

  onImportSession(cb) {
    // 菜单「文件 → 导入会话」的推送路径：Rust 侧（src-tauri/src/shell.rs）弹系统文件选择框，
    // 选中的路径经 `app.emit('session:import', path)` 推过来。事件名与 Rust 的
    // `EVENT_IMPORT_SESSION` 是同一个字面量，由 shell.rs 的单测用 `include_str!` 交叉断言。
    //
    // 契约形状：`HostApi` 要求**同步返回**取消订阅函数（迁移前 Electron 的 `ipcRenderer.on` 就是同步注册），
    // 而 Tauri 的 `listen` 是异步的（返回 `Promise<UnlistenFn>`）。这里用
    // 「同步登记取消意图 + 异步补上真正的 unlisten」复刻同一契约：组件卸载时同步调用返回的函数
    // 不会漏订阅 —— 若 listen 在取消之后才 resolve，立刻把它解绑。
    let unlisten: (() => void) | null = null
    let cancelled = false
    void listen<string>('session:import', (event) => cb(event.payload))
      .then((un) => {
        if (cancelled) un()
        else unlisten = un
      })
      .catch((err) => {
        console.error('[api/tauri] 订阅 session:import 失败：', err)
      })
    return () => {
      cancelled = true
      unlisten?.()
      unlisten = null
    }
  },

  async getMonitorPort() {
    // 代理在 Rust 侧随应用启动（lib.rs 的 setup）；0 = 尚未就绪（MonitorPage 会显示"未就绪"并重试）
    return invoke<number>('monitor_port')
  },

  async pingMonitor() {
    // 探测必须放在 Rust 侧：渲染页与代理不同源，直连会被 CORS 拦（与迁移前 Electron 把探测下沉到主进程同理）
    return invoke<boolean>('monitor_ping')
  },

  async enterFloatMode() {
    // dashboard 的悬浮框按钮：iframe 里拿不到宿主桥，所以它 postMessage 给 MonitorPage，
    // 由 MonitorPage 调到这里（见 src/pages/MonitorPage.tsx）。
    //
    // 落到 `src-tauri/src/float_window.rs` 的 inlined plugin：建/显示悬浮窗（透明+置顶+无边框，
    // 加载代理托管的 mini.html）并隐藏主窗口。命令必须带 `plugin:float|` 前缀 ——
    // 远程 origin 的页面拿不到应用命令，悬浮窗那条路径只能走插件命令（见该模块头）。
    await invoke('plugin:float|enter')
  },
}
