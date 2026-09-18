#!/usr/bin/env node
// 产物体积护栏 —— 防迁移收益静默反弹（Electron .app 197 MB → Tauri .app 9.20 MiB，见迁移方案 §9）。
//
// 两件事：
//   1) 运行时依赖白名单（始终检查，零成本，可安全放进 ci）
//   2) 渲染层产物体积上限（仅当 out/tauri-renderer 存在时检查；--require-renderer 要求必须存在）
//
// 为什么不再查 app.asar：Electron 壳已随全量迁移完成删除，asar 这个产物不再存在。
// 现在前端全部由 Vite 打进 out/tauri-renderer（= tauri.conf.json 的 frontendDist），
// 所以护栏改成量它的体积 —— 它才是「依赖被重复打进包」会立刻变胖的地方。
//
// 入口：just assert-size（宽松）/ just assert-size-strict（要求已有渲染层产物）
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

/** 唯一允许留在 package.json `dependencies` 的 npm 包 */
const RUNTIME_DEP_ALLOWLIST = ['@tauri-apps/plugin-dialog']
const DEFAULT_MAX_MB = 2
const BYTES_PER_MB = 1024 * 1024

const ROOT = process.cwd()
const STRICT = process.argv.includes('--require-renderer')

function fail(msg) {
  console.error(`[bundle-budget] ✗ ${msg}`)
  process.exit(1)
}

// ── 1) 运行时依赖白名单 ──────────────────────────────────────────────
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const deps = Object.keys(pkg.dependencies || {}).sort()
const expected = [...RUNTIME_DEP_ALLOWLIST].sort()

if (JSON.stringify(deps) !== JSON.stringify(expected)) {
  const extra = deps.filter((d) => !expected.includes(d))
  const missing = expected.filter((d) => !deps.includes(d))
  fail(
    `package.json 的 dependencies 必须恰好是 [${expected.join(', ')}]，实际是 [${deps.join(', ')}]` +
      (extra.length ? `\n    多出（渲染层依赖应由 Vite 打进 out/tauri-renderer）: ${extra.join(', ')}` : '') +
      (missing.length ? `\n    缺少（会被打包/分发）: ${missing.join(', ')}` : '') +
      `\n    测试期依赖（gpt-tokenizer 等）应放 devDependencies。`,
  )
}
console.log(`[bundle-budget] ✓ 运行时依赖白名单: [${deps.join(', ')}]`)

// ── 2) 渲染层产物体积 ───────────────────────────────────────────────
function dirSize(dir) {
  let total = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) total += dirSize(p)
    else if (e.isFile()) total += statSync(p).size
  }
  return total
}

const renderer = join(ROOT, 'out', 'tauri-renderer')
if (!existsSync(renderer)) {
  const why = 'out/tauri-renderer 不存在（先跑 npm run build:renderer）'
  if (STRICT) fail(why)
  console.log(`[bundle-budget] ⏭  跳过渲染层体积检查：${why}`)
  process.exit(0)
}

const limit = Number(process.env.CC_RENDERER_MAX_MB || DEFAULT_MAX_MB)
if (!Number.isFinite(limit) || limit <= 0) fail(`CC_RENDERER_MAX_MB 非法: ${process.env.CC_RENDERER_MAX_MB}`)

const mb = dirSize(renderer) / BYTES_PER_MB
if (mb > limit) {
  fail(
    `out/tauri-renderer 体积 ${mb.toFixed(2)} MB 超过上限 ${limit} MB —— 大概率有依赖被重复打进渲染层。` +
      `\n    排查：npx vite-bundle-visualizer --config vite.tauri.config.ts`,
  )
}
console.log(`[bundle-budget] ✓ out/tauri-renderer ${mb.toFixed(2)} MB (上限 ${limit} MB)`)
console.log('[bundle-budget] ✅ 通过')
