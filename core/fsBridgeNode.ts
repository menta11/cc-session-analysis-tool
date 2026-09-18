/**
 * `FsBridge` 的 Node 实现 —— 供 **Node 侧**（vitest setup / Node 单测）使用。
 *
 * ⚠️ 这个文件**不能**被 `src/`（Tauri 渲染层）引用：它 import `node:fs`，
 * 一旦进入浏览器 bundle 就会崩。渲染层用 `src/api/fsBridgeTauri.ts`。
 */
import { createReadStream, readFileSync } from 'node:fs'
import { readdir, readFile, stat as statAsync } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { setFsBridge, type FsBridge } from './fsBridge'

export const nodeFsBridge: FsBridge = {
  async readDir(path) {
    const entries = await readdir(path, { withFileTypes: true })
    // Dirent.isDirectory()/isFile() 是 lstat 语义（不跟随符号链接），与桥的约定一致
    return entries.map((e) => ({ name: e.name, isDir: e.isDirectory(), isFile: e.isFile() }))
  },

  async stat(path) {
    const st = await statAsync(path)
    return { isFile: st.isFile(), size: st.size, mtimeMs: st.mtimeMs }
  },

  async readText(path) {
    return readFile(path, 'utf8')
  },

  /**
   * 行对齐前缀。这里刻意用**流式逐行读 + 行数配额**实现，而不是"整读再切"：
   * 会话文件可能上百 MB，而 `readSessionMeta` 通常只需前几行就能凑齐四个字段。
   *
   * 记账口径沿用改造前 `readSessionMeta` 的原始写法（`line.length + 1`，UTF-16 单元作为安全上界），
   * 保证与旧行为逐字一致。
   */
  async readHead(path, maxBytes) {
    const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
    const lines: string[] = []
    let used = 0
    try {
      for await (const line of rl) {
        const cost = line.length + 1
        if (used + cost > maxBytes) break
        lines.push(line)
        used += cost
      }
    } catch {
      // 读失败（权限 / 被删）→ 返回已读部分，绝不抛出（与 scan 的容错语义一致）
    } finally {
      rl.close()
    }
    return lines.length ? lines.join('\n') + '\n' : ''
  },

  readTextSync(path) {
    return readFileSync(path, 'utf8')
  },
}

/** 安装 Node 桥（幂等）。由 vitest setup（`test/setup/bridges.ts`）调用一次。 */
export function installNodeFsBridge(): void {
  setFsBridge(nodeFsBridge)
}
