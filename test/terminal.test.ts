import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildResumeCommand,
  buildResumeShellCommand,
  buildRevealCommand,
  isSessionId,
  openTerminal,
} from '../core/terminal'
import { setProcBridge } from '../core/procBridge'
import { installNodeProcBridge } from '../core/procBridgeNode'

const ID = '12345678-1234-1234-1234-1234567890ab'
const CWD = 'C:/Users/example/project'

describe('isSessionId', () => {
  it('接受合法 uuid', () => {
    expect(isSessionId(ID)).toBe(true)
  })
  it('拒绝非法串（注入守卫）', () => {
    expect(isSessionId('foo; rm -rf /')).toBe(false)
    expect(isSessionId('')).toBe(false)
    expect(isSessionId('not-a-uuid')).toBe(false)
  })
})

describe('buildResumeCommand', () => {
  it('win32: 用 cmd /c start 开新窗口跑 claude --resume，cwd 经 /d 设定', () => {
    const cmd = buildResumeCommand(ID, CWD, 'win32')
    expect(cmd.exe).toBe('cmd.exe')
    expect(cmd.args).toEqual([
      '/d', '/c', 'start', '', '/d', CWD, 'cmd', '/k', `claude --resume ${ID}`,
    ])
    expect(cmd.opts).toEqual({ detached: true, stdio: 'ignore' })
  })
  it('darwin: osascript 唤 Terminal.app，先 cd 再 resume', () => {
    const cmd = buildResumeCommand(ID, '/Users/me/my project', 'darwin')
    expect(cmd.exe).toBe('osascript')
    expect(cmd.args[0]).toBe('-e')
    const script = cmd.args[1] as string
    expect(script).toContain('tell application "Terminal" to do script')
    expect(script).toContain(`claude --resume ${ID}`)
    expect(script).toContain('cd \\"/Users/me/my project\\"')
  })
  it('darwin: 转义 cwd 中的双引号', () => {
    const cmd = buildResumeCommand(ID, '/Users/a/b"c', 'darwin')
    const script = cmd.args[1] as string
    expect(script).toContain('b\\"c')
  })
})

describe('openTerminal', () => {
  it('拒绝非法 id（守卫早返回，不 spawn）', async () => {
    const res = await openTerminal('not-a-uuid')
    expect(res).toEqual({ ok: false, error: 'sessionId 非法，拒绝打开终端' })
  })
})

describe('buildResumeCommand — linux（本次迁移新增）', () => {
  it('用 sh 按优先级探测可用终端，cd 到 cwd 后 resume，跑完留交互 shell', () => {
    const cmd = buildResumeCommand(ID, '/home/me/my project', 'linux')
    expect(cmd.exe).toBe('sh')
    const script = cmd.args[1] as string
    for (const t of ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'xterm']) {
      expect(script).toContain(t)
    }
    expect(script).toContain(`claude --resume ${ID}`)
    // 带空格的 cwd 必须被整体引号包裹，否则 sh 会把它拆成两个参数
    expect(script).toContain(`'/home/me/my project'`)
    // 命令跑完留一个交互 shell —— 对齐 macOS 版"窗口不自动关"，让用户能看到 claude 的报错
    expect(script).toContain('exec "${SHELL:-sh}"')
    expect(cmd.opts).toEqual({ detached: true, stdio: 'ignore' })
  })

  it('含单引号与空格的 cwd 转义正确 —— 用真实 sh 跑一遍验证（不猜字符串形态）', () => {
    // Linux 是**两层** sh -c 嵌套（外层探测终端 → 终端里再跑 `sh -c <内层串>`），
    // 内层串会被转义两次，光看字符串形态极易判断错（第一版断言就写错了）。
    // 所以造一个含单引号+空格的目录，把 `claude --resume <id>` 换成「在 cwd 里留个标记文件」，真跑一遍。
    //
    // 判据取**落点**而不是 `pwd` 的字符串：Windows 上唯一能跑的 sh 是 Git Bash 的，它把
    // `C:\Users\<用户>\AppData\Local\Temp` 映射成 `/tmp`，同一个目录在两边拼写不同、字符串断言
    // 恒不成立（转义其实是对的，`cd` 确实成功了）。标记文件证明的是同一件事，且三平台都能跑。
    const base = mkdtempSync(join(tmpdir(), 'ccsa-term-'))
    const weird = join(base, "we ird's dir")
    mkdirSync(weird)
    const marker = 'landed-here.txt'
    try {
      const script = buildResumeShellCommand(ID, weird).replace(`claude --resume ${ID}`, `touch ${marker}`)
      execFileSync('sh', ['-c', script], { encoding: 'utf8' })
      // `cd` 与命令之间是 `&&`，所以 cd 失败时标记文件根本不会被创建
      expect(existsSync(join(weird, marker))).toBe(true)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('openTerminal（经 ProcBridge，两壳共用）', () => {
  it('合法 id：用 defaultCwd() 构造命令并 detached 启动', async () => {
    const calls: Array<{ exe: string; args: string[]; cwd: string }> = []
    setProcBridge({
      platform: 'darwin',
      defaultCwd: async () => '/Users/me/proj',
      spawnDetached: async (exe, args, cwd) => {
        calls.push({ exe, args, cwd })
        return { ok: true }
      },
      execText: async () => ({ ok: true, out: '' }),
      runLines: async () => ({ ok: true, stderr: '' }),
    })
    try {
      const res = await openTerminal(ID)
      expect(res).toEqual({ ok: true })
      expect(calls).toHaveLength(1)
      expect(calls[0].exe).toBe('osascript')
      // cwd 必须来自 defaultCwd —— 保证 resume 与"分析用的 claude"同目录
      expect(calls[0].cwd).toBe('/Users/me/proj')
      expect(calls[0].args[1]).toContain('cd \\"/Users/me/proj\\"')
    } finally {
      installNodeProcBridge()
    }
  })

  it('spawnDetached 失败 → ok:false 且把错误如实透出', async () => {
    setProcBridge({
      platform: 'linux',
      defaultCwd: async () => '/home/me',
      spawnDetached: async () => ({ ok: false, error: '启动终端失败（sh）：No such file' }),
      execText: async () => ({ ok: true, out: '' }),
      runLines: async () => ({ ok: true, stderr: '' }),
    })
    try {
      const res = await openTerminal(ID)
      expect(res.ok).toBe(false)
      expect(res.error).toContain('启动终端失败')
    } finally {
      installNodeProcBridge()
    }
  })
})

describe('buildRevealCommand — 在文件管理器里打开目录', () => {
  const DIR = '/Users/me/.claude/projects/-Users-me-proj'
  const WIN_DIR = String.raw`C:\Users\me\.claude\projects\D--proj`

  it('三平台各用各的系统命令', () => {
    expect(buildRevealCommand(DIR, 'darwin')).toMatchObject({ exe: 'open', args: [DIR] })
    expect(buildRevealCommand(DIR, 'linux')).toMatchObject({ exe: 'xdg-open', args: [DIR] })
    expect(buildRevealCommand(WIN_DIR, 'win32')).toMatchObject({ exe: 'explorer', args: [WIN_DIR] })
  })

  // explorer 不认 `/`：给它一个带 `/` 的路径，它不报错、不返回非 0，而是静默去开默认文件夹
  // （本机实测 = 「文档」）。链路其余各层都以为成功了 —— 所以只能在拼串这一步拦住。
  it('win32：分隔符归一化成反斜杠', () => {
    // 真实链路给的串：USERPROFILE 是反斜杠，之后 core/paths.ts::joinPath 一律用 `/`
    const fromJoinPath = String.raw`C:\Users\me/.claude/projects/D--project-x`
    expect(buildRevealCommand(fromJoinPath, 'win32').args).toEqual([
      String.raw`C:\Users\me\.claude\projects\D--project-x`,
    ])
    // 全 `/` 的也要换
    expect(buildRevealCommand('C:/Users/me/.claude/projects', 'win32').args).toEqual([
      String.raw`C:\Users\me\.claude\projects`,
    ])
    // 已经是反斜杠的原样（幂等）
    expect(buildRevealCommand(WIN_DIR, 'win32').args).toEqual([WIN_DIR])
  })

  it('POSIX 不动分隔符 —— open / xdg-open 认 `/`', () => {
    expect(buildRevealCommand(DIR, 'darwin').args).toEqual([DIR])
    expect(buildRevealCommand(DIR, 'linux').args).toEqual([DIR])
  })

  it('路径原样作为参数传给进程（不经 shell，含空格/引号也安全）', () => {
    const weird = '/Users/me/my "project" & co'
    expect(buildRevealCommand(weird, 'darwin').args).toEqual([weird])
    // win32 只换分隔符，其余字符一个不动（尤其引号与空格不得被引号包裹或转义）
    const winWeird = String.raw`C:\Users\me\my "project" & co`
    expect(buildRevealCommand(winWeird, 'win32').args).toEqual([winWeird])
  })

  it('三平台都是 detached + stdio=ignore（关 app 不关掉用户的文件管理器窗口）', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      expect(buildRevealCommand(DIR, platform).opts).toEqual({ detached: true, stdio: 'ignore' })
    }
  })
})
