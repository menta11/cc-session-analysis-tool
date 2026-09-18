/**
 * 唤起 OS 自己的界面：在终端里续接 `claude --resume <id>`、在文件管理器里打开一个目录。
 *
 * 两者同源 —— 都是"让操作系统替用户打开一个窗口"，都要跨三平台拼命令、都要 detached 起进程，
 * 所以住同一个文件（文件名只留下了先来的那个）。
 *
 * 从 迁移前 Electron 壳的 `terminal.ts`（已删除） 迁到 `core/`（两种壳共用），并**顺带补上 Linux** ——
 * 原实现只覆盖 win/mac（注释里就写着"本方案仅支持 win/mac"），而附录 B 的验收项要求三平台。
 *
 * 迁移方式与其它模块一致：命令**构造**是纯函数（有测试，保留），只把"起进程"这一步
 * 交给 `ProcBridge`（Electron → node:child_process，Tauri → Rust）。
 */
import { procBridge } from './procBridge'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 校验 claude sessionId 是否为合法 UUID（开终端前的注入守卫）。 */
export function isSessionId(v: string): boolean {
  return UUID.test(v)
}

export interface SpawnCommand {
  exe: string
  args: string[]
  /** 两个桥都按 detached + stdio=ignore 起进程；这个字段是那条约定的显式声明（Node 侧直接用它）。 */
  opts: { detached: boolean; stdio: 'ignore' }
}

const DETACHED_OPTS = { detached: true, stdio: 'ignore' as const }

/** 转义 AppleScript 字符串字面量里的反斜杠与双引号。 */
function escAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** POSIX 单引号转义。Linux 分支要把 cwd 嵌进 `sh -c` 里，必须转义（cwd 可能含空格/引号）。 */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

/**
 * Linux 候选终端：[命令, "执行后面命令"的开关]。
 * 各发行版默认终端不同（Debian 系是 x-terminal-emulator，GNOME 是 gnome-terminal…），
 * 而且 `-e` / `-x` / `--` 的语义各不相同，所以不硬编码一个，按优先级探测第一个存在的。
 */
const LINUX_TERMINALS: ReadonlyArray<readonly [string, string]> = [
  ['x-terminal-emulator', '-e'],
  ['gnome-terminal', '--'],
  ['konsole', '-e'],
  ['xfce4-terminal', '-x'],
  ['xterm', '-e'],
]

/**
 * Linux 用的**内层**脚本：cd 到会话 cwd 后 resume。
 *
 * 单独导出是为了能**真跑一遍**验证转义 —— Linux 这条链路是两层 `sh -c` 嵌套
 * （外层脚本探测终端 → 终端里再跑 `sh -c <本串>`），所以内层串会被引号转义**两次**。
 * 靠断言字符串形态很容易看错（第一版我就断言错了），用真实 shell 跑一次才靠谱。
 */
export function buildResumeShellCommand(id: string, cwd: string): string {
  return `cd ${shQuote(cwd)} && claude --resume ${id}`
}

/**
 * 构造跨平台续问命令：在 OS 终端跑 `claude --resume <id>`，cwd 设到被分析会话的工作目录。
 * id 须为 UUID（由调用方 openTerminal 校验）；cwd 须存在（由调用方兜底）。
 */
export function buildResumeCommand(id: string, cwd: string, platform: string): SpawnCommand {
  const opts = DETACHED_OPTS

  if (platform === 'win32') {
    // start ""  = 空 title，规避 start 把首参数当程序名；/d <cwd> 设新窗口工作目录；cmd /k 跑完不关窗
    return {
      exe: 'cmd.exe',
      args: ['/d', '/c', 'start', '', '/d', cwd, 'cmd', '/k', `claude --resume ${id}`],
      opts,
    }
  }

  if (platform === 'linux') {
    // 先 cd 到会话 cwd 再 resume；命令结束后留一个交互 shell（`exec "$SHELL"`），
    // 这样 claude 若报错用户能直接看到 —— 对齐 macOS 版"Terminal 窗口不自动关"的行为。
    const inner = `${buildResumeShellCommand(id, cwd)}; exec "\${SHELL:-sh}"`
    const branches = LINUX_TERMINALS.map(
      ([term, flag]) => `command -v ${term} >/dev/null 2>&1 && exec ${term} ${flag} sh -c ${shQuote(inner)}`,
    ).join('; ')
    return {
      exe: 'sh',
      args: ['-c', `${branches}; echo '未找到可用终端（试过 x-terminal-emulator/gnome-terminal/konsole/xfce4-terminal/xterm）' >&2; exit 1`],
      opts,
    }
  }

  // darwin（以及其它未列出的平台，沿用原实现的 osascript 回退）
  const script = `tell application "Terminal" to do script "cd \\"${escAppleScript(cwd)}\\" && claude --resume ${id}"`
  return { exe: 'osascript', args: ['-e', script], opts }
}

/**
 * 在 OS 终端打开 `claude --resume <id>` 续接分析对话。
 * - id 非 UUID → 拒绝、不开窗（守卫在动 bridge 之前，非法输入不产生任何副作用）。
 * - cwd 取 `ProcBridge.defaultCwd()` —— 必须与**分析调用**同 cwd，因为 claude 按 cwd 决定
 *   会话落盘位置（`~/.claude/projects/<sanitize(cwd)>/<id>.jsonl`），cwd 不一致会报
 *   "No conversation found with session ID"。Electron 下就是 process.cwd()（原行为）；
 *   Tauri 下由 Rust 固定为家目录（见 src-tauri/src/lib.rs 的说明）。
 * - detached + unref：终端与主进程脱钩，关 app 不杀终端。
 * 不等终端退出，立即返回 ok；终端自身成败由用户在窗口里观察。
 */
export async function openTerminal(id: string): Promise<{ ok: boolean; error?: string }> {
  if (!isSessionId(id)) return { ok: false, error: 'sessionId 非法，拒绝打开终端' }
  const bridge = procBridge()
  const cwd = await bridge.defaultCwd()
  const cmd = buildResumeCommand(id, cwd, bridge.platform)
  return bridge.spawnDetached(cmd.exe, cmd.args, cwd)
}

/**
 * 在系统文件管理器里打开一个目录：Finder / 资源管理器 / 桌面环境的 xdg-open。
 *
 * 路径直接作为参数传（不经 shell），所以不用转义 —— 含空格、引号的目录名都安全。
 * `explorer` 打开成功时也常返回非 0，所以只在**起进程失败**时算失败（见 openDir 的注释）。
 */
export function buildRevealCommand(dir: string, platform: string): SpawnCommand {
  const exe = platform === 'win32' ? 'explorer' : platform === 'linux' ? 'xdg-open' : 'open'
  return { exe, args: [dir], opts: DETACHED_OPTS }
}

/**
 * 在系统文件管理器里打开 `dir`（这里是会话 jsonl 所在的项目目录）。
 *
 * cwd 传 `dir` 本身：它一定存在（调用方拿的是刚读过的会话路径），不必再去解析家目录。
 * 只保证"窗口打开了"，不管用户在里面做什么 —— 与 openTerminal 同一约定。
 */
export async function openDir(dir: string): Promise<{ ok: boolean; error?: string }> {
  if (!dir) return { ok: false, error: '没有可打开的目录' }
  const bridge = procBridge()
  const cmd = buildRevealCommand(dir, bridge.platform)
  return bridge.spawnDetached(cmd.exe, cmd.args, dir)
}
