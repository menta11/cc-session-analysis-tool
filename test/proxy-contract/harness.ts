/**
 * Stage 1.1 / 1.3 共用黑盒测试脚手架。
 *
 * 设计要点：
 * - 被测服务（SUT）以**子进程**启动，只通过 HTTP 交互。这样同一批契约用例能不加改动地
 *   跑在 Node 版 `proxy.js`（黄金基准）和 Rust spike 上。
 * - 家目录被沙箱化到临时目录，绝不触碰开发者真实的 `~/.claude/settings.json`：`HOME` **和**
 *   `USERPROFILE` 都得设 —— Node 的 `os.homedir()` 在 Windows 上只认后者（见 buildEnv）。
 * - `assertRealConfigUntouched()` 兜底：真配置一旦被改写就当场抛错，不靠注释里的君子协定。
 * - 端口全部动态分配（先 `listen(0)` 取空闲端口再关掉），配合 vitest 的文件级并发不会撞车。
 * - 继承的环境变量里 `ANTHROPIC_*` / `CC_MONITOR_*` 一律先剔除，避免本机真实中转站配置
 *   泄漏进用例，让断言不确定。
 */
import {
  createServer as createHttpServer,
  request as nodeHttpRequest,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http'
import { createServer as createNetServer, type AddressInfo } from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
export const REPO_ROOT = resolve(HERE, '../..')
const PROXY_JS = join(REPO_ROOT, 'vendor/cc-monitor/proxy.js')
// Stage 2.5：Rust 实现已从 spike 提升为 src-tauri 里的正式模块，契约测试改为驱动**它的**
// 独立 bin（与应用内启动共用同一份实现，见 src-tauri/src/proxy/mod.rs）。
// 平台后缀必须自己补：Node 的 `existsSync` 在 Windows 上**不会**自动补 `.exe`，
// 漏了它 `rustSut.available()` 就恒为 false —— 而失败方式是**静默跳过**（套件照常绿）。
const DEFAULT_RUST_BIN = join(
  REPO_ROOT,
  `src-tauri/target/release/proxy-standalone${process.platform === 'win32' ? '.exe' : ''}`,
)

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- 端口 / 等待

export function getFreePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createNetServer()
    s.once('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo
      s.close(() => res(port))
    })
  })
}

/** 轮询直到 pred 为真；超时抛出带 msg 的错误（把「没发生」变成可读的失败原因）。 */
export async function waitFor(pred: () => boolean, timeoutMs: number, msg: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return
    await sleep(10)
  }
  throw new Error(`waitFor 超时 (${timeoutMs}ms): ${msg}`)
}

function listen(server: Server | ReturnType<typeof createNetServer>, port: number): Promise<void> {
  return new Promise((res, rej) => {
    server.once('error', rej)
    server.listen(port, '127.0.0.1', () => res())
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((res) => server.close(() => res()))
}

// ---------------------------------------------------------------- 假上游

export interface UpstreamRequest {
  method: string
  /** 上游收到的原始 url（含 query，含 target 的 path 前缀） */
  url: string
  headers: IncomingHttpHeaders
  body: Buffer
}

export type UpstreamHandler = (req: UpstreamRequest, res: ServerResponse) => void | Promise<void>

export interface FakeUpstream {
  port: number
  origin: string
  /** 按到达顺序记录的全部请求 */
  requests: UpstreamRequest[]
  /** 替换后续请求的应答逻辑 */
  on(handler: UpstreamHandler): void
  /** 最近一次请求（方便断言；无请求则抛错） */
  last(): UpstreamRequest
  close(): Promise<void>
}

/**
 * 假上游：先把请求体读完整，再交给 handler 自行写响应。
 * handler 拿到的 `res` 是原始 ServerResponse，可以精确控制 writeHead / 分片 write / destroy，
 * 这正是 SSE 与「中途断开」用例需要的控制力。
 */
export async function startFakeUpstream(): Promise<FakeUpstream> {
  let handler: UpstreamHandler = (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('default')
  }
  const requests: UpstreamRequest[] = []

  const server = createHttpServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const rec: UpstreamRequest = {
        method: req.method || '',
        url: req.url || '',
        headers: req.headers,
        body: Buffer.concat(chunks),
      }
      requests.push(rec)
      Promise.resolve(handler(rec, res)).catch((err) => {
        try {
          res.destroy(err as Error)
        } catch {
          /* 上游已断开，忽略 */
        }
      })
    })
  })

  await listen(server, 0)
  const port = (server.address() as AddressInfo).port
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    requests,
    on(h) {
      handler = h
    },
    last() {
      const r = requests[requests.length - 1]
      if (!r) throw new Error('假上游没收到任何请求')
      return r
    },
    close: () => closeServer(server),
  }
}

// ---------------------------------------------------------------- HTTP 客户端

export interface HttpResponse {
  status: number
  headers: IncomingHttpHeaders
  body: Buffer
}

export interface RequestOptions {
  method?: string
  headers?: Record<string, string | string[]>
  body?: Buffer | string
  timeoutMs?: number
}

function toBodyBuffer(body: Buffer | string | undefined): Buffer | undefined {
  if (body === undefined) return undefined
  return Buffer.isBuffer(body) ? body : Buffer.from(body)
}

/** 一次性收集响应体。 */
export function httpRequest(urlStr: string, opts: RequestOptions = {}): Promise<HttpResponse> {
  return new Promise((res, rej) => {
    const u = new URL(urlStr)
    const body = toBodyBuffer(opts.body)
    const req = nodeHttpRequest(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: opts.method || 'GET',
        headers: opts.headers,
      },
      (r) => {
        const chunks: Buffer[] = []
        r.on('data', (c: Buffer) => chunks.push(c))
        r.on('end', () => res({ status: r.statusCode || 0, headers: r.headers, body: Buffer.concat(chunks) }))
        r.on('error', rej)
      },
    )
    req.on('error', rej)
    const t = opts.timeoutMs ?? 8000
    req.setTimeout(t, () => req.destroy(new Error(`客户端超时 ${t}ms`)))
    if (body) req.write(body)
    req.end()
  })
}

/** 取 JSON（`/config/baseurl` 之类内部端点用）。 */
export async function httpGetJson<T = any>(urlStr: string, opts: RequestOptions = {}): Promise<T> {
  const r = await httpRequest(urlStr, opts)
  return JSON.parse(r.body.toString('utf8')) as T
}

export interface StreamingResponse {
  status: number
  headers: IncomingHttpHeaders
  /** 活数组：流进行中就能读到已到达的分片 */
  chunks: Buffer[]
  /** 流收敛（end / error / 提前 close）后 resolve；永不 reject */
  settled: Promise<{ ended: boolean; error?: Error }>
}

/**
 * 流式响应句柄。给两类用例用：
 * - C6：需要「客户端已收到第 1 片」作为信号，才放行上游写第 2 片（证明是真流式非攒齐）。
 * - C10：上游中途断开时，需要观察请求是否在超时内收敛（而不是挂死）。
 */
export function requestStreaming(urlStr: string, opts: RequestOptions = {}): Promise<StreamingResponse> {
  return new Promise((res, rej) => {
    const u = new URL(urlStr)
    const body = toBodyBuffer(opts.body)
    const req = nodeHttpRequest(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: opts.method || 'GET',
        headers: opts.headers,
      },
      (r) => {
        const chunks: Buffer[] = []
        r.on('data', (c: Buffer) => chunks.push(c))
        const settled = new Promise<{ ended: boolean; error?: Error }>((done) => {
          let finished = false
          const finish = (v: { ended: boolean; error?: Error }) => {
            if (!finished) {
              finished = true
              done(v)
            }
          }
          r.on('end', () => finish({ ended: true }))
          r.on('error', (e: Error) => finish({ ended: false, error: e }))
          r.on('aborted', () => finish({ ended: false, error: new Error('aborted') }))
          r.on('close', () =>
            finish(
              r.complete
                ? { ended: true }
                : { ended: false, error: new Error('上游连接在响应完整前关闭') },
            ),
          )
        })
        res({ status: r.statusCode || 0, headers: r.headers, chunks, settled })
      },
    )
    req.on('error', rej)
    const t = opts.timeoutMs ?? 8000
    req.setTimeout(t, () => req.destroy(new Error(`客户端超时 ${t}ms`)))
    if (body) req.write(body)
    req.end()
  })
}

// ---------------------------------------------------------------- SSE 订阅（推送流）

/** 一条已解析的 SSE 帧。 */
export interface SseFrame {
  /** 帧原文（不含结尾的分隔空行）；`: ping` 注释帧的原文也在这里 */
  raw: string
  /** `event:` 事件名；无则 null */
  event: string | null
  /** `data:` 行按 SSE 规范以 `\n` 拼接；无则 null */
  data: string | null
  /** SSE 注释行内容（去掉前导 `:` 与两边空白，如 `ping`）；非注释帧为 null */
  comment: string | null
}

export interface SseConnection {
  /** 响应状态码；收到响应头前为 0（Node 在首个 `write` 前不 flush SSE 响应头） */
  status: number
  headers: IncomingHttpHeaders | null
  /** 活数组：帧随到达追加，等待期间可随时读 */
  frames: SseFrame[]
  /** 连接级错误（SUT 被停掉 / 连接被对端关闭）；未发生为 null */
  error: Error | null
  /** 等至少 n 帧到达；超时抛出（把已到帧摘要带出来，避免只剩一句「超时」） */
  waitForFrames(n: number, timeoutMs: number, msg?: string): Promise<void>
  /** 等第一个满足 pred 的帧；超时语义同上 */
  waitForFrame(pred: (f: SseFrame) => boolean, timeoutMs: number, msg: string): Promise<SseFrame>
  /** 等对端把流关闭（如详情流推完 `{done:true}` 后 res.end()）。 */
  waitForClose(timeoutMs: number, msg?: string): Promise<void>
  /** 关闭连接（幂等）。用例**必须**在 finally 里调用，否则套件退不出去。 */
  close(): void
}

/**
 * 把一块原始字节解析成一帧。
 *
 * 只在**完整帧**上做 utf-8 解码（切帧在字节层按 `\n\n` 找），所以多字节字符跨 chunk
 * 不会被解成 U+FFFD —— 事件帧的 message 里就含中文（「上游返回 404 Not Found」）。
 */
function parseSseBlock(block: Buffer): SseFrame {
  const raw = block.toString('utf8')
  const lines = raw.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
  let event: string | null = null
  const dataLines: string[] = []
  const comments: string[] = []
  for (const line of lines) {
    if (line.startsWith(':')) comments.push(line.slice(1).trim())
    else if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
  }
  return {
    raw,
    event,
    data: dataLines.length > 0 ? dataLines.join('\n') : null,
    comment: comments.length > 0 ? comments.join('\n') : null,
  }
}

/**
 * 打开一条 SSE 连接并**增量**解析帧（推送流用例用）。
 *
 * 两个刻意的设计：
 * - **不用 `requestStreaming`**：那条路径要等响应体 `end`，而推送流靠 15s 心跳吊着，
 *   正常用例里永远不会 end，用它必然挂到客户端超时。
 * - **句柄在收到响应头之前就返回**：Node 的 SSE handler 在首个 `res.write` 前不 flush 响应头
 *   （空积压时首个字节就是 15s 心跳），若在这里 `await` 响应头，空积压用例会被白拖 15s。
 *   所以句柄立即返回，由调用方用**有界**的 `waitFor*` 取帧；`close()` 必须被调用。
 */
export function openSse(urlStr: string, opts: RequestOptions = {}): SseConnection {
  const u = new URL(urlStr)
  const frames: SseFrame[] = []
  const conn: SseConnection = {
    status: 0,
    headers: null,
    frames,
    error: null,
    waitForFrames,
    waitForFrame,
    waitForClose,
    close,
  }
  let buf = Buffer.alloc(0)
  let closed = false
  let peerClosed = false

  const req = nodeHttpRequest(
    {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: { accept: 'text/event-stream', ...opts.headers },
    },
    (r) => {
      conn.status = r.statusCode || 0
      conn.headers = r.headers
      r.on('data', (c: Buffer) => {
        buf = Buffer.concat([buf, c])
        let idx: number
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.subarray(0, idx)
          buf = buf.subarray(idx + 2)
          if (block.length === 0) continue
          frames.push(parseSseBlock(block))
        }
      })
      r.on('error', (e: Error) => {
        conn.error = e
      })
      r.on('end', () => {
        peerClosed = true
      })
      r.on('close', () => {
        peerClosed = true
        if (!r.complete && !conn.error) conn.error = new Error('SSE 连接在流正常结束前被关闭')
      })
    },
  )
  req.on('error', (e: Error) => {
    conn.error = e
  })
  req.end()

  function close(): void {
    if (closed) return
    closed = true
    req.destroy()
  }

  /** 超时/出错时把已到帧摘要带出来 —— 否则失败只剩一句「超时」，没法诊断。 */
  function describeSeen(): string {
    const brief = frames.slice(-8).map((f) =>
      f.comment !== null ? `:${f.comment}` : f.event !== null ? `event:${f.event}` : (f.data || '').slice(0, 80),
    )
    return `已到 ${frames.length} 帧：${JSON.stringify(brief)}`
  }

  async function waitForFrames(n: number, timeoutMs: number, msg = '等待 SSE 帧'): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (frames.length >= n) return
      if (conn.error) throw new Error(`${msg}：连接出错 ${conn.error.message}；${describeSeen()}`)
      await sleep(10)
    }
    throw new Error(`${msg}：${timeoutMs}ms 内只等到 ${frames.length}/${n} 帧；${describeSeen()}`)
  }

  async function waitForFrame(
    pred: (f: SseFrame) => boolean,
    timeoutMs: number,
    msg: string,
  ): Promise<SseFrame> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const hit = frames.find(pred)
      if (hit) return hit
      if (conn.error) throw new Error(`${msg}：连接出错 ${conn.error.message}；${describeSeen()}`)
      await sleep(10)
    }
    throw new Error(`${msg}：${timeoutMs}ms 内未出现；${describeSeen()}`)
  }

  async function waitForClose(timeoutMs: number, msg = '等待 SSE 连接被对端关闭'): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (peerClosed) return
      await sleep(10)
    }
    throw new Error(`${msg}：${timeoutMs}ms 内连接未关闭；${describeSeen()}`)
  }

  return conn
}

// ---------------------------------------------------------------- SUT（被测服务）

export interface SutOptions {
  /** 上游 base URL，写入 CC_MONITOR_TARGET。不传则**不设**该变量（优先级用例需要空场） */
  upstream?: string
  /** 覆盖 CC_MONITOR_PORT；不传则自动取空闲端口 */
  port?: number
  /** 预置 settings.json 的原始文本；不传则不创建该文件 */
  settings?: string
  /**
   * 需要把「实际监听的端口」写进 settings.json 时用它（如 C12f 的"自指"用例）。
   * 传它就不要用 `settings` —— 端口由 launchSut 分配，这样端口冲突重试时能一起换。
   */
  settingsFor?: (port: number) => string
  /** 预置 cc-monitor-state.json 的原始文本；不传则不创建该文件 */
  state?: string
  /** 额外/覆盖的环境变量；值为 undefined 表示删除 */
  env?: Record<string, string | undefined>
}

export interface SutHandle {
  port: number
  /** `http://127.0.0.1:<port>` */
  origin: string
  /** `http://localhost:<port>` —— proxy.js 里 PROXY_BASEURL 的形态 */
  proxyUrl: string
  home: string
  settingsPath: string
  statePath: string
  stdout(): string
  stderr(): string
  stop(): Promise<void>
}

export interface SutDriver {
  name: string
  /** 二进制/依赖是否就绪；false 时调用方应 skip */
  available(): boolean
  unavailableReason?(): string
  start(opts: SutOptions): Promise<SutHandle>
}

/** 继承环境里必须剔除的变量：避免本机真实中转站 / 监控配置污染用例。 */
const SANITIZED_ENV = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CC_MONITOR_TARGET',
  'CC_MONITOR_PORT',
  'CC_MONITOR_LOOP_BYPASS',
  'CC_MONITOR_LOG_DIR',
  'CC_MONITOR_DEBUG',
]

/**
 * 沙箱要盖住的家目录变量。**两个都得设**：
 * - `HOME` 只在 POSIX 生效。Node 的 `os.homedir()` 在 Windows 上读的是 `USERPROFILE`
 *   （它没定义才退到 `HOMEDRIVE`+`HOMEPATH`），**完全不看 `HOME`** —— 只设 `HOME` 的话
 *   被测的 `proxy.js` 会解析到开发者真实家目录，进而读写真实的 `~/.claude/settings.json`。
 * - Rust 侧 `proxy/env.rs` 反过来：`HOME` 优先、`USERPROFILE` 兜底。两个都设才同时覆盖。
 */
const HOME_ENV_KEYS = ['HOME', 'USERPROFILE'] as const

export function buildEnv(home: string, logDir: string, extra: Record<string, string | undefined>) {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (SANITIZED_ENV.includes(k)) continue
    env[k] = v
  }
  for (const key of HOME_ENV_KEYS) env[key] = home
  env.CC_MONITOR_LOG_DIR = logDir
  env.CC_MONITOR_DEBUG = '0'
  env.CC_MONITOR_LOOP_BYPASS = '1'
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k]
    else env[k] = v
  }
  return env
}

// ---------------------------------------------------------------- 真实配置护栏

/** 开发者的真实配置文件 —— 被测进程**永远**不该写到它们。 */
const REAL_CONFIG_PATHS = ['.claude/settings.json', '.claude/cc-monitor-state.json'].map((p) =>
  join(homedir(), p),
)

/** 只描述"变了什么"，不回显文件内容 —— 真实 settings.json 里可能有凭证。 */
function describeConfig(text: string | null): string {
  if (text === null) return '(不存在)'
  const baseUrl = readBaseUrl(text)
  return baseUrl === null ? `${text.length} 字节` : `${text.length} 字节，ANTHROPIC_BASE_URL=${baseUrl}`
}

function readConfig(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** 进程启动时的快照。每个测试文件各自 import，各自留一份基线。 */
const REAL_CONFIG_SNAPSHOT = REAL_CONFIG_PATHS.map((p) => [p, readConfig(p)] as const)

/**
 * 快照里有没有路径被改写了？返回描述差异的文案，没被动过则返回 `null`。
 *
 * 拆成纯函数是为了让"判据能失败"可验证：反例用例喂它一对临时文件即可，
 * 不必去改开发者真实配置（见 sandbox-home.test.ts）。
 */
export function findConfigDrift(
  snapshot: ReadonlyArray<readonly [string, string | null]>,
): string | null {
  for (const [path, before] of snapshot) {
    const after = readConfig(path)
    if (after === before) continue
    return `${path}\n  运行前：${describeConfig(before)}\n  现在：  ${describeConfig(after)}`
  }
  return null
}

/**
 * 真实配置有没有被这轮 SUT 运行改写？有就抛错。
 *
 * 这是**兜底**而不是主修（主修是 buildEnv 里把 `USERPROFILE` 一起沙箱化）：这类逃逸的表现是
 * "测试照常跑绿、开发者配置悄悄变了"，光靠人眼看不出。之所以按「启动快照 → 销毁时比对」做，
 * 是因为它对逃逸**途径**不敏感 —— 就算将来从别的路径漏出去（比如 `extra` 把家目录变量删了），
 * 也一样能拦住。
 *
 * 代价：跑测试期间如果你同时开着 cc-monitor 本体并切换监控，会误报。宁可误报，不可静默改配置。
 */
export function assertRealConfigUntouched(): void {
  const drift = findConfigDrift(REAL_CONFIG_SNAPSHOT)
  if (drift === null) return
  throw new Error(
    `[harness] 开发者真实配置被测试改写了：\n${drift}\n` +
      `沙箱没兜住 —— 被测进程正在拿真实家目录当沙箱用。\n` +
      `先查 buildEnv 的 HOME_ENV_KEYS。`,
  )
}

/** launchSut 单次尝试所需的上下文（临时目录在重试之间复用） */
interface LaunchCtx {
  driverName: string
  argv: string[]
  opts: SutOptions
  dir: string
  home: string
  logDir: string
  settingsPath: string
  statePath: string
}

/**
 * 启动子进程 + 沙箱 HOME + 就绪探测；两个 driver 共用。
 *
 * **带重试**：端口是先在本进程里探到「空闲」再交给子进程去绑的，这中间有窗口 ——
 * 并发用例（vitest 用多进程跑不同测试文件）可能拿到同一个刚释放的临时端口，于是子进程按契约
 * 「端口被占用即报错退出」而失败。这不是被测实现的问题，所以这里换端口重试（最多 3 次）；
 * 三次都失败才把真实错误抛出去，不静默吞。
 */
async function launchSut(driverName: string, argv: string[], opts: SutOptions): Promise<SutHandle> {
  const dir = mkdtempSync(join(tmpdir(), 'ccmon-sut-'))
  const home = join(dir, 'home')
  const logDir = join(dir, 'logs')
  mkdirSync(join(home, '.claude'), { recursive: true })
  mkdirSync(logDir, { recursive: true })

  const ctx: LaunchCtx = {
    driverName,
    argv,
    opts,
    dir,
    home,
    logDir,
    settingsPath: join(home, '.claude', 'settings.json'),
    statePath: join(home, '.claude', 'cc-monitor-state.json'),
  }

  const MAX_ATTEMPTS = 3
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await launchOnce(ctx)
    } catch (e) {
      lastError = e
      if (attempt < MAX_ATTEMPTS) await sleep(150)
    }
  }
  rmSync(dir, { recursive: true, force: true })
  throw lastError
}

async function launchOnce(ctx: LaunchCtx): Promise<SutHandle> {
  const { driverName, argv, opts, dir, home, logDir, settingsPath, statePath } = ctx
  const port = opts.port ?? (await getFreePort())

  // 每次尝试都重写配置文件：上一次失败的进程可能已经改写过它。
  // `settingsFor(port)` 让「端口」只有一个来源 —— 需要把端口写进 settings.json 的用例
  // （C12f 自指跳过）不必在测试里预先分配端口，从而能跟着重试一起换端口。
  if (opts.settingsFor) writeFileSync(settingsPath, opts.settingsFor(port), 'utf8')
  else if (opts.settings !== undefined) writeFileSync(settingsPath, opts.settings, 'utf8')
  if (opts.state !== undefined) writeFileSync(statePath, opts.state, 'utf8')

  const env = buildEnv(home, logDir, {
    CC_MONITOR_TARGET: opts.upstream,
    CC_MONITOR_PORT: String(port),
    ...opts.env,
  })

  const child: ChildProcess = spawn(argv[0], argv.slice(1), { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout?.on('data', (c: Buffer) => {
    out = (out + c.toString()).slice(-20_000)
  })
  child.stderr?.on('data', (c: Buffer) => {
    err = (err + c.toString()).slice(-20_000)
  })

  let exited: { code: number | null; signal: string | null } | null = null
  child.on('exit', (code, signal) => {
    exited = { code, signal }
  })

  const origin = `http://127.0.0.1:${port}`

  // 就绪探测：轮询 /status。子进程提前退出 → 立刻失败并把 stderr 带出来，
  // 否则只会看到一个莫名的 10s 超时。
  const deadline = Date.now() + 10_000
  let ready = false
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(
        `[${driverName}] SUT 启动即退出 code=${exited.code} signal=${exited.signal}\n--- stderr ---\n${err}\n--- stdout ---\n${out}`,
      )
    }
    try {
      const r = await httpRequest(`${origin}/status`, { timeoutMs: 1000 })
      if (r.status === 200) {
        ready = true
        break
      }
    } catch {
      /* 还没监听，继续等 */
    }
    await sleep(50)
  }
  /** 先 SIGTERM，3s 不退再 SIGKILL，并**等到进程真的退出**——否则残留进程会占着端口，
   *  在 base URL 矩阵这种「一个用例一个进程」的场景里会互相污染。 */
  const killChild = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const once = () => new Promise<void>((res) => child.once('exit', () => res()))
    child.kill('SIGTERM')
    const graceful = await Promise.race([once().then(() => true), sleep(3000).then(() => false)])
    if (!graceful) {
      child.kill('SIGKILL')
      await Promise.race([once(), sleep(2000)])
    }
  }

  if (!ready) {
    // 不在这里删临时目录：launchSut 的包装层可能还要用同一个目录重试一次
    await killChild()
    throw new Error(`[${driverName}] SUT 10s 内未就绪\n--- stderr ---\n${err}\n--- stdout ---\n${out}`)
  }

  const stop = async () => {
    await killChild()
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响结论 */
    }
    // 每例销毁时校验一次：逃逸当场失败，不留给下一个用例、也不留给开发者去发现
    assertRealConfigUntouched()
  }

  return {
    port,
    origin,
    proxyUrl: `http://localhost:${port}`,
    home,
    settingsPath,
    statePath,
    stdout: () => out,
    stderr: () => err,
    stop,
  }
}

/** 黄金基准：Node 版 proxy.js。 */
export const nodeSut: SutDriver = {
  name: 'node(vendor/cc-monitor/proxy.js)',
  available: () => existsSync(PROXY_JS),
  unavailableReason: () => `找不到 ${PROXY_JS}`,
  start: (opts) => launchSut(nodeSut.name, [process.execPath, PROXY_JS], opts),
}

/** Rust spike 二进制路径（可用 SPIKE_BIN 覆盖）。 */
export function rustBinaryPath(): string {
  return process.env.SPIKE_BIN ? resolve(process.env.SPIKE_BIN) : DEFAULT_RUST_BIN
}

export const rustSut: SutDriver = {
  name: 'rust(ccsa-proxy)',
  available: () => existsSync(rustBinaryPath()),
  unavailableReason: () =>
    `未找到 Rust proxy 二进制 ${rustBinaryPath()}；先跑 (cd src-tauri && cargo build --release --bin proxy-standalone --features standalone)`,
  start: (opts) => launchSut(rustSut.name, [rustBinaryPath()], opts),
}

// ---------------------------------------------------------------- settings.json 素材

/** 一份"像真的" settings.json：除 ANTHROPIC_BASE_URL 外还有别的 key，带缩进与换行。 */
export function settingsJson(baseUrl: string | null): string {
  const env: Record<string, string> = { SOME_OTHER_VAR: 'keep-me' }
  if (baseUrl !== null) env.ANTHROPIC_BASE_URL = baseUrl
  return JSON.stringify({ env, permissions: { allow: ['Bash(ls:*)'] }, model: 'claude-sonnet-4-5' }, null, 2) + '\n'
}

/** 从 settings.json 原文里抠出 ANTHROPIC_BASE_URL 的当前值（测试侧独立解析，不复用实现的正则）。 */
export function readBaseUrl(settingsText: string): string | null {
  const m = settingsText.match(/"ANTHROPIC_BASE_URL"\s*:\s*"([^"]*)"/)
  return m ? m[1] : null
}
