/**
 * 沙箱与护栏的回归判据。
 *
 * 来历：`HOME` 沙箱在 Windows 上不生效（Node 的 `os.homedir()` 只认 `USERPROFILE`），
 * 导致被测的 `proxy.js` 解析到开发者真实家目录、读写真实的 `~/.claude/settings.json`。
 *
 * 本文件**不启动被测服务**：只 spawn 打印 `os.homedir()` 的裸 node，加上纯函数级比对。
 * 它不绑端口、不起上游、不读写任何真实配置，所以任何环境下都能安全跑（proxy-contract 其余
 * 文件会真的起 SUT，那才是会出事的那些）。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildEnv, findConfigDrift } from './harness'

const sandbox = mkdtempSync(join(tmpdir(), 'ccmon-home-'))
const logDir = join(sandbox, 'logs')

afterAll(() => rmSync(sandbox, { recursive: true, force: true }))

/** 用给定 env 起一个裸 node，回报它眼里的家目录。不经 shell，不写任何文件。 */
function childHomedir(env: Record<string, string>): string {
  return execFileSync(process.execPath, ['-e', 'process.stdout.write(require("os").homedir())'], {
    env,
    encoding: 'utf8',
  }).trim()
}

describe('家目录沙箱', () => {
  it('buildEnv 产出的环境里，子进程的 os.homedir() 落在沙箱内', () => {
    expect(childHomedir(buildEnv(sandbox, logDir, {}))).toBe(sandbox)
  })

  // 反例：证明上一条判据不是恒真的。事故的根因就是 Windows 上 `HOME` 单独不生效，
  // 所以这个反例只在 Windows 有意义（POSIX 上删掉 USERPROFILE 不影响结果）。
  it.skipIf(process.platform !== 'win32')(
    '反例：只设 HOME 不设 USERPROFILE 时，os.homedir() 会逃出沙箱',
    () => {
      const env = buildEnv(sandbox, logDir, {})
      delete env.USERPROFILE
      expect(childHomedir(env)).not.toBe(sandbox)
    },
  )
})

describe('真实配置护栏', () => {
  const snapshotOf = (path: string) => [[path, readFileSync(path, 'utf8')] as const]

  it('配置没被动过时不报差异', () => {
    const path = join(sandbox, 'untouched.json')
    writeFileSync(path, '{"env":{"ANTHROPIC_BASE_URL":"https://real.example.com/"}}', 'utf8')
    expect(findConfigDrift(snapshotOf(path))).toBeNull()
  })

  // 反例：用临时文件证明判据能失败。不能真去改开发者的配置来验证 —— 那正是要防的事。
  it('反例：配置被改写时报告差异，且带上前后的 ANTHROPIC_BASE_URL', () => {
    const path = join(sandbox, 'drifted.json')
    const before = '{\n  "env": {\n    "ANTHROPIC_BASE_URL": "https://real.example.com/"\n  }\n}\n'
    writeFileSync(
      path,
      '{\n  "env": {\n    "ANTHROPIC_BASE_URL": "http://localhost:57095"\n  }\n}\n',
      'utf8',
    )

    const drift = findConfigDrift([[path, before]])
    expect(drift).not.toBeNull()
    expect(drift).toContain('https://real.example.com/')
    expect(drift).toContain('http://localhost:57095')
  })

  it('反例：文件被删掉也算差异', () => {
    const path = join(sandbox, 'deleted.json')
    writeFileSync(path, '{}', 'utf8')
    const snapshot = snapshotOf(path)
    rmSync(path)
    expect(findConfigDrift(snapshot)).not.toBeNull()
  })
})
