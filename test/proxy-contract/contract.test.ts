/**
 * C1–C11 透传契约：同一批用例分别跑在 Node 版 proxy.js（黄金基准）与 Rust spike 上。
 * Rust 二进制不存在时整组 skip，并**显式打印原因**——静默跳过会让 Stage 1 误以为已放行。
 */
import { afterAll, beforeAll, describe, it } from 'vitest'
import { CONTRACT_CASES, type ContractCtx } from './cases'
import {
  nodeSut,
  rustSut,
  startFakeUpstream,
  type FakeUpstream,
  type SutDriver,
  type SutHandle,
} from './harness'

const CASE_TIMEOUT = 30_000

function contractSuite(driver: SutDriver) {
  return () => {
    let upstream: FakeUpstream
    let sut: SutHandle

    beforeAll(async () => {
      upstream = await startFakeUpstream()
      sut = await driver.start({ upstream: upstream.origin })
    }, 40_000)

    afterAll(async () => {
      await sut?.stop()
      await upstream?.close()
    })

    for (const c of CONTRACT_CASES) {
      it(
        `${c.id} ${c.title}`,
        async () => {
          const ctx: ContractCtx = {
            driver,
            sut,
            upstream,
            spawn: (opts) => driver.start(opts),
          }
          await c.run(ctx)
        },
        CASE_TIMEOUT,
      )
    }
  }
}

describe.skipIf(!nodeSut.available())(
  `${nodeSut.name} · 透传契约 C1–C11`,
  contractSuite(nodeSut),
)

if (!rustSut.available()) {
  console.warn(`[proxy-contract] 跳过 Rust spike：${rustSut.unavailableReason?.()}`)
}
describe.skipIf(!rustSut.available())(
  `${rustSut.name} · 透传契约 C1–C11`,
  contractSuite(rustSut),
)
