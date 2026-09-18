/**
 * C12：base URL 解析优先级矩阵（每个用例一个独立进程，见 baseurl-cases.ts）。
 * 同一批用例跑 Node 与 Rust 两侧。
 */
import { afterAll, beforeAll, describe, it } from 'vitest'
import { BASE_URL_CASES, type BaseUrlStatus } from './baseurl-cases'
import {
  nodeSut,
  httpGetJson,
  rustSut,
  startFakeUpstream,
  type FakeUpstream,
  type SutDriver,
} from './harness'

function baseUrlSuite(driver: SutDriver) {
  return () => {
    let upstream: FakeUpstream

    beforeAll(async () => {
      upstream = await startFakeUpstream()
    }, 20_000)

    afterAll(async () => {
      await upstream?.close()
    })

    for (const c of BASE_URL_CASES) {
      it(
        `${c.id} ${c.title}`,
        async () => {
          // 不再预先分配端口：由 launchSut 分配（并在端口被并发用例抢走时换端口重试），
          // 断言里用 SUT 实际监听的端口。
          const sut = await driver.start(c.build(upstream.origin))
          try {
            const status = await httpGetJson<BaseUrlStatus>(`${sut.origin}/config/baseurl`)
            c.assert(status, { port: sut.port, upstreamOrigin: upstream.origin })
          } finally {
            await sut.stop()
          }
        },
        25_000,
      )
    }
  }
}

describe.skipIf(!nodeSut.available())(
  `${nodeSut.name} · base URL 优先级 C12`,
  baseUrlSuite(nodeSut),
)
describe.skipIf(!rustSut.available())(
  `${rustSut.name} · base URL 优先级 C12`,
  baseUrlSuite(rustSut),
)
