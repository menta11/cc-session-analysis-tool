import { installTauriFsBridge } from './fsBridgeTauri'
import type { HostApi } from './hostApi'
import { installTauriProcBridge } from './procBridgeTauri'
import { tauriApi } from './tauri'

/**
 * 是否运行在 Tauri 壳里。Tauri v2 会向 window 注入 `__TAURI_INTERNALS__`。
 *
 * Electron 壳已随全量迁移完成而删除，仓库现在**只有 Tauri 一种宿主**。保留这个探测是为了
 * 「渲染层被直接丢进普通浏览器」的场景（`vite dev` 的 5173 可以直接用 Safari/Chrome 打开）：
 * 那种情况下不装桥，让后续 `core/` 的 fs / 子进程调用报出清晰的「桥未安装」，
 * 而不是在本模块求值时崩掉、连页面都起不来。
 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

const inTauri = isTauri()

// 必须在任何 core/ 的 fs / 子进程调用之前装好两个桥（core/ 的 IO 全部经它们，
// 见 core/fsBridge.ts 与 core/procBridge.ts）。模块顶层执行即可 —— 页面 effect 一定晚于本模块求值。
if (inTauri) {
  installTauriFsBridge()
  installTauriProcBridge()
}

/** 宿主实现。业务组件只 import 它，不直接调 invoke。 */
export const api: HostApi = tauriApi

export type { AnalyzeResult, HostApi } from './hostApi'
