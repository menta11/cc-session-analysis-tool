import { spawn } from 'node:child_process'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 校验 claude sessionId 是否为合法 UUID（开终端前的注入守卫）。 */
export function isSessionId(v: string): boolean {
  return UUID.test(v)
}

export interface ResumeCommand {
  exe: string
  args: string[]
  opts: { detached: boolean; stdio: 'ignore' }
}

/** 转义 AppleScript 字符串字面量里的反斜杠与双引号。 */
function escAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * 构造跨平台续问命令：在 OS 终端跑 `claude --resume <id>`，cwd 设到被分析会话的工作目录。
 * id 须为 UUID（由调用方 openTerminal 校验）；cwd 须存在（由调用方兜底）。
 */
export function buildResumeCommand(id: string, cwd: string, platform: NodeJS.Platform): ResumeCommand {
  const opts = { detached: true, stdio: 'ignore' as const }
  if (platform === 'win32') {
    // start ""  = 空 title，规避 start 把首参数当程序名；/d <cwd> 设新窗口工作目录；cmd /k 跑完不关窗
    return {
      exe: 'cmd.exe',
      args: ['/d', '/c', 'start', '', '/d', cwd, 'cmd', '/k', `claude --resume ${id}`],
      opts,
    }
  }
  // darwin（及其它 *nix 回退到 osascript；本方案仅支持 win/mac）
  const script = `tell application "Terminal" to do script "cd \\"${escAppleScript(cwd)}\\" && claude --resume ${id}"`
  return { exe: 'osascript', args: ['-e', script], opts }
}

/**
 * 在 OS 终端打开 `claude --resume <id>` 续接分析对话。
 * - id 非 UUID → 拒绝、不开窗。
 * - cwd 为空/不存在 → 退到用户 home。
 * - detached + unref：终端与主进程脱钩，关 app 不杀终端。
 * 不等终端退出，立即返回 ok；终端自身成败由用户在窗口里观察。
 */
export async function openTerminal(id: string): Promise<{ ok: boolean; error?: string }> {
  if (!isSessionId(id)) return { ok: false, error: 'sessionId 非法，拒绝打开终端' }
  // resume 必须与分析调用同 cwd：claude 按 cwd-sanitized 路径存放会话
  // （~/.claude/projects/<sanitize(cwd)>/<id>.jsonl）。分析在主进程 cwd 跑
  // （runClaudeStream 的 spawn 未指定 cwd），故会话落在 sanitize(process.cwd()) 下；
  // resume 必须从同一 cwd 进入，否则报 "No conversation found with session ID"。
  const dir = process.cwd()
  const cmd = buildResumeCommand(id, dir, process.platform)
  const child = spawn(cmd.exe, cmd.args, { ...cmd.opts, cwd: dir })
  child.on('error', () => {
    /* 终端启动失败仅记日志，不抛；用户已在窗口侧观察 */
  })
  child.unref()
  return { ok: true }
}
