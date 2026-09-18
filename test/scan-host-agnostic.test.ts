import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readSessionMeta, scanProjects } from '../core/discovery/scan'
import { yieldToHost } from '../core/yield'

const ROOT = fileURLToPath(new URL('./fixtures/scan-projects', import.meta.url))
const sessFile = (id: string): string => `${ROOT}/proj-a/${id}.jsonl`

/**
 * 回归：`core/` 的扫描/让出不得依赖 **Node 专有全局**。
 *
 * 之前 `scan.ts` 用 `setImmediate` 让出事件循环：vitest 默认跑在 Node 环境，全局存在 → 用例全绿；
 * 而 Tauri 的 WebView 没有它 → `ReferenceError` 让 `scanProjects` 在第一个文件上整体 reject，
 * 列表永久停在「扫描中…」。
 * 这条用例把当时的宿主条件（缺失该全局）复刻出来 —— 用它守住这一类回归。
 */
describe('跨宿主：Node 专有全局缺失时依然可用', () => {
  it('setImmediate 不存在时 scanProjects 仍扫完（骨架）', async () => {
    const sessions = await withoutGlobals(['setImmediate'], () => scanProjects(ROOT))
    expect(sessions.length).toBeGreaterThan(0)
    expect(sessions.some((s) => s.sessionId === 'sess-1')).toBe(true)
  })

  it('setImmediate 不存在时 readSessionMeta 仍能读出元数据', async () => {
    const meta = await withoutGlobals(['setImmediate'], () => readSessionMeta(sessFile('sess-1')))
    expect(meta.cwd).toBe('d:\\project\\请假审批')
    expect(meta.aiTitle).toBe('请假审批系统Spec开发')
  })

  it('setImmediate 不存在时 yieldToHost 仍能完成一轮', async () => {
    await withoutGlobals(['setImmediate'], async () => {
      await yieldToHost()
      await yieldToHost()
    })
  })
})

/** 在「指定全局被删除」的宿主条件下跑 fn，跑完立刻恢复（恢复后再做断言/让 vitest 自己继续） */
async function withoutGlobals<T>(names: string[], fn: () => Promise<T>): Promise<T> {
  const saved = names.map((n) => [n, (globalThis as Record<string, unknown>)[n]] as const)
  for (const n of names) delete (globalThis as Record<string, unknown>)[n]
  try {
    return await fn()
  } finally {
    for (const [n, v] of saved) (globalThis as Record<string, unknown>)[n] = v
  }
}
