import { fsBridge, setFsBridge, type FsBridge } from '../../core/fsBridge'
import { installNodeFsBridge } from '../../core/fsBridgeNode'

/** 计数结果：按调用顺序记下被读过的文件路径 */
export interface FsCounters {
  readHeads: string[]
  readTexts: string[]
}

/**
 * 装一层桥：只有 `readHead` / `readText` 可由调用方改写，其余原样透传。
 *
 * 传的是 `(inner) => overrides` 而不是直接传函数 —— 两个调用点都要先抓住**被包住的**桥，
 * 否则在包装层里再调 `fsBridge()` 会拿到包装层自己，直接自引用递归。
 */
function installBridgeWith(
  make: (inner: FsBridge) => Pick<FsBridge, 'readHead' | 'readText'>,
): void {
  const inner = fsBridge()
  const over = make(inner)
  setFsBridge({
    readDir: (p) => inner.readDir(p),
    stat: (p) => inner.stat(p),
    readTextSync: (p) => inner.readTextSync(p),
    readText: over.readText,
    readHead: over.readHead,
  })
}

/**
 * 装一层**计数**桥：记录 `readHead` / `readText` 的调用，其余原样透传。
 *
 * 「启动不读文件内容」「只读被看见的行」这类判据，只有数得出「到底读了谁」才算判据 ——
 * 断言结果对不对是不够的（全读一遍结果也对，只是慢）。
 */
export function installCountingFsBridge(): FsCounters {
  const counters: FsCounters = { readHeads: [], readTexts: [] }
  installBridgeWith((inner) => ({
    readText: (p) => {
      counters.readTexts.push(p)
      return inner.readText(p)
    },
    readHead: (p, max) => {
      counters.readHeads.push(p)
      return inner.readHead(p, max)
    },
  }))
  return counters
}

/**
 * 让 `path` 的 `readHead` 按指定口径**失败**，其余文件照常。
 *
 * 为什么不用 `chmod 0o000` 造权限错：Windows 的 `chmod` 只影响只读位、**不产生不可读**，
 * 文件照常被读到内容，判定就从「读不到 → 不知道」错成「没有记录」。而两个宿主桥的读失败
 * 语义本来就不同，按口径注入才测得到真实的那条路：
 *   - `'empty'`：Node 桥吞掉错误返回空串 → `classifyHasRecords('', size>0)` 判「不知道」
 *   - `'throw'`：Tauri 桥抛错（`fs_ops::read_head` 返回 Err）→ `readSmallHead` catch → null
 *
 * 两条路都该绿，因为生产代码刻意不依赖异常口径。
 */
export function installFailingReadBridge(path: string, mode: 'empty' | 'throw'): void {
  installBridgeWith((inner) => ({
    readText: (p) => inner.readText(p),
    readHead: (p, max) => {
      if (p !== path) return inner.readHead(p, max)
      if (mode === 'throw') throw new Error(`EACCES: 模拟读失败（${path}）`)
      return Promise.resolve('')
    },
  }))
}

/** 还原成 Node 参考实现（每个用例跑完都该还原，避免计数桥漏给后面的用例） */
export function restoreNodeFsBridge(): void {
  installNodeFsBridge()
}
