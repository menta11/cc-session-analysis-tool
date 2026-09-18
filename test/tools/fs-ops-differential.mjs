#!/usr/bin/env node
/**
 * `fs_ops` ↔ Node 参考实现的差分核验 —— 驱动脚本（跑 Node 侧 + 拉起 Rust 侧 + 逐项比）。
 *
 * 背景：`src-tauri/src/fs_ops.rs` 的「语义严格对齐 Node」是读 Node 源码**推理**出来的，
 * 从未被同输入差分验证过（方案文档 §8bis 的 2026-09-15 轮已把它标注为「未覆盖」）。
 * 本脚本把同一批语料同时喂给两侧：
 *   - Node 侧：`core/fsBridgeNode.ts`（esbuild 现打成 ESM 后动态 import）
 *   - Rust 侧：`cargo test --test fs_ops_differential -- --ignored`（见该文件的协议说明）
 * 然后逐项比**完整结果**（`{ok,value}` / `{ok:false,errnoName}`）。
 *
 * 用法（仓库根）：
 *   node test/tools/fs-ops-differential.mjs
 * 环境变量：
 *   CCSA_FS_DIFF_KEEP=1      跑完保留临时语料目录并打印路径（排查用）
 *   CCSA_FS_DIFF_SELFTEST=1  只验证「差分本身能报出差异」：把某条 Node 结果改一个字符，
 *                            要求 harness 恰好在那条上报 value mismatch
 * 退出码：0 = 全部匹配（或自检通过）；1 = 有 mismatch / 探针自身出错。
 *
 * **归一化声明**（只归一层与语义无关的传输差异，别的都不动）：
 *   1. 错误**只比 errno 名**（Node `err.code` vs Rust `… (os error N)` 反推），不比错误文案 ——
 *      文案来自各自运行时，不是同一信息源（同方案文档 §5 第 13 条的口径）。
 *   2. `stat.mtimeMs` 额外算一个「截到整毫秒后是否相等」，用来把「仅亚毫秒精度」从真值差异里
 *      分离出来；**但截断本身仍记为 mismatch**，不用归一化把差异抹掉。
 *   3. `readDir` 额外按名字排序后再比一次，用来把「集合/标志不同」与「仅顺序不同」分开报；
 *      **原始顺序仍然入账**。
 */
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { readFile, stat as statAsync, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const KEEP = process.env.CCSA_FS_DIFF_KEEP === '1'
const SELFTEST = process.env.CCSA_FS_DIFF_SELFTEST === '1'

const tmp = mkdtempSync(join(tmpdir(), 'ccsa-fsdiff-'))
const corpus = join(tmp, 'corpus')
const permPaths = []

function cleanup() {
  for (const p of permPaths) {
    try {
      chmodSync(p, 0o755)
    } catch {
      /* 已删或不存在 */
    }
  }
  if (!KEEP) rmSync(tmp, { recursive: true, force: true })
}
process.on('exit', cleanup)
process.on('SIGINT', () => process.exit(130))

// ── 语料 ─────────────────────────────────────────────────────────────────────
function write(rel, data) {
  const p = join(corpus, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data))
  return p
}
function perm(rel, mode, data) {
  const p = write(rel, data)
  chmodSync(p, mode)
  permPaths.push(p)
  return p
}

mkdirSync(corpus, { recursive: true })
write('normal.jsonl', 'hello\nworld\n')
write('no_trailing_nl.jsonl', 'abc')
write('empty.jsonl', '')
write('only_newline.jsonl', '\n')
write('long_line.jsonl', 'a'.repeat(100))
write('win.jsonl', 'aaaa\nbbbb\ncccc\n') // 15 B；cap 0..16 穷举 → 覆盖正好/±1 字节落在换行两侧
write('crlf.jsonl', 'a\r\nb\r\n')
write('crlf_no_trailing.jsonl', 'x\r\ny')
write('lone_cr.jsonl', 'a\rb\n') // 老 Mac 换行：readline 也当行界
// 相邻行界的组合（`\r\r\n`、`\n\r`）：readline 的 crlfDelay=Infinity 把 `\r\n` 当**一个**行界，
// 但前面的 `\r` 自己仍然是一个行界 → 会多出一个空行。手写状态机最容易在这种地方错。
write('mixed_eol.jsonl', 'a\r\n\rb\nc\r')
write('mixed_eol2.jsonl', 'a\r\r\n\nb')
write('bom.jsonl', '\uFEFFhello\n')
write('mb.jsonl', '你好\n世界\n') // 3 字节 UTF-8
write('mb2.jsonl', 'αβ\nγδ\n') // 2 字节 UTF-8
write('emoji.jsonl', '😀x\n😀y\n') // 4 字节 UTF-8
write('invalid_utf8.bin', [0xff, 0xfe, 0x41, 0x0a, 0x62, 0x62, 0x0a])
write('truncated_utf8.bin', [0x41, 0x0a, 0xe4, 0xb8]) // 尾部截断的多字节序列
write('overlong_utf8.bin', [0xc0, 0x80, 0x41]) // 过长编码
write('surrogate_utf8.bin', [0xed, 0xa0, 0x80, 0x41]) // CESU-8 代理对
write('bad_cont_utf8.bin', [0xe4, 0x41, 0x42]) // 坏后续字节
write('badbyte_in_jsonl.jsonl', Buffer.concat([Buffer.from('{"type":"system"}\n'), Buffer.from([0xff]), Buffer.from('\n{"type":"user"}\n')]))
write('sub/inner.jsonl', 'x\n')
write('a/b/c/d/e/f/g/deep.jsonl', 'd\n')
write('会 话 名 (1).jsonl', 'u\n') // unicode + 空格文件名
write('many/zz.txt', '1')
write('many/a.txt', '1')
write('many/m.txt', '1')
write('many/00.txt', '1')
write('many/Z.txt', '1')
write('many/A.txt', '1')
write('many/中文.txt', '1')
write('many/zzz.txt', '1')
write('many/0.txt', '1')
write('many/_underscore.txt', '1')
write('many/dash-name.txt', '1')
write('many/dot.name.txt', '1')

// 「上限口径」的物料性反例：前 24 行是多字节噪音（system，不占 extractSessionMeta 的行配额），
// 第 25 行带 cwd。cap=2000：Node 按 UTF-16 单元能读到第 25 行（1922 ≤ 2000），
// Rust 按字节只读到第 11 行（第 12 行末 2124 > 2000）→ 第 25 行的 cwd 在 Rust 侧丢失。
// 每行 = 24 ASCII + 50 个「你」(各 3 B) + 2 ASCII + 换行 = 177 B / 77 UTF-16 单元。
const filler = () => '{"type":"system","pad":"' + '你'.repeat(50) + '"}\n'
let capmat = ''
for (let i = 0; i < 24; i++) capmat += filler()
capmat += '{"type":"user","cwd":"/real/cwd-from-line-25","message":{"content":"hi"}}\n'
for (let i = 0; i < 5; i++) capmat += filler()
write('cap_unit_material.jsonl', capmat)

// 真实会话形状的换行差异 → 让「物料性」判据有意义的负例/正例（否则一堆非法 JSONL 文件喂
// extractSessionMeta 只会两边都得到 {}，那种"匹配"什么都没证明）。
const eventLines = [
  '{"type":"assistant","cwd":"/real/project"}',
  '{"type":"custom-title","customTitle":"我的会话"}',
  '{"type":"ai-title","aiTitle":"AI 标题"}',
  '{"type":"user","message":{"content":"你好，请解释这段代码"}}',
]
write('session_lf.jsonl', eventLines.join('\n') + '\n')
write('session_crlf.jsonl', eventLines.join('\r\n') + '\r\n')
write('session_no_trailing_nl.jsonl', eventLines.join('\n'))

// 写盘用例：两侧各写各的目录（路径里的 {SIDE} 由 Rust 测试 / 本脚本分别替换）。
const wdir = (side) => join(tmp, 'writes', side)
for (const side of ['node', 'rust']) mkdirSync(wdir(side), { recursive: true })
for (const side of ['node', 'rust']) writeFileSync(join(wdir(side), 'overwrite.txt'), 'x'.repeat(100))

symlinkSync(join(corpus, 'normal.jsonl'), join(corpus, 'link_to_file'))
symlinkSync(join(corpus, 'sub'), join(corpus, 'link_to_dir'))
symlinkSync(join(corpus, 'nope-target'), join(corpus, 'link_dangling'))
perm('perm_denied.jsonl', 0o000, 'secret\n')
mkdirSync(join(corpus, 'perm_denied_dir'), { recursive: true })
write('perm_denied_dir/inside.jsonl', 's\n')
chmodSync(join(corpus, 'perm_denied_dir'), 0o000)
permPaths.push(join(corpus, 'perm_denied_dir'))

const P = (rel) => join(corpus, rel)
const cases = []
const add = (id, func, path, maxBytes, extra) => {
  const c = { id, func }
  if (path !== undefined) c.path = path
  if (maxBytes !== undefined) c.max_bytes = maxBytes
  if (extra) Object.assign(c, extra)
  cases.push(c)
}

// read_head：window.jsonl 穷举 0..17（正好/±1 落在换行两侧）
for (let cap = 0; cap <= 17; cap++) add(`read_head/win/${cap}`, 'read_head', P('win.jsonl'), cap)
for (const f of ['crlf.jsonl', 'crlf_no_trailing.jsonl', 'lone_cr.jsonl']) {
  for (let cap = 0; cap <= 8; cap++) add(`read_head/${f}/${cap}`, 'read_head', P(f), cap)
}
// 相邻行界的组合穷举 0..10（覆盖每个行界 ±1）
for (const f of ['mixed_eol.jsonl', 'mixed_eol2.jsonl']) {
  for (let cap = 0; cap <= 10; cap++) add(`read_head/${f}/${cap}`, 'read_head', P(f), cap)
}
for (let cap = 0; cap <= 16; cap++) add(`read_head/mb/${cap}`, 'read_head', P('mb.jsonl'), cap)
for (let cap = 0; cap <= 12; cap++) add(`read_head/mb2/${cap}`, 'read_head', P('mb2.jsonl'), cap)
for (let cap = 0; cap <= 12; cap++) add(`read_head/emoji/${cap}`, 'read_head', P('emoji.jsonl'), cap)
for (const cap of [0, 1, 2, 3, 4, 5, 100, 101, 102, 4096]) add(`read_head/no_trailing_nl/${cap}`, 'read_head', P('no_trailing_nl.jsonl'), cap)
for (const cap of [0, 1, 2, 4096]) add(`read_head/empty/${cap}`, 'read_head', P('empty.jsonl'), cap)
for (const cap of [0, 1, 2, 3, 4096]) add(`read_head/only_newline/${cap}`, 'read_head', P('only_newline.jsonl'), cap)
for (const cap of [0, 1, 4, 99, 100, 101, 4096]) add(`read_head/long_line/${cap}`, 'read_head', P('long_line.jsonl'), cap)
add('read_head/cap_unit_material/2000', 'read_head', P('cap_unit_material.jsonl'), 2000)
for (const f of ['bom.jsonl', 'invalid_utf8.bin', 'truncated_utf8.bin', 'overlong_utf8.bin', 'surrogate_utf8.bin', 'bad_cont_utf8.bin', 'badbyte_in_jsonl.jsonl', 'sub/inner.jsonl', 'a/b/c/d/e/f/g/deep.jsonl', '会 话 名 (1).jsonl', 'link_to_file']) {
  add(`read_head/${f}/4096`, 'read_head', P(f), 4096)
}
for (const [rel, cap] of [['nope.jsonl', 16], ['perm_denied.jsonl', 16], ['sub', 16], ['link_dangling', 16], ['link_to_dir', 16], ['perm_denied_dir', 16]]) {
  add(`read_head/${rel}/${cap}`, 'read_head', P(rel), cap)
}
for (const f of ['session_lf.jsonl', 'session_crlf.jsonl', 'session_no_trailing_nl.jsonl']) {
  add(`read_head/${f}/4096`, 'read_head', P(f), 4096)
}

// write_text 对齐 fs.writeFile(path, text, 'utf8')（迁移前的 Electron 主进程就是这么写的；该壳已删除）
add('write_text/fresh', 'write_text', join(tmp, 'writes/{SIDE}/fresh.txt'), undefined, { contents: 'hello\n世界\n' })
add('write_text/overwrite_truncate', 'write_text', join(tmp, 'writes/{SIDE}/overwrite.txt'), undefined, { contents: 'short' })
add('write_text/empty', 'write_text', join(tmp, 'writes/{SIDE}/empty.txt'), undefined, { contents: '' })
add('write_text/missing_parent', 'write_text', join(tmp, 'writes/{SIDE}/no/such/dir/f.txt'), undefined, { contents: 'x' })
add('write_text/perm_parent', 'write_text', P('perm_denied_dir/f.txt'), undefined, { contents: 'x' })
add('write_text/onto_dir', 'write_text', join(tmp, 'writes/{SIDE}'), undefined, { contents: 'x' })

// home_dir 对齐 os.homedir()（POSIX 取 HOME）
add('home_dir/set', 'home_dir', undefined, undefined, { home_env: '/sandbox/home' })
// 空串也是「已定义」：Node 走 uv_os_getenv，只区分有/无，不区分空/非空 → 返回 ""；未设置才 getpwuid
add('home_dir/empty', 'home_dir', undefined, undefined, { home_env: '' })
add('home_dir/unset', 'home_dir', undefined, undefined, { unset_home: true })

// read_text
for (const f of ['normal.jsonl', 'empty.jsonl', 'crlf.jsonl', 'bom.jsonl', 'mb.jsonl', 'emoji.jsonl', 'invalid_utf8.bin', 'truncated_utf8.bin', 'overlong_utf8.bin', 'surrogate_utf8.bin', 'bad_cont_utf8.bin', 'sub/inner.jsonl', 'a/b/c/d/e/f/g/deep.jsonl', '会 话 名 (1).jsonl', 'link_to_file', 'nope.jsonl', 'perm_denied.jsonl', 'sub', 'link_dangling', 'perm_denied_dir']) {
  add(`read_text/${f}`, 'read_text', P(f))
}

// stat
for (const f of ['normal.jsonl', 'empty.jsonl', 'sub', 'link_to_file', 'link_to_dir', 'link_dangling', 'nope.jsonl', 'perm_denied.jsonl', 'perm_denied_dir', '会 话 名 (1).jsonl', 'a/b/c/d/e/f/g/deep.jsonl']) {
  add(`stat/${f}`, 'stat', P(f))
}
add('stat/<root>', 'stat', corpus)

// read_dir
for (const f of ['<root>', 'sub', 'many', 'a', 'perm_denied_dir', 'nope', 'normal.jsonl', 'link_to_dir', 'link_dangling']) {
  add(`read_dir/${f}`, 'read_dir', f === '<root>' ? corpus : P(f))
}

const manifest = { corpus, cases }
writeFileSync(join(tmp, 'manifest.json'), JSON.stringify(manifest))
console.log(`[fsdiff] 语料 ${cases.length} 条用例 → ${corpus}`)

// ── Node 侧 ──────────────────────────────────────────────────────────────────
const entry = join(tmp, 'entry.ts')
writeFileSync(
  entry,
  `export { nodeFsBridge } from ${JSON.stringify(join(REPO, 'core/fsBridgeNode.ts'))}\n` +
    `export { extractSessionMeta } from ${JSON.stringify(join(REPO, 'core/discovery/scan.ts'))}\n`,
)
const bundle = join(tmp, 'bundle.mjs')
execFileSync(join(REPO, 'node_modules/.bin/esbuild'), [entry, '--bundle', '--format=esm', '--platform=node', `--outfile=${bundle}`, '--log-level=warning'], { cwd: REPO, stdio: ['ignore', 'inherit', 'inherit'] })
const { nodeFsBridge, extractSessionMeta } = await import(pathToFileURL(bundle).href)

async function runNode(c) {
  try {
    let value
    if (c.func === 'read_dir') {
      value = (await nodeFsBridge.readDir(c.path)).map((e) => ({ name: e.name, isDir: e.isDir, isFile: e.isFile }))
    } else if (c.func === 'stat') {
      const s = await nodeFsBridge.stat(c.path)
      value = { isFile: s.isFile, size: s.size, mtimeMs: s.mtimeMs }
    } else if (c.func === 'read_text') {
      value = await nodeFsBridge.readText(c.path)
    } else if (c.func === 'read_head') {
      value = await nodeFsBridge.readHead(c.path, c.max_bytes)
    } else if (c.func === 'write_text') {
      // 参考实现：Electron 版保存报告用的就是 fs.writeFile(path, text, 'utf8')
      const p = c.path.replace('{SIDE}', 'node')
      await writeFile(p, c.contents ?? '', 'utf8')
      let readBack = null
      let sizeBytes = null
      try {
        readBack = await readFile(p, 'utf8')
        sizeBytes = (await statAsync(p)).size
      } catch {
        /* 写成功但读回失败 —— 保留 null，让差异显形 */
      }
      value = { readBack, sizeBytes }
    } else if (c.func === 'home_dir') {
      const saved = process.env.HOME
      if (c.unset_home) delete process.env.HOME
      else process.env.HOME = c.home_env ?? ''
      try {
        value = homedir()
      } finally {
        if (saved === undefined) delete process.env.HOME
        else process.env.HOME = saved
      }
    } else {
      throw new Error(`未知 func ${c.func}`)
    }
    return { ok: true, value }
  } catch (e) {
    return { ok: false, raw: e.message, errnoName: e.code ?? null }
  }
}

const nodeResults = new Map()
for (const c of cases) nodeResults.set(c.id, await runNode(c))

// 前置条件自检：chmod 000 必须真的挡住读取，否则「权限」用例是假命题（root 下会恒 EACCES 不成立）
const permProbe = nodeResults.get('read_text/perm_denied.jsonl')
const permDirProbe = nodeResults.get('read_dir/perm_denied_dir')
const permsEffective = !permProbe.ok && permProbe.errnoName === 'EACCES' && !permDirProbe.ok && permDirProbe.errnoName === 'EACCES'
console.log(`[fsdiff] 权限用例前置条件（chmod 000 真的挡住读）: ${permsEffective ? '成立' : '不成立 —— 权限用例不可信'}`)

// ── Rust 侧 ──────────────────────────────────────────────────────────────────
let cargoOut
try {
  cargoOut = execFileSync('cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--test', 'fs_ops_differential', '--', '--ignored', '--nocapture'], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, CCSA_FS_DIFF_DIR: tmp },
    maxBuffer: 64 * 1024 * 1024,
  })
} catch (e) {
  console.error('[fsdiff] cargo test 失败：')
  console.error(e.stdout || '')
  console.error(e.stderr || '')
  process.exit(1)
}
if (!cargoOut.includes('fs_ops_differential: 写出')) {
  console.error('[fsdiff] cargo test 输出里没有探针的完成标记 —— 探针可能没被真正执行（拒绝在无声中判绿）')
  console.error(cargoOut)
  process.exit(1)
}
const rustDump = JSON.parse(readFileSync(join(tmp, 'rust.json'), 'utf8'))
if (rustDump.caseCount !== cases.length || rustDump.results.length !== cases.length) {
  console.error(`[fsdiff] Rust 侧用例数 ${rustDump.results.length} ≠ manifest ${cases.length}（拒绝在缺数据时判绿）`)
  process.exit(1)
}
const rustResults = new Map(rustDump.results.map((r) => [r.id, r.result]))
for (const c of cases) {
  if (!rustResults.has(c.id)) {
    console.error(`[fsdiff] Rust 侧缺用例 ${c.id}`)
    process.exit(1)
  }
}
console.log(`[fsdiff] Rust 侧 ${rustResults.size} 条结果已读回`)

// ── 差分 ─────────────────────────────────────────────────────────────────────
// 规范序列化：对象键**递归排序**。这一层归一化是必须的、且与语义无关 —— `DirEntryInfo` 经 serde
// 到 JSON 后的键序（Rust 侧 `json!` 用 BTreeMap 得字典序）与 Node 对象字面量序不同，而
// `src/api/fsBridgeTauri.ts` 两边都会 map 成同一个 TS 形状；不归一化会产生**假 mismatch**（本轮实测过）。
// 数组顺序**保持不动** —— readDir 的返回顺序是真实可观测语义。
function canon(v) {
  if (Array.isArray(v)) return v.map(canon)
  if (v && typeof v === 'object') {
    const o = {}
    for (const k of Object.keys(v).sort()) o[k] = canon(v[k])
    return o
  }
  return v
}
const j = (v) => JSON.stringify(canon(v))
function classify(c, n, r) {
  if (SELFTEST && c.id === 'read_text/normal.jsonl') n = { ok: true, value: n.value + 'X' } // 只用于证伪 harness
  if (n.ok !== r.ok) return { kind: 'ok-differs' }
  if (!n.ok && !r.ok) return n.errnoName === r.errnoName ? { kind: 'match' } : { kind: 'errno-differs' }
  if (c.func === 'read_dir') {
    const key = (a) => j([...a].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0)))
    if (key(n.value) !== key(r.value)) return { kind: 'value' }
    if (j(n.value) !== j(r.value)) return { kind: 'order-only' }
    return { kind: 'match' }
  }
  if (c.func === 'stat') {
    const nv = n.value
    const rv = r.value
    if (nv.isFile === rv.isFile && nv.size === rv.size && nv.mtimeMs === rv.mtimeMs) return { kind: 'match' }
    if (nv.isFile === rv.isFile && nv.size === rv.size && Math.floor(nv.mtimeMs) === rv.mtimeMs) return { kind: 'mtime-subms' }
    return { kind: 'value' }
  }
  return j(n.value) === j(r.value) ? { kind: 'match' } : { kind: 'value' }
}

const rows = []
for (const c of cases) {
  const n = nodeResults.get(c.id)
  const r = rustResults.get(c.id)
  const cls = classify(c, n, r)
  rows.push({ c, n, r, ...cls })
}
const mismatches = rows.filter((x) => x.kind !== 'match')
const byKind = {}
for (const x of mismatches) byKind[x.kind] = (byKind[x.kind] ?? 0) + 1

// ── 物料性：value 差异是否真的影响 scan.ts 的 extractSessionMeta ──────────────
// read_head 是唯一被 readSessionMeta 消费的原语；Node 侧它自己解析自己的返回，Rust 侧同字符串。
// 若 Rust 抛错，则 readSessionMeta 的 catch 会返回 {}（模拟该上层语义），这也要计入。
function metaOf(res) {
  if (!res.ok) return {}
  const m = extractSessionMeta(res.value)
  return JSON.parse(JSON.stringify(m))
}
const material = []
for (const x of rows) {
  if (x.c.func !== 'read_head' || x.kind === 'match') continue
  if (j(metaOf(x.n)) !== j(metaOf(x.r))) material.push(x)
}

// ── 独立不变量：Rust 的 `read_head`「返回原文行序列的**极大**前缀」──────────────
// fs_ops.rs 的承诺。判据**不依赖 Node 的返回值**，只看原文（经 `nodeFsBridge.readText` 读同一文件）：
//   1) 非空返回值必须以 `\n` 结尾（Node 是 `join('\n') + '\n'`），且去掉尾 `\n` 后是原文行序列的前缀；
//   2) 该前缀必须是**极大**的 —— 若原文还有下一行，把它的 cost 加进去就应超出 cap。
// 第 2 条是关键：它独立刻画了「配额」本身，能抓住「少读了一行」这类错误 —— 即使 Node 侧与 Rust 侧
// 同时错也抓得住。旧的「绝不给半行」判据在实现改成 Node 语义后变成**恒真**（非空必以 \n 结尾），
// 留着只是装饰（本项目第 8 次「判据覆盖错表面」的同源风险），故换成这条可失败性更强的。
// 等价性说明：`readText` 的有损解码与 readline 的流式解码一致（`\n` / `\r` 不可能出现在多字节序列
// 内部），所以「整文件解码后再按行界切」与 readline 逐行给的结果相同。
const fullTextCache = new Map()
async function fullText(p) {
  if (!fullTextCache.has(p)) {
    try {
      fullTextCache.set(p, await nodeFsBridge.readText(p))
    } catch {
      fullTextCache.set(p, null) // 读不了（权限 / 被删）→ 这条用例跳过判据
    }
  }
  return fullTextCache.get(p)
}
/** 原文按 readline 的行界切出来的行（文件以行界结尾时不会多出一个空行）。 */
function fileLines(full) {
  if (full === '') return []
  const parts = full.split(/\r\n|\n|\r/)
  if (/[\r\n]$/.test(full)) parts.pop()
  return parts
}
const costOf = (line) => line.length + 1 // UTF-16 单元 + 1，与 Node 的记账口径一致
const invViolations = []
for (const c of cases) {
  if (c.func !== 'read_head') continue
  const r = rustResults.get(c.id)
  if (!r.ok) continue
  const full = await fullText(c.path)
  if (full === null) continue
  const fl = fileLines(full)
  const got = r.value
  if (got === '') {
    // 空串合法：原文一行都没有，或第一行本身就超配额
    if (fl.length > 0 && costOf(fl[0]) <= c.max_bytes) {
      invViolations.push({ id: c.id, why: `空串但第一行 cost=${costOf(fl[0])} ≤ cap=${c.max_bytes}` })
    }
    continue
  }
  if (!got.endsWith('\n')) {
    invViolations.push({ id: c.id, why: '非空但不以 \\n 结尾' })
    continue
  }
  const gotLines = got.slice(0, -1).split('\n')
  if (gotLines.length > fl.length || gotLines.some((l, i) => l !== fl[i])) {
    invViolations.push({ id: c.id, why: '返回值不是原文行序列的前缀', got: gotLines.slice(0, 40), full: fl.slice(0, 40) })
    continue
  }
  if (gotLines.length < fl.length) {
    const used = gotLines.reduce((a, l) => a + costOf(l), 0)
    const nextCost = costOf(fl[gotLines.length])
    if (used + nextCost <= c.max_bytes) {
      invViolations.push({
        id: c.id,
        why: `前缀不是极大的：used=${used} + 下一行 ${nextCost} ≤ cap=${c.max_bytes}`,
        next: fl[gotLines.length].slice(0, 80),
      })
    }
  }
}

// ── 输出 ─────────────────────────────────────────────────────────────────────
const short = (s) => (s.length > 240 ? `${s.slice(0, 240)}…(${s.length} 字符)` : s)
console.log('\n===== fs_ops ↔ Node 差分报告 =====')
console.log(`用例数: ${cases.length}   匹配: ${rows.length - mismatches.length}   不匹配: ${mismatches.length}   ${mismatches.length ? JSON.stringify(byKind) : ''}`)
{
  const byFunc = {}
  for (const x of rows) {
    const t = (byFunc[x.c.func] ??= { total: 0, match: 0, mismatch: 0 })
    t.total++
    if (x.kind === 'match') t.match++
    else t.mismatch++
  }
  console.log('按原语: ' + Object.entries(byFunc).map(([f, t]) => `${f} ${t.match}/${t.total} 匹配`).join('  |  '))
}
if (mismatches.length) {
  console.log('\n-- 不匹配明细 --')
  for (const x of mismatches) {
    console.log(`[${x.kind}] ${x.c.id}`)
    console.log(`    Node: ${x.n.ok ? short(j(x.n.value)) : `ERR ${x.n.errnoName} ${x.n.raw}`}`)
    console.log(`    Rust: ${x.r.ok ? short(j(x.r.value)) : `ERR ${x.r.errnoName} ${x.r.raw}`}`)
  }
}
console.log(`\n-- read_head 独立不变量（返回值 = 原文行序列的极大前缀）-- 违反 ${invViolations.length} 条`)
for (const v of invViolations) console.log(`   ! ${v.id} ${v.why}`)
console.log('\n-- read_head 不匹配的「物料性」（喂 extractSessionMeta 后是否仍不同）--')
console.log(`   read_head 不匹配 ${rows.filter((x) => x.c.func === 'read_head' && x.kind !== 'match').length} 条，其中物料（影响解析结果）${material.length} 条`)
for (const x of material) console.log(`   ! 物料: ${x.c.id}  Node-meta=${j(metaOf(x.n))}  Rust-meta=${j(metaOf(x.r))}`)

let pass = mismatches.length === 0 && permsEffective && invViolations.length === 0
if (SELFTEST) {
  const hit = mismatches.some((x) => x.c.id === 'read_text/normal.jsonl' && x.kind === 'value')
  console.log(`\n[SELFTEST] 注入的 read_text/normal.jsonl 一个字符差异被捕获: ${hit ? '是' : '否'}`)
  pass = hit
  console.log(hit ? '[SELFTEST] OK —— 差分确实能报出差异' : '[SELFTEST] FAIL —— 差分对注入差异无反应')
}
if (KEEP) console.log(`\n[fsdiff] 保留临时目录: ${tmp}`)
process.exit(pass ? 0 : 1)
