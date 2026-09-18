import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { setProcBridge, type ExecTextResult, type ProcBridge, type RunLinesResult } from '../../core/procBridge'

/** Rust 侧返回形状（见 src-tauri/src/claude.rs）。`Option<String>` 序列化成 null。 */
interface RustRunLinesOutcome {
  ok: boolean
  error: string | null
  stderr: string
}
interface RustExecTextOutcome {
  ok: boolean
  out: string
  error: string | null
}

/**
 * 平台判别。
 *
 * 为什么从 userAgent 判而不是问 Rust：`ProcBridge.platform` 是**同步属性**，而 `invoke` 是异步的。
 * 它只用于在 `where`（Windows）和 `which`（其它）之间二选一，userAgent 足够可靠。
 */
function detectPlatform(): string {
  if (typeof navigator === 'undefined') return 'linux'
  const ua = navigator.userAgent
  if (/Windows/i.test(ua)) return 'win32'
  if (/Mac OS X|Macintosh/i.test(ua)) return 'darwin'
  return 'linux'
}

/** 每次调用一个唯一事件名，避免并发调用的行输出串到一起（等价于 Node 侧每次 spawn 独立的流）。 */
function newStreamId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

/**
 * `ProcBridge` 的 Tauri 实现。
 *
 * 流式行的链路：先 `listen('proc:line:<id>')` **再** `invoke('run_lines')` —— 顺序不能反，
 * 否则 Rust 在监听装好之前发出的行会丢。返回值里带最终退出状态；行本身经事件到达。
 */
export const tauriProcBridge: ProcBridge = {
  platform: detectPlatform(),

  async runLines(cmd, args, stdinText, onLine, opts = {}) {
    const streamId = newStreamId()
    const unlisten = await listen<string>(`proc:line:${streamId}`, (e) => onLine(e.payload))
    try {
      const r = await invoke<RustRunLinesOutcome>('run_lines', {
        streamId,
        cmd,
        args,
        stdinText,
        // Rust 侧是 Option<u64> / Option<String>：显式传 null 而不是省略，语义更清楚
        timeoutMs: opts.timeoutMs ?? null,
        label: opts.label ?? null,
      })
      const out: RunLinesResult = { ok: r.ok, error: r.error ?? undefined, stderr: r.stderr }
      return out
    } finally {
      unlisten()
    }
  },

  async execText(cmd, args) {
    const r = await invoke<RustExecTextOutcome>('exec_text', { cmd, args })
    const out: ExecTextResult = { ok: r.ok, out: r.out, error: r.error ?? undefined }
    return out
  },

  /**
   * 渲染层没有 `process.cwd()`，向 Rust 要家目录。
   * 与 `src-tauri/src/lib.rs` 里「把进程 cwd 固定为 home」取值同源 ——
   * 保证分析用的 claude 与 resume 终端落在同一目录（否则 resume 找不到会话）。
   */
  defaultCwd() {
    return invoke<string>('home_dir')
  },

  async spawnDetached(exe, args, cwd) {
    try {
      await invoke('spawn_detached', { exe, args, cwd })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  },
}

/** 安装 Tauri 版 ProcBridge（由 `src/api/index.ts` 在检测到 Tauri 时调用一次）。 */
export function installTauriProcBridge(): void {
  setProcBridge(tauriProcBridge)
}
