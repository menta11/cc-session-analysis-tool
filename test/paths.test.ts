import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { baseName, dirName, hostPathPlatform, isPathInside, joinPath } from '../core/paths'
import { parseJsonlText } from '../core/parser/parse'

/**
 * `core/paths.ts` 的存在理由是「`core/` 不能 import `node:path`」（Tauri 渲染层要把
 * `core/` 打进浏览器 bundle）。它的语义必须与 `node:path` **逐平台**一致，否则迁移
 * 会静默改变 `core/` 的算法输出。
 *
 * 本文件用**差分**而不是手写期望：同一批输入同时喂给我们的实现与真正的 `node:path`。
 * Node 的 `node:path` 在测试环境里可用，且 `path.posix` / `path.win32` 允许我们在
 * **一台机器上同时钉住两个平台**的语义 —— 这正是不写手抄期望值的意义：手抄值会把
 * 「我认为 node 会这么给」写死，差分则不会。
 */

const PLATFORMS = ['posix', 'win32'] as const
type Platform = (typeof PLATFORMS)[number]

const nodeBasename = (p: string, platform: Platform): string =>
  platform === 'win32' ? path.win32.basename(p) : path.posix.basename(p)

const nodeDirname = (p: string, platform: Platform): string =>
  platform === 'win32' ? path.win32.dirname(p) : path.posix.dirname(p)

/**
 * 病态输入表。刻意覆盖：字面反斜杠（POSIX 上是普通文件名字符、Windows 上是分隔符）、
 * 尾斜杠、连续分隔符、盘符与 UNC 前缀、`.` / `..` 段、空串、根、多字节与点文件。
 * 其中 `'back\\slash-nosid'` 是 2026-09-15 核验轮给出的**可达反例**：迁移前
 * `path.basename` 在 POSIX 上给出 `back\slash-nosid`，而当时的 `baseName` 给出 `slash-nosid`，
 * 于是 `parse.ts` 的 `sessionId` 兜底跟着变。
 */
const PATH_CASES: string[] = [
  'back\\slash-nosid',
  'a\\b.jsonl',
  'back\\slash.jsonl',
  'a\\b\\c.jsonl',
  'C:\\Users\\x\\f.jsonl',
  'C:',
  'C:\\',
  'C:/x/y',
  '\\\\server\\share\\f',
  '//server/share/f',
  '/a/b/',
  '/a//b//',
  '/a/b',
  '/',
  '//',
  '\\',
  '',
  '.',
  '..',
  '...',
  '.../x',
  './x',
  '/a/./b/../c',
  'a/.',
  'a/..',
  '/a/../b',
  'a',
  '.env',
  '.hidden/.env',
  '会话.jsonl',
  '中文/会话.jsonl',
  'a b/c d.jsonl',
]

/** 确定性伪随机语料：字母表含两种分隔符、冒号、点、空格与多字节字符。 */
function* corpus(): Generator<string> {
  const alphabet = ['a', 'B', 'z', '中', '文', '.', '/', '\\', ':', ' ', '_', '0']
  let s = 0x1a2b3c4d
  const next = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x1_0000_0000
  }
  yield ''
  for (let n = 0; n < 3000; n++) {
    const len = Math.floor(next() * 13)
    let out = ''
    for (let i = 0; i < len; i++) out += alphabet[Math.floor(next() * alphabet.length)]
    yield out
  }
}

/** 把两侧不一致的输入收集成可读清单（而不是只报第一条）。 */
function diffsFor(
  fn: (p: string, platform: Platform) => string,
  nodeFn: (p: string, platform: Platform) => string,
  platform: Platform,
  inputs: Iterable<string>,
): string[] {
  const out: string[] = []
  for (const p of inputs) {
    const ours = fn(p, platform)
    const node = nodeFn(p, platform)
    if (ours !== node) out.push(`${JSON.stringify(p)}: ours=${JSON.stringify(ours)} node=${JSON.stringify(node)}`)
  }
  return out
}

describe('core/paths — baseName 与 node:path.basename 差分（逐平台）', () => {
  for (const platform of PLATFORMS) {
    it(`${platform}: 病态输入表逐条相等`, () => {
      expect(diffsFor(baseName, nodeBasename, platform, PATH_CASES)).toEqual([])
    })

    it(`${platform}: 随机语料（3001 例）逐条相等`, () => {
      expect(diffsFor(baseName, nodeBasename, platform, corpus())).toEqual([])
    })
  }

  it('反例（POSIX 字面反斜杠）不再复现', () => {
    // 迁移前 node 侧：path.basename → 'back\slash-nosid'；修复前我们的实现 → 'slash-nosid'。
    expect(path.posix.basename('back\\slash-nosid')).toBe('back\\slash-nosid')
    expect(baseName('back\\slash-nosid', 'posix')).toBe('back\\slash-nosid')
    // Windows 上同一字符串里 `\` 是分隔符，两边都必须取最后一段：
    expect(baseName('back\\slash-nosid', 'win32')).toBe('slash-nosid')
    expect(path.win32.basename('back\\slash-nosid')).toBe('slash-nosid')
  })
})

describe('core/paths — dirName 与 node:path.dirname 差分（逐平台）', () => {
  for (const platform of PLATFORMS) {
    it(`${platform}: 病态输入表逐条相等`, () => {
      expect(diffsFor(dirName, nodeDirname, platform, PATH_CASES)).toEqual([])
    })

    it(`${platform}: 随机语料（3001 例）逐条相等`, () => {
      expect(diffsFor(dirName, nodeDirname, platform, corpus())).toEqual([])
    })
  }
})

describe('core/paths — 默认平台（不显式传参时）必须与宿主 node:path 一致', () => {
  const hostIsWindows = process.platform === 'win32'

  it('hostPathPlatform() 与 process.platform 对齐', () => {
    expect(hostPathPlatform()).toBe(hostIsWindows ? 'win32' : 'posix')
  })

  it('baseName / dirName 省略 platform 参数时等于宿主 node:path', () => {
    expect(diffsFor(baseName, nodeBasename, hostIsWindows ? 'win32' : 'posix', PATH_CASES)).toEqual([])
    expect(diffsFor(dirName, nodeDirname, hostIsWindows ? 'win32' : 'posix', PATH_CASES)).toEqual([])
  })
})

describe('core/paths — joinPath：可达输入域与 node:path.join 一致，有意偏差显式钉住', () => {
  it('可达形状（绝对目录 + 固定段 + readdir 名字）在 posix 下与 path.posix.join 相等', () => {
    const reachable: string[][] = [
      ['/Users/x', '.claude', 'projects'],
      ['/Users/x/.claude/projects', 'proj-中文', '会话.jsonl'],
      ['/Users/x/.claude/projects/proj', 'subagents', 'workflows', 'run-1'],
      ['/Users/x/.claude/projects/proj', 'agents', 'agent-a.jsonl'],
      ['C:\\Users\\x', '.claude', 'projects'],
    ]
    const diffs = reachable
      .filter((parts) => joinPath(...parts) !== path.posix.join(...parts))
      .map((parts) => `${JSON.stringify(parts)}: ours=${JSON.stringify(joinPath(...parts))}`)
    expect(diffs).toEqual([])
  })

  it('有意偏差（不可达）：win32 分隔符统一 `/`，且不做 `.` / `..` 词法折叠', () => {
    // 调用点只传 readdir 给出的名字（不含 `.`/`..`）与固定段，故下面这些输入不可达。
    // 这里把偏差**显式记下**，避免它被当成「已与 path.join 等价」而误传。
    expect(joinPath('C:\\Users\\x', '.claude')).toBe('C:\\Users\\x/.claude')
    expect(path.win32.join('C:\\Users\\x', '.claude')).toBe('C:\\Users\\x\\.claude')
    expect(joinPath('a', '..', 'b')).toBe('a/../b')
    expect(path.posix.join('a', '..', 'b')).toBe('b')
    expect(joinPath('./x')).toBe('./x')
    expect(path.posix.join('./x')).toBe('x')
    // 空片段被忽略、重复分隔符被折叠 —— 这两条与 path.join 一致。
    expect(joinPath('/a/', '', 'b')).toBe('/a/b')
    expect(path.posix.join('/a/', '', 'b')).toBe('/a/b')
  })
})

describe('core/parser/parse — sessionId 兜底端到端与 node:path.basename 一致', () => {
  // 事件都不带 sessionId，才会走到「用文件名当 sessionId」的兜底分支。
  const noSidEvent = JSON.stringify({
    type: 'user',
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  })

  it('POSIX 下含字面反斜杠的文件名不再被截断', () => {
    const filePath = '/tmp/back\\slash-nosid.jsonl'
    const session = parseJsonlText(noSidEvent, filePath)
    expect(session.sessionId).toBe(path.basename(filePath).replace(/\.jsonl$/, ''))
    if (process.platform !== 'win32') {
      expect(session.sessionId).toBe('back\\slash-nosid')
    } else {
      // Windows 上 `\` 是分隔符，node 侧同样只取最后一段。
      expect(session.sessionId).toBe('slash-nosid')
    }
  })
})

describe('isPathInside（判定路径是否在放行目录内）', () => {
  it('按路径段判定，不做字符串前缀匹配', () => {
    expect(isPathInside('/a/b', '/a/b/c.jsonl', 'posix')).toBe(true)
    expect(isPathInside('/a/b', '/a/b', 'posix')).toBe(true) // 自身算在内
    // 字符串前缀会误判成「在」—— 必须按段
    expect(isPathInside('/a/b', '/a/bc/d.jsonl', 'posix')).toBe(false)
    expect(isPathInside('/a/b', '/a', 'posix')).toBe(false)
    expect(isPathInside('/a/b', '/x/a/b/c', 'posix')).toBe(false)
  })

  it('分隔符与尾斜杠归一；win32 下大小写不敏感', () => {
    expect(isPathInside('/a/b/', '/a/b/c', 'posix')).toBe(true)
    expect(isPathInside('C:\\Users\\me', 'C:\\Users\\me\\.claude\\projects\\p\\s.jsonl', 'win32')).toBe(true)
    expect(isPathInside('C:\\Users\\Me', 'c:\\users\\me\\.claude\\x.jsonl', 'win32')).toBe(true)
    expect(isPathInside('/a/B', '/a/b/c', 'posix')).toBe(false) // posix 下大小写敏感
  })

  it('空 parent → false（判不出就保守说「不在」，调用方回退慢但可靠的那条路）', () => {
    expect(isPathInside('', '/a/b', 'posix')).toBe(false)
  })
})
