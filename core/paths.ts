/**
 * 极小的跨平台路径工具。
 *
 * 为什么不直接用 `node:path`：`core/` 要能被打进 Tauri 的浏览器 bundle（见 `core/fsBridge.ts`
 * 的说明），`node:path` 同样会被 Vite 外部化。这里只实现本仓库真正用到的三个操作。
 *
 * **平台语义（这是本文件最容易出错的地方）**：`node:path` 是**平台相关**的 ——
 *   - POSIX：只有 `/` 是分隔符，`\` 是普通文件名字符（`path.basename('a\\b') === 'a\\b'`）；
 *   - Windows：`/` 与 `\` 都是分隔符，且 `C:` 盘符前缀、UNC（`\\server\share\`）要特殊处理。
 * 因此 `baseName` / `dirName` 各实现 `path.posix.*` 与 `path.win32.*` 两套算法，按平台选择。
 * 平台由 `hostPathPlatform()` 在运行时探测：Node / Electron 主进程读 `process.platform`，
 * Tauri 渲染层没有 `process`，退回 `navigator.userAgent`。也可由调用方显式传入
 * `platform` 参数（测试就是靠它在一台机器上同时钉住两个平台）。
 *
 * 本模块**不 import 任何 `node:` 模块**（这正是它存在的原因），只用 `globalThis` 上的
 * `process` / `navigator` 做**带守卫**的读取，浏览器与 Node 下都安全。
 *
 * 与 `node:path` 的**有意差异**（只此一处，且在实际调用点不可达）：
 *   - `joinPath` 仍是「已知的绝对目录 + 文件名」的简单拼接：分隔符统一 `/`，并且**不做**
 *     词法折叠（`.` / `..`）。`node:path.join` 会折叠；本仓库的调用点只传 `readdir`
 *     给出的名字（不含 `.`/`..`）与固定段，故该差异不可达。刻意保留简单的拼接语义，
 *     并把差异钉在 `test/paths.test.ts` 里（而不是把 `path.join` 的 win32 normalize /
 *     保留设备名 / CVE 处理整体搬进 `core/`）。
 */

/** 与 `node:path` 对齐的两套语义。`posix` 对应 `path.posix`，`win32` 对应 `path.win32`。 */
export type PathPlatform = 'posix' | 'win32'

interface HostGlobals {
  process?: { platform?: unknown }
  navigator?: { userAgent?: unknown }
}

/**
 * 探测宿主平台。
 *
 * 顺序有讲究：**先信 `process.platform`**。Node 21+ 也有 `navigator`，但它的 userAgent 是
 * `"Node.js/22"` —— 在 Windows 的 Node 上先查 userAgent 会误判成 posix。`process.platform`
 * 只有已知平台字符串才采信；`'browser'`/空串之类的打包器垫片一律不认，退回 userAgent。
 */
export function hostPathPlatform(): PathPlatform {
  const g = globalThis as unknown as HostGlobals
  const proc = g.process?.platform
  if (proc === 'win32') return 'win32'
  if (typeof proc === 'string' && proc.length > 0 && proc !== 'browser') return 'posix'
  const ua = g.navigator?.userAgent
  if (typeof ua === 'string' && ua.includes('Windows')) return 'win32'
  return 'posix'
}

const CHAR_FORWARD_SLASH = 0x2f
const CHAR_BACKWARD_SLASH = 0x5c
const CHAR_COLON = 0x3a

function isWin32Separator(code: number): boolean {
  return code === CHAR_FORWARD_SLASH || code === CHAR_BACKWARD_SLASH
}

/** `node:path` 的 `isWindowsDeviceRoot`：盘符只认 A–Z / a–z。 */
function isWindowsDeviceRoot(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)
}

/**
 * 拼接路径片段。空片段被忽略，重复分隔符被折叠。分隔符统一用 `/`
 * （Windows 的 fs API 与 Node 的 `path.win32` 都接受 `/`）。
 */
export function joinPath(...parts: string[]): string {
  return parts
    .filter((p) => p !== '')
    .join('/')
    .replace(/\/{2,}/g, '/')
}

/**
 * `child` 是否落在 `parent` 目录内（含 parent 自身）。用于判定「这个路径在不在宿主放行给
 * WebView 原生读取的目录里」—— 放行范围是一段前缀，所以判定必须按**路径段**而不是字符串前缀：
 * `/a/bc` 不在 `/a/b` 里（字符串前缀会误判成在）。
 *
 * 分隔符先归一（`/` 与 `\\` 都当分隔符，与 `joinPath` 一致）；Windows 路径大小写不敏感，
 * 故 win32 下比较时折叠大小写。空 parent → false（宁可判「不在」，走保守路径）。
 */
export function isPathInside(parent: string, child: string, platform: PathPlatform = hostPathPlatform()): boolean {
  const fold = (p: string): string => {
    const norm = p.replace(/[\\/]+/g, '/').replace(/\/+$/, '')
    return platform === 'win32' ? norm.toLowerCase() : norm
  }
  const a = fold(parent)
  const b = fold(child)
  if (a === '') return false
  return b === a || b.startsWith(`${a}/`)
}

/** 取最后一段（文件名）。语义 = `path.posix.basename` / `path.win32.basename`。 */
export function baseName(p: string, platform: PathPlatform = hostPathPlatform()): string {
  return platform === 'win32' ? win32BaseName(p) : posixBaseName(p)
}

/** 取父目录。无分隔符时返回 `.`；语义 = `path.posix.dirname` / `path.win32.dirname`。 */
export function dirName(p: string, platform: PathPlatform = hostPathPlatform()): string {
  return platform === 'win32' ? win32DirName(p) : posixDirName(p)
}

// ---- 以下四个函数逐行对齐 Node 的 lib/path.js（v22）对应实现，不再各自注释 ----

function posixBaseName(p: string): string {
  let start = 0
  let end = -1
  let matchedSlash = true
  for (let i = p.length - 1; i >= 0; --i) {
    if (p.charCodeAt(i) === CHAR_FORWARD_SLASH) {
      if (!matchedSlash) {
        start = i + 1
        break
      }
    } else if (end === -1) {
      matchedSlash = false
      end = i + 1
    }
  }
  return end === -1 ? '' : p.slice(start, end)
}

function win32BaseName(p: string): string {
  let start = 0
  let end = -1
  let matchedSlash = true

  // 先跳过盘符，免得把紧随其后的分隔符当成「结尾的多余分隔符」而丢掉整段。
  if (p.length >= 2 && isWindowsDeviceRoot(p.charCodeAt(0)) && p.charCodeAt(1) === CHAR_COLON) {
    start = 2
  }

  for (let i = p.length - 1; i >= start; --i) {
    if (isWin32Separator(p.charCodeAt(i))) {
      if (!matchedSlash) {
        start = i + 1
        break
      }
    } else if (end === -1) {
      matchedSlash = false
      end = i + 1
    }
  }
  return end === -1 ? '' : p.slice(start, end)
}

function posixDirName(p: string): string {
  if (p.length === 0) return '.'
  const hasRoot = p.charCodeAt(0) === CHAR_FORWARD_SLASH
  let end = -1
  let matchedSlash = true
  for (let i = p.length - 1; i >= 1; --i) {
    if (p.charCodeAt(i) === CHAR_FORWARD_SLASH) {
      if (!matchedSlash) {
        end = i
        break
      }
    } else {
      // 见到了第一个非分隔符字符
      matchedSlash = false
    }
  }
  if (end === -1) return hasRoot ? '/' : '.'
  if (hasRoot && end === 1) return '//'
  return p.slice(0, end)
}

function win32DirName(p: string): string {
  const len = p.length
  if (len === 0) return '.'
  let rootEnd = -1
  let offset = 0
  const code = p.charCodeAt(0)

  if (len === 1) {
    // 只有分隔符一个字符时直接返回它（对齐 Node 的提前退出）
    return isWin32Separator(code) ? p : '.'
  }

  // 先匹配根：UNC（`\\server\share`）或盘符（`C:` / `C:\`）
  if (isWin32Separator(code)) {
    rootEnd = offset = 1
    if (isWin32Separator(p.charCodeAt(1))) {
      let j = 2
      let last = j
      while (j < len && !isWin32Separator(p.charCodeAt(j))) j++
      if (j < len && j !== last) {
        last = j
        while (j < len && isWin32Separator(p.charCodeAt(j))) j++
        if (j < len && j !== last) {
          last = j
          while (j < len && !isWin32Separator(p.charCodeAt(j))) j++
          if (j === len) {
            // 整条就是 UNC 根
            return p
          }
          if (j !== last) {
            // UNC 根之后还有内容：把根后那个分隔符也算进 rootEnd
            rootEnd = offset = j + 1
          }
        }
      }
    }
  } else if (isWindowsDeviceRoot(code) && p.charCodeAt(1) === CHAR_COLON) {
    rootEnd = len > 2 && isWin32Separator(p.charCodeAt(2)) ? 3 : 2
    offset = rootEnd
  }

  let end = -1
  let matchedSlash = true
  for (let i = len - 1; i >= offset; --i) {
    if (isWin32Separator(p.charCodeAt(i))) {
      if (!matchedSlash) {
        end = i
        break
      }
    } else {
      // 见到了第一个非分隔符字符
      matchedSlash = false
    }
  }

  if (end === -1) {
    if (rootEnd === -1) return '.'
    end = rootEnd
  }
  return p.slice(0, end)
}
