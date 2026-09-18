import { invoke } from '@tauri-apps/api/core'
import { setFsBridge, type FsBridge } from '../../core/fsBridge'

/** Rust 侧返回形状（见 src-tauri/src/fs_ops.rs）—— 字段是 snake_case，这里显式转成桥的 camelCase */
interface RustDirEntry {
  name: string
  is_dir: boolean
  is_file: boolean
}
interface RustStat {
  is_file: boolean
  size: number
  mtime_ms: number
}

/**
 * `FsBridge` 的 Tauri 实现：每个原语一次 IPC 到 `src-tauri/src/fs_ops.rs`。
 *
 * 参数名 `maxBytes` 会被 Tauri v2 自动映射到 Rust 的 `max_bytes`（命令参数自动 camelCase→snake_case）。
 * 语义对齐见 `core/fsBridge.ts` 顶部的约定表。
 */
export const tauriFsBridge: FsBridge = {
  async readDir(path) {
    const entries = await invoke<RustDirEntry[]>('read_dir', { path })
    return entries.map((e) => ({ name: e.name, isDir: e.is_dir, isFile: e.is_file }))
  },

  async stat(path) {
    const st = await invoke<RustStat>('stat', { path })
    return { isFile: st.is_file, size: st.size, mtimeMs: st.mtime_ms }
  },

  async readText(path) {
    return invoke<string>('read_text', { path })
  },

  async readHead(path, maxBytes) {
    return invoke<string>('read_head', { path, maxBytes })
  },

  readTextSync() {
    // 渲染层没有同步 fs，物理上无法实现。给一条能直接照做的修复指引，而不是含糊失败。
    throw new Error(
      'Tauri 渲染层没有同步 fs：`parseJsonl(path)` 不可用，' +
        '请改用 `parseJsonlText(await readText(path), path)`。',
    )
  },
}

/** 安装 Tauri 版 FsBridge（由 `src/api/index.ts` 在检测到 Tauri 时调用一次）。 */
export function installTauriFsBridge(): void {
  setFsBridge(tauriFsBridge)
}
