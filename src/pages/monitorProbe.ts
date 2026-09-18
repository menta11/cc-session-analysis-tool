/**
 * 「实时监控」页的连接收敛逻辑 —— 从 `MonitorPage` 抽出、可脱离 DOM 单测的纯函数。
 *
 * 为什么要单独一个文件：真正出过缺陷的正是这段时序（见下），而页面本身是 `.tsx`；
 * 仓库没有 React 测试渲染器（`vitest.config.ts` 只收 `test/` 目录下的 `.test.ts`，
 * 也没装 testing-library），把逻辑抽出来才能用单测钉住它。
 *
 * ## 被修掉的真实缺陷（Tauri 冷启动竞态）
 *
 * Tauri 壳里内嵌代理由 Rust 的 `setup()` **异步**启动，宿主原子量 `MONITOR_PORT`
 * 在就绪前是 `0`（`src-tauri/src/lib.rs`：只有 `start_background()` 成功返回后才 store）。
 * 旧实现把这件事拆成两处：mount 时 `getMonitorPort()` 取一次端口存进 state，「重试」只重新 ping。
 * 于是若首次取到 `0`：iframe 的 `src` 会一直停在 `http://localhost:0/`；代理随后就绪时，
 * ping 会成功（`monitor_ping` 每次现读原子量）→ **遮罩消失，但 iframe 仍指向 0 端口** →
 * 「重试」看起来生效了、监控页却永远空白。而切页也不会重挂（`App.tsx` 对监控页是懒挂载 +
 * `display` 切换），所以旧实现下这个状态只能靠重启应用脱出。
 *
 * ## 现在的形状
 *
 * 每次尝试都**现取端口**：端口可能在等待窗口内才就绪（正是 Tauri 的情况），也可能被宿主换掉。
 * 取到非 0 且 ping 通即成功；`attempts` 次用完就返回 —— 这是**有界**的一次收敛，不是常驻轮询。
 */
export interface MonitorProbeResult {
  /** 本次收敛最后一次读到的端口（`0` = 仍未就绪） */
  port: number
  /** true = 端口非 0 且代理应答 */
  ok: boolean
}

/** 默认 sleep。注入出去是为了单测里零等待。 */
const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function probeMonitor(
  getPort: () => Promise<number>,
  ping: () => Promise<boolean>,
  attempts = 3,
  intervalMs = 800,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<MonitorProbeResult> {
  let port = await getPort()
  for (let i = 0; i < attempts; i++) {
    // 端口为 0 时不必发 ping：Tauri 的 `monitor_ping` 对 0 直接返回 false。
    // 跳过既省一次 IPC，也让单测的调用次数确定。
    if (port !== 0 && (await ping())) return { port, ok: true }
    if (i < attempts - 1) {
      await sleep(intervalMs)
      // 关键：等待期间端口可能才就绪 / 被换掉 —— 重新读，而不是复用首次快照
      port = await getPort()
    }
  }
  return { port, ok: false }
}
