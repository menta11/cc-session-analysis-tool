/**
 * `src/pages/monitorProbe.ts` 的单测 —— 专门钉住「Tauri 冷启动竞态」这个真实缺陷。
 *
 * 为什么需要这个文件：`vitest.config.ts` 只收 `test/` 下的 `.test.ts`，仓库也没有
 * React 测试渲染器，所以 `MonitorPage` 的 effect 没法直接渲染验证。把「取端口 + 探测」
 * 抽成纯函数后，「代理还没起 → 随后就绪」的时序可以在零等待（注入 noSleep）下确定性重放。
 *
 * 缺陷回顾：Tauri 的 `MONITOR_PORT` 在代理就绪前是 0（`src-tauri/src/lib.rs` 只在
 * `start_background()` 成功后 store）。修复前 `getMonitorPort()` 只在 mount 取一次，
 * 「重试」只重新 ping；于是端口后来就绪时 ping 会成功（`monitor_ping` 每次现读原子量），
 * 但 iframe 的 src 仍是 `http://localhost:0/` —— 遮罩消失、页面却永远空白。
 */
import { describe, expect, it, vi } from 'vitest'
import { probeMonitor } from '../src/pages/monitorProbe'

/** 注入的 sleep：单测里不真等 800ms。 */
const noSleep = (): Promise<void> => Promise.resolve()

/**
 * 修复前组件逻辑的最小模型（逐行对照 `git show df68d03:src/pages/MonitorPage.tsx`）：
 * 端口只在 mount 取一次，之后所有 ping 都基于那个快照 —— 只用来证明「旧形状真的会把
 * 就绪后的代理配上 0 端口」，不是被测对象。
 */
async function legacyProbe(
  getPortAtMount: () => Promise<number>,
  ping: () => Promise<boolean>,
  attempts: number,
  sleep: (ms: number) => Promise<void>,
): Promise<{ port: number; ok: boolean }> {
  const port = await getPortAtMount() // ← mount 时取一次
  for (let i = 0; i < attempts; i++) {
    if (await ping()) return { port, ok: true } // ← 端口不重取
    if (i < attempts - 1) await sleep(800)
  }
  return { port, ok: false }
}

describe('probeMonitor', () => {
  it('端口后来才就绪时返回就绪后的端口（旧形状会返回 ok:true + port:0）', async () => {
    // 同一个时序分别喂给旧形状与新实现：第一次读 0（代理还没起），之后读到 8090
    const makeClock = (): (() => Promise<number>) => {
      let reads = 0
      return async () => (++reads === 1 ? 0 : 8090)
    }
    const ping = async (): Promise<boolean> => true // 代理已就绪 → ping 会成功

    // 旧形状：ping 成功但端口快照仍是 0 → 遮罩消失、iframe 仍指向 localhost:0
    expect(await legacyProbe(makeClock(), ping, 3, noSleep)).toEqual({ port: 0, ok: true })

    // 新实现：每次尝试都现取端口 → 返回就绪端口
    expect(await probeMonitor(makeClock(), ping, 3, 800, noSleep)).toEqual({ port: 8090, ok: true })
  })

  it('显式「重试」= 再收敛一次：第一次全 0 失败，重试读到就绪端口并成功', async () => {
    let ready = false
    let reads = 0
    const getPort = async (): Promise<number> => {
      reads += 1
      return ready ? 8090 : 0
    }
    let pings = 0
    const ping = async (): Promise<boolean> => {
      pings += 1
      return ready
    }

    // 挂载时探测：代理还没起，3 次尝试都读 0 → 失败
    expect(await probeMonitor(getPort, ping, 3, 800, noSleep)).toEqual({ port: 0, ok: false })
    expect(reads).toBe(3) // 每次尝试都重新取端口，而不是只读 mount 那一次
    expect(pings).toBe(0) // 端口为 0 时不发 ping（Tauri 的 monitor_ping 对 0 恒 false）

    // 代理随后就绪；用户点「重试」→ 再调一次
    ready = true
    expect(await probeMonitor(getPort, ping, 3, 800, noSleep)).toEqual({ port: 8090, ok: true })
  })

  it('端口在等待窗口内变化时跟随新端口，不复用旧快照', async () => {
    const ports = [8080, 8091]
    let i = 0
    let lastPort = 0
    const getPort = async (): Promise<number> => {
      lastPort = ports[Math.min(i++, ports.length - 1)]
      return lastPort
    }
    // 旧端口上已无监听、新端口才应答（ping 不带端口参数，故用最后一次读到的值模拟）
    const ping = async (): Promise<boolean> => lastPort === 8091

    expect(await probeMonitor(getPort, ping, 2, 800, noSleep)).toEqual({ port: 8091, ok: true })
  })

  it('端口非 0 但代理始终不应答：尝试 attempts 次后返回失败（有界，不常驻轮询）', async () => {
    const getPort = vi.fn(async (): Promise<number> => 8090)
    const ping = vi.fn(async (): Promise<boolean> => false)
    const sleep = vi.fn(noSleep)

    expect(await probeMonitor(getPort, ping, 3, 800, sleep)).toEqual({ port: 8090, ok: false })
    expect(getPort).toHaveBeenCalledTimes(3) // 3 次尝试各读一次
    expect(ping).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2) // 最后一次尝试后不再 sleep
  })

  it('一次成功即返回，不做多余尝试', async () => {
    const getPort = vi.fn(async (): Promise<number> => 8090)
    const ping = vi.fn(async (): Promise<boolean> => true)

    expect(await probeMonitor(getPort, ping, 3, 800, noSleep)).toEqual({ port: 8090, ok: true })
    expect(getPort).toHaveBeenCalledTimes(1)
    expect(ping).toHaveBeenCalledTimes(1)
  })

  it('attempts=1：单次尝试，不 sleep（重试按钮不应有隐式等待）', async () => {
    const getPort = vi.fn(async (): Promise<number> => 0)
    const ping = vi.fn(async (): Promise<boolean> => false)
    const sleep = vi.fn(noSleep)

    expect(await probeMonitor(getPort, ping, 1, 800, sleep)).toEqual({ port: 0, ok: false })
    expect(getPort).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })
})
