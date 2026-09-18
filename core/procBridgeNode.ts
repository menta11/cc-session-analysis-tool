/**
 * `ProcBridge` 的 Node 实现 —— 供 **Node 侧**（vitest setup / Node 单测）使用。
 *
 * ⚠️ 这个文件**不能**被 `src/`（Tauri 渲染层）引用：它 import `node:child_process`。
 * 渲染层用 `src/api/procBridgeTauri.ts`。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { setProcBridge, type ProcBridge, type RunLinesResult } from './procBridge'

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export const nodeProcBridge: ProcBridge = {
  platform: process.platform,

  /**
   * 逐行流式跑命令。这里是原 `claudeCli.ts::runProcess` 的**逐字搬迁** —— 行为（含错误文案）
   * 必须与迁移前一致，否则用户可见的错误信息会变。
   *
   * `shell: true` 保留：Windows 下 claude 是 `.cmd` shim，不经 shell 解析不到。
   * 负载全部走 stdin（见 `buildStdin` 的注释），argv 里只有固定安全 token，所以 shell 注入面无变化。
   */
  runLines(cmd, args, stdinText, onLine, opts = {}) {
    const label = opts.label ?? cmd
    return new Promise<RunLinesResult>((resolve) => {
      let child: ChildProcess
      try {
        child = spawn(cmd, args, { shell: true, windowsHide: true })
      } catch (e) {
        resolve({ ok: false, error: `无法启动 ${label}：` + errMsg(e), stderr: '' })
        return
      }
      const stdin = child.stdin
      const stdout = child.stdout
      const stderr = child.stderr
      if (!stdin || !stdout || !stderr) {
        resolve({ ok: false, error: `${label} 进程 stdio 不可用`, stderr: '' })
        return
      }
      let stderrText = ''
      let lineBuf = ''
      stdin.on('error', () => {
        /* broken pipe 忽略 */
      })
      stdin.write(stdinText, 'utf8')
      stdin.end()
      stdout.on('data', (d: Buffer) => {
        lineBuf += d.toString()
        const lines = lineBuf.split(/\r?\n/)
        lineBuf = lines.pop() ?? ''
        for (const ln of lines) onLine(ln)
      })
      stderr.on('data', (d: Buffer) => {
        stderrText += d.toString()
      })
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          // ignore
        }
        resolve({ ok: false, error: `调用 ${label} 超时`, stderr: stderrText })
      }, opts.timeoutMs ?? 180_000)
      child.on('error', (e: Error) => {
        clearTimeout(timer)
        resolve({ ok: false, error: `${label} CLI 未安装或调用失败：` + e.message, stderr: stderrText })
      })
      child.on('close', (code: number | null) => {
        clearTimeout(timer)
        if (lineBuf) onLine(lineBuf) // flush 末行
        if (code === 0) resolve({ ok: true, stderr: stderrText })
        else
          resolve({
            ok: false,
            error: `${label} 退出码 ${code}${stderrText ? '：' + stderrText.slice(0, 300) : ''}`,
            stderr: stderrText,
          })
      })
    })
  },

  /** 一次性命令，收集 stdout+stderr。非零退出码不算失败（对齐 spawnSync）。 */
  execText(cmd, args) {
    try {
      const r = spawnSync(cmd, args, { shell: true, encoding: 'utf8', windowsHide: true })
      return Promise.resolve({ ok: true, out: (r.stdout || '') + (r.stderr || '') })
    } catch (e) {
      return Promise.resolve({ ok: false, out: '', error: errMsg(e) })
    }
  },

  /** Electron 下就是主进程 cwd —— 与原 `openTerminal` 的行为逐字一致。 */
  defaultCwd() {
    return Promise.resolve(process.cwd())
  },

  /** detached + stdio=ignore + unref：终端与主进程脱钩，关 app 不杀终端（原行为）。 */
  spawnDetached(exe, args, cwd) {
    return new Promise((resolve) => {
      try {
        const child = spawn(exe, args, { detached: true, stdio: 'ignore', cwd })
        child.on('error', () => {
          /* 终端启动失败仅忽略，不抛；用户已在窗口侧观察（原行为） */
        })
        child.unref()
        resolve({ ok: true })
      } catch (e) {
        resolve({ ok: false, error: errMsg(e) })
      }
    })
  },
}

/** 安装 Node 进程桥（幂等）。Electron 主进程启动时与 vitest setup 各调一次。 */
export function installNodeProcBridge(): void {
  setProcBridge(nodeProcBridge)
}
