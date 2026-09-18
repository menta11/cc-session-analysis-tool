/**
 * C16–C23：SSE 推送流契约（`/requests/stream`、`/events/stream`、`/event/detail/stream`）。
 *
 * 同一批用例分别跑 Node 版 `proxy.js`（黄金基准）与 Rust 实现（`proxy-standalone`），
 * 与 C1–C11 / C12 一样是黑盒差分；Rust 二进制不存在时整组 skip 并显式打印原因。
 *
 * C22（15s 心跳）默认**不注册**：间隔是硬编码的，跑一次要真等 15s，不能默认拖慢套件。
 * 显式开启：`CC_CONTRACT_HEARTBEAT=1 npx vitest run test/proxy-contract/stream.test.ts`。
 * 理由与口径见 CONTRACT.md §9。
 */
import { afterAll, beforeAll, describe, it } from 'vitest'
import { STREAM_CASES, type StreamCtx } from './stream-cases'
import {
  nodeSut,
  rustSut,
  startFakeUpstream,
  type FakeUpstream,
  type SutDriver,
  type SutHandle,
} from './harness'

const CASE_TIMEOUT = 30_000
const HEARTBEAT_TIMEOUT = 45_000
const RUN_HEARTBEAT = process.env.CC_CONTRACT_HEARTBEAT === '1'

const cases = STREAM_CASES.filter((c) => !c.slow || RUN_HEARTBEAT)

function streamSuite(driver: SutDriver) {
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

    for (const c of cases) {
      it(
        `${c.id} ${c.title}`,
        async () => {
          const ctx: StreamCtx = { sut, upstream }
          await c.run(ctx)
        },
        c.slow ? HEARTBEAT_TIMEOUT : CASE_TIMEOUT,
      )
    }
  }
}

describe.skipIf(!nodeSut.available())(
  `${nodeSut.name} · SSE 推送流 C16–C23`,
  streamSuite(nodeSut),
)

if (!rustSut.available()) {
  console.warn(`[proxy-contract] 跳过 Rust 实现的推送流用例：${rustSut.unavailableReason?.()}`)
}
describe.skipIf(!rustSut.available())(
  `${rustSut.name} · SSE 推送流 C16–C23`,
  streamSuite(rustSut),
)
