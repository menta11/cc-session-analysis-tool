import { describe, it, expect } from 'vitest'
import { buildResumeCommand, isSessionId, openTerminal } from '../electron/main/terminal'

const ID = '12345678-1234-1234-1234-1234567890ab'
const CWD = 'C:/Users/jlc/project'

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
