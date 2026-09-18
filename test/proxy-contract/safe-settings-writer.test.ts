/**
 * safe-settings-writer 四道闸的**单元级**契约（闸1 差异保护 / 闸2 写前备份 / 闸3 原子写 /
 * 闸4 写后校验回滚），含失败路径与「.bak 永不覆盖」。
 *
 * 这是 Stage 1 数据风险最高的一块（改坏 settings.json 会让用户的 cc 直接不可用），
 * 所以逐闸钉死，并且把已知的失败模式（回滚也失败 = 无法恢复）也如实断言下来。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

type SafeWrite = (
  filePath: string,
  transform: (text: string) => string,
  opts?: { maxDeltaRatio?: number },
) => void

const require_ = createRequire(import.meta.url)
const MODULE_PATH = fileURLToPath(
  new URL('../../vendor/cc-monitor/shared/safe-settings-writer.js', import.meta.url),
)
const { withSafeSettingsWrite } = require_(MODULE_PATH) as { withSafeSettingsWrite: SafeWrite }

describe('safe-settings-writer 四道闸', () => {
  let dir: string
  let file: string

  const bak = () => file + '.bak'
  const tmp = () => file + '.tmp'
  const read = () => readFileSync(file, 'utf8')
  const write = (text: string) => writeFileSync(file, text, 'utf8')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ccmon-safe-'))
    file = join(dir, 'settings.json')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('闸1 差异保护：超阈值抛错，文件一字节不改，且不产生 .bak', () => {
    write('{"a":1}')
    expect(() => withSafeSettingsWrite(file, (t) => t + 'x'.repeat(1000))).toThrow(/size delta/)
    expect(read()).toBe('{"a":1}')
    expect(existsSync(bak())).toBe(false)
  })

  it('闸1 阈值可用 maxDeltaRatio 放宽', () => {
    write(JSON.stringify({ a: 1 }))
    withSafeSettingsWrite(file, () => JSON.stringify({ a: 1, pad: 'x'.repeat(40) }), {
      maxDeltaRatio: 10,
    })
    expect(JSON.parse(read()).pad).toHaveLength(40)
    expect(existsSync(bak())).toBe(true)
  })

  it('闸2 写前备份：首次写入生成 .bak == 改动前原文', () => {
    write('{"a":1}')
    withSafeSettingsWrite(file, () => '{"a":2}')
    expect(read()).toBe('{"a":2}')
    expect(readFileSync(bak(), 'utf8')).toBe('{"a":1}')
  })

  it('闸2 .bak 永不覆盖：已存在则原样保留（永远是「用户上次能跑的版本」）', () => {
    write('{"a":1}')
    withSafeSettingsWrite(file, () => '{"a":2}')
    writeFileSync(bak(), 'SENTINEL', 'utf8')
    withSafeSettingsWrite(file, () => '{"a":3}')
    expect(read()).toBe('{"a":3}')
    expect(readFileSync(bak(), 'utf8')).toBe('SENTINEL')
  })

  it('闸3 原子写：成功后不留 .tmp', () => {
    write('{"a":1}')
    withSafeSettingsWrite(file, () => '{"a":2}')
    expect(existsSync(tmp())).toBe(false)
  })

  it('闸3 原子写失败（.tmp 被占为目录 → EISDIR）：抛 write failed，且原文件未动', () => {
    write('{"a":1}')
    mkdirSync(tmp())
    expect(() => withSafeSettingsWrite(file, () => '{"a":2}')).toThrow(/write failed/)
    expect(read()).toBe('{"a":1}')
  })

  it('闸4 写后校验失败：从 .bak 原子回滚，文件回到原文且不留 .tmp', () => {
    write('{"a":1}')
    expect(() => withSafeSettingsWrite(file, () => 'NOT JSON')).toThrow(/restored from backup/)
    expect(read()).toBe('{"a":1}')
    expect(readFileSync(bak(), 'utf8')).toBe('{"a":1}')
    expect(existsSync(tmp())).toBe(false)
  })

  it('闸4 回滚也失败：抛聚合错（rollback failed），并如实留下不可恢复状态', () => {
    write('{"a":1}')
    // .bak 存在但是目录 → ensureBackup 认为"已有备份"而跳过；回滚时读取 .bak 失败。
    mkdirSync(bak())
    expect(() => withSafeSettingsWrite(file, () => 'NOT JSON')).toThrow(/rollback failed/)
    // 回滚失败 = 数据无法恢复。这不是我们想要的结局，但必须钉住这个失败模式，
    // 让任何改动它的实现立刻红。
    expect(read()).toBe('NOT JSON')
  })

  it('transform 返回原文 → 零 I/O：不写文件、不建 .bak/.tmp', () => {
    write('{"a":1}')
    expect(withSafeSettingsWrite(file, (t) => t)).toBeUndefined()
    expect(read()).toBe('{"a":1}')
    expect(existsSync(bak())).toBe(false)
    expect(existsSync(tmp())).toBe(false)
  })

  it('transform 抛错 → 文件不变，且不建 .bak', () => {
    write('{"a":1}')
    expect(() =>
      withSafeSettingsWrite(file, () => {
        throw new Error('boom')
      }),
    ).toThrow(/boom/)
    expect(read()).toBe('{"a":1}')
    expect(existsSync(bak())).toBe(false)
  })

  it('文件不存在 → 抛错（读文件失败不静默吞）', () => {
    expect(() => withSafeSettingsWrite(file, () => '{"a":1}')).toThrow()
  })
})
