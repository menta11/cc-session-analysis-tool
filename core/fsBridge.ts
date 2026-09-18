/**
 * 文件系统桥 —— `core/` 与宿主之间**唯一**的 syscall 边界。
 *
 * 为什么需要这层（Stage 2 架构决定 3）：
 *   `core/` 要同时跑在两种宿主上 —— Electron 主进程（有完整 Node）和 Tauri 渲染层（没有 Node，
 *   只有 IPC）。若 `core/` 直接 `import { readFileSync } from 'node:fs'`，Tauri 的浏览器 bundle 里
 *   该模块会被 Vite 外部化，运行时一碰就炸。所以把 syscall 收成 5 个原语，由宿主注入实现。
 *
 * 语义约定（**各实现必须一致**，否则迁移会静默改变行为）：
 *   - `readDir`  : 对齐 `fs.promises.readdir(dir, { withFileTypes: true })`；`isDir`/`isFile` 为
 *                  lstat 语义（**不**跟随符号链接），与 Node 的 `Dirent` 一致
 *   - `stat`     : 对齐 `fs.promises.stat`（**跟随**符号链接）
 *   - `readText` : 对齐 `readFileSync(path, 'utf8')`；非法 UTF-8 做有损替换
 *   - `readHead` : 返回**行对齐**的前缀，**不得**给出半行。上限 `maxBytes` 是**内存护栏**而非语义
 *                  边界 —— 解析结果的权威计量（`META_MAX_BYTES` / 候选行配额）仍在
 *                  `core/discovery/scan.ts::extractSessionMeta` 内部，所以两侧实现的上限口径
 *                  （字节 vs UTF-16 单元）允许有细微差异，不影响结果。
 *   - `readTextSync` : 只有同步宿主（Node）能实现。Tauri 桥**必须抛出**可读错误，不得静默返回空串。
 *
 * 宿主装配：
 *   - Electron 主进程 / vitest：`installNodeFsBridge()`（见 `core/fsBridgeNode.ts`）
 *   - Tauri 渲染层：`installTauriFsBridge()`（见 `src/api/fsBridgeTauri.ts`）
 */
export interface DirEntry {
  name: string
  isDir: boolean
  isFile: boolean
}

export interface FileStat {
  isFile: boolean
  size: number
  mtimeMs: number
}

export interface FsBridge {
  readDir(path: string): Promise<DirEntry[]>
  stat(path: string): Promise<FileStat>
  readText(path: string): Promise<string>
  readHead(path: string, maxBytes: number): Promise<string>
  readTextSync(path: string): string
}

let installed: FsBridge | null = null

/** 由宿主在启动时调用一次。 */
export function setFsBridge(bridge: FsBridge): void {
  installed = bridge
}

/** 取当前桥。未安装时抛出可操作的错误（而不是让调用点收到 undefined 后再炸）。 */
export function fsBridge(): FsBridge {
  if (!installed) {
    throw new Error(
      'FsBridge 未安装：Node 侧请调用 installNodeFsBridge()；Tauri 渲染层请调用 ' +
        'installTauriFsBridge()；测试由 vitest setupFiles 自动安装。',
    )
  }
  return installed
}

/** 仅测试用：卸下当前桥，验证"未安装"路径或做隔离。 */
export function clearFsBridge(): void {
  installed = null
}
