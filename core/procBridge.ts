/**
 * 进程桥 —— `core/` 与宿主之间**唯一**的「起子进程」边界。
 *
 * 为什么需要（与 `core/fsBridge.ts` 同一套理由）：`core/` 要同时跑在 Node 侧（有
 * `node:child_process`）和 Tauri 渲染层（没有 Node），所以子进程能力必须由宿主注入。
 *
 * 分工原则（Stage 2 架构决定 3 的延续）：**只替换 IO 边界，不搬业务逻辑**。
 * 于是 `core/ai/claudeCli.ts` 里真正有价值的那些东西留在 TS —— stream-json 逐行解析
 * （`parseStreamJsonLine`）、stdin 组装（`buildStdin`）、`--help` 能力探测的判据、以及
 * 「delta 与整消息二选一，避免重复」的策略。这些都有测试。
 *
 * 语义约定（各实现必须一致）：
 *   - `runLines`：写 `stdinText` → 关闭 stdin → **按行**回调 stdout（`\r?\n` 分隔，末行无换行也要回调）
 *     → 解析退出码。`timeoutMs` 到期必须杀掉子进程并返回 `ok:false`（而不是永远挂着）。
 *   - `execText`：跑一次性命令并收集 stdout+stderr。**非零退出码不算失败**（对齐 `spawnSync`
 *     的语义 —— `which nonexistent` 就是非零退出，调用方靠 out 是否为空来判断）。
 *   - `platform`：`'win32' | 'darwin' | 'linux'`，用于选择 `where` / `which`。
 */
export interface RunLinesOptions {
  timeoutMs?: number
  /** 面向用户的错误文案里用的名字（如 'claude'），不传则用命令名 */
  label?: string
}

export interface RunLinesResult {
  ok: boolean
  error?: string
  stderr: string
}

export interface ExecTextResult {
  ok: boolean
  /** stdout + stderr 拼接（对齐原实现 `(r.stdout||'')+(r.stderr||'')`） */
  out: string
  error?: string
}

export interface ProcBridge {
  runLines(
    cmd: string,
    args: string[],
    stdinText: string,
    onLine: (line: string) => void,
    opts?: RunLinesOptions,
  ): Promise<RunLinesResult>
  execText(cmd: string, args: string[]): Promise<ExecTextResult>
  readonly platform: string
  /**
   * 子进程的默认工作目录。
   *
   * 为什么需要它、而且是异步的：`claude` 按 cwd 决定会话落盘位置
   * （`~/.claude/projects/<sanitize(cwd)>/`），而「打开终端继续对话」必须与分析调用**同 cwd**，
   * 所以这个值要能被终端那侧取到。Node 侧它就是 `process.cwd()`（同步）；
   * Tauri 渲染层没有 `process`，得问 Rust 要家目录 → 只能异步。
   */
  defaultCwd(): Promise<string>
  /**
   * 脱离父进程启动一个进程（不等待、不接管 stdio）。
   *
   * 用途：在 OS 终端里打开 `claude --resume`。**必须 detached** —— 关掉 app 不能杀掉用户的终端。
   * 两个实现都按 `detached + stdio=ignore` 处理；`cwd` 由调用方给（见 defaultCwd 的说明）。
   */
  spawnDetached(exe: string, args: string[], cwd: string): Promise<{ ok: boolean; error?: string }>
}

let installed: ProcBridge | null = null

export function setProcBridge(bridge: ProcBridge): void {
  installed = bridge
}

export function procBridge(): ProcBridge {
  if (!installed) {
    throw new Error(
      'ProcBridge 未安装：Node 侧请调用 installNodeProcBridge()；' +
        'Tauri 渲染层请调用 installTauriProcBridge()；测试由 vitest setupFiles 自动安装。',
    )
  }
  return installed
}
