/**
 * C13 / C14：settings.json 安全改写的 **HTTP 级可观测不变量**（两个实现都要过）。
 * 四道闸本身的逐闸语义（差异保护 / 原子写失败 / 写后校验回滚 / 回滚失败）是单元级契约，
 * 见 safe-settings-writer.test.ts；这里只测通过 `/config/baseurl` 能观察到的东西。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  nodeSut,
  getFreePort,
  httpRequest,
  readBaseUrl,
  rustSut,
  settingsJson,
  startFakeUpstream,
  type FakeUpstream,
  type HttpResponse,
  type SutDriver,
  type SutHandle,
} from './harness'

const ORIGINAL = 'https://origin-relay.example.com/v1'
const CASE_TIMEOUT = 25_000

function settingsWriteSuite(driver: SutDriver) {
  return () => {
    let upstream: FakeUpstream

    beforeAll(async () => {
      upstream = await startFakeUpstream()
    }, 20_000)
    afterAll(async () => {
      await upstream?.close()
    })

    /** 每例一个干净的 SUT（settings.json 预置为 `settings`），跑完必销毁。 */
    async function withSut<T>(settings: string, fn: (sut: SutHandle) => Promise<T>): Promise<T> {
      const port = await getFreePort()
      const sut = await driver.start({ upstream: upstream.origin, port, settings })
      try {
        return await fn(sut)
      } finally {
        await sut.stop()
      }
    }

    function post(sut: SutHandle, action: 'enable' | 'disable'): Promise<HttpResponse> {
      return httpRequest(`${sut.origin}/config/baseurl`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      })
    }

    const bakOf = (sut: SutHandle) => sut.settingsPath + '.bak'

    it(
      'C13a enable：写入代理地址 + 生成 .bak，其余字节一字不动',
      async () => {
        await withSut(settingsJson(ORIGINAL), async (sut) => {
          const r = await post(sut, 'enable')
          expect(r.status).toBe(200)
          const j = JSON.parse(r.body.toString('utf8'))
          expect(j.ok).toBe(true)
          expect(j.monitoring).toBe(true)

          const after = readFileSync(sut.settingsPath, 'utf8')
          expect(readBaseUrl(after)).toBe(`http://localhost:${sut.port}`)
          expect(readFileSync(bakOf(sut), 'utf8')).toBe(settingsJson(ORIGINAL))
          // 只有那一个字符串值被替换：换回去应与原文逐字节相同
          expect(after.replace(`http://localhost:${sut.port}`, ORIGINAL)).toBe(settingsJson(ORIGINAL))
        })
      },
      CASE_TIMEOUT,
    )

    it(
      'C13b 重复 enable 幂等：settings 与 .bak 均不变',
      async () => {
        await withSut(settingsJson(ORIGINAL), async (sut) => {
          await post(sut, 'enable')
          const s1 = readFileSync(sut.settingsPath, 'utf8')
          const b1 = readFileSync(bakOf(sut), 'utf8')
          const r = await post(sut, 'enable')
          expect(r.status).toBe(200)
          expect(readFileSync(sut.settingsPath, 'utf8')).toBe(s1)
          expect(readFileSync(bakOf(sut), 'utf8')).toBe(b1)
        })
      },
      CASE_TIMEOUT,
    )

    it(
      'C13c disable：完整还原为开监控前的 settings.json，.bak 保留',
      async () => {
        await withSut(settingsJson(ORIGINAL), async (sut) => {
          await post(sut, 'enable')
          const r = await post(sut, 'disable')
          expect(r.status).toBe(200)
          const j = JSON.parse(r.body.toString('utf8'))
          expect(j.ok).toBe(true)
          expect(j.monitoring).toBe(false)

          const after = readFileSync(sut.settingsPath, 'utf8')
          expect(readBaseUrl(after)).toBe(ORIGINAL)
          expect(after).toBe(settingsJson(ORIGINAL))
          expect(readFileSync(bakOf(sut), 'utf8')).toBe(settingsJson(ORIGINAL))
        })
      },
      CASE_TIMEOUT,
    )

    it(
      'C14 .bak 永不覆盖：哨兵内容经 disable/enable 循环后仍在',
      async () => {
        await withSut(settingsJson(ORIGINAL), async (sut) => {
          await post(sut, 'enable')
          expect(readFileSync(bakOf(sut), 'utf8')).toBe(settingsJson(ORIGINAL))
          writeFileSync(bakOf(sut), 'SENTINEL', 'utf8')

          await post(sut, 'disable')
          await post(sut, 'enable')
          expect(readFileSync(bakOf(sut), 'utf8')).toBe('SENTINEL')
        })
      },
      CASE_TIMEOUT,
    )

    it(
      'C13d settings.json 缺 ANTHROPIC_BASE_URL 键 → 400，且文件一字节不改',
      async () => {
        const noKey = JSON.stringify({ env: { OTHER_VAR: '1' }, model: 'x' }, null, 2) + '\n'
        await withSut(noKey, async (sut) => {
          const r = await post(sut, 'enable')
          expect(r.status).toBe(400)
          const j = JSON.parse(r.body.toString('utf8'))
          expect(j.ok).toBe(false)
          expect(j.error).toContain('ANTHROPIC_BASE_URL')
          expect(readFileSync(sut.settingsPath, 'utf8')).toBe(noKey)
        })
      },
      CASE_TIMEOUT,
    )
  }
}

describe.skipIf(!nodeSut.available())(
  `${nodeSut.name} · settings 安全改写 C13–C14`,
  settingsWriteSuite(nodeSut),
)
describe.skipIf(!rustSut.available())(
  `${rustSut.name} · settings 安全改写 C13–C14`,
  settingsWriteSuite(rustSut),
)
