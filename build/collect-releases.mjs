#!/usr/bin/env node
// 把 Tauri 的 bundle/ 工作区收拢到 releases/：**平铺，不建子目录**。
//
//   入口：just releases（just package 的每一步末尾也会自动跑）
//
// 为什么需要这一步：交付物路径由 Tauri CLI 决定（`<cargo target>/release/bundle/<格式>/`），
// Tauri v2 没有「输出目录」配置项 —— `--bundles` 只选格式不选位置。所以只能在构建后收一次。
//
// 四条规则：
//   - 只认 package.json 的当前版本：名字里带了别的版本号 → 判定为旧产物，**报错而不是静默搬走**
//     （「0.1.4 的目录里躺着 0.1.3 的包」是这类流程最伤信任的一类错）
//   - 搬（rename）而不是复制：bundle/ 里不再留第二份，磁盘不翻倍
//   - 同一批里重名 = 两个来源产出了同名文件 → 报错，不静默覆盖
//   - bundle/ 里没有当前版本的交付物 → 报错退出，且**一个字节都不动 releases/**
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import process from 'node:process'

const TARGET_ROOT = join(process.cwd(), 'src-tauri/target')
const RELEASES = join(process.cwd(), 'releases')
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const VERSION = pkg.version
const BYTES_PER_MB = 1024 * 1024

/**
 * 产品名与 cargo 的 bin 名都从各自的源头读，不在这里写第二遍 —— 安装包名由 Tauri 从
 * tauri.conf.json 的 productName 推出来，免安装 exe 的名字要以它为准才对得上同一族。
 */
const PRODUCT_NAME = JSON.parse(readFileSync(join(process.cwd(), 'src-tauri/tauri.conf.json'), 'utf8')).productName
const CARGO_BIN = /^\[package\][\s\S]*?^name\s*=\s*"([^"]+)"/m.exec(
  readFileSync(join(process.cwd(), 'src-tauri/Cargo.toml'), 'utf8'),
)?.[1]

/**
 * 是否连 cargo 的裸可执行文件一起收（`--with-app`）。
 *
 * 它是 Windows 的免安装版：不进 `bundle/`，直接躺在 `target/<三元组>/release/` 下。
 * 必须由调用方显式要求，因为**它无法自证新鲜** —— 只跑 `package linux` 时，上一次
 * `package win` 留下的 exe 还躺在那儿，照收就会把陈旧产物当成本次的（同类坑踩过一次）。
 */
const WITH_APP = process.argv.includes('--with-app')

/** 三元组目录名 → 安装包惯用的架构串（与 Tauri 给 setup.exe 用的 `x64` 对齐）。 */
const TRIPLE_ARCH = { x86_64: 'x64', aarch64: 'arm64' }

/**
 * 交付物的后缀（`.app` 是**目录**，同样按后缀认）。
 * 其余一律不是交付物，不收：`dmg/icon.icns` 与 `dmg/bundle_dmg.sh` 是 dmg 的制作素材、
 * `share/create-dmg` 是 Tauri 自带工具、`*.tar.gz`/`*.sig` 只有开了更新器才出现。
 */
const DELIVERABLE_SUFFIXES = ['.app', '.dmg', '.exe', '.msi', '.deb', '.rpm', '.AppImage']

/**
 * create-dmg 的读写临时镜像：`rw.<pid>.<成品名>.dmg`（`bundle_dmg.sh` 里 `DMG_TEMP_NAME`）。
 * 制作成功时它自己删掉；**制作失败就留在 bundle/dmg 里** —— 那不是交付物，只是个半成品镜像，
 * 按后缀收会把它当成品收走（真机上撞过一次：两个 34MB 的 `rw.*` 混进了 releases/）。
 */
const DMG_SCRATCH = /^rw\.\d+\./

/** 名字里的形如 1.2.3 的版本号（没有则 null）：`.app` 不带版本，dmg/exe/deb 带 */
const VERSION_IN_NAME = /\d+\.\d+\.\d+/

/** 这一条是不是当前版本的产物：不带版本号的（`.app`）算「是」，由所在目录整体判断 */
function isCurrentVersion(name) {
  const m = VERSION_IN_NAME.exec(name)
  return m === null || m[0] === VERSION
}

/** 名字里明写了别的版本号 → 旧产物（要拦下，不能混进本轮发布） */
function isOtherVersion(name) {
  const m = VERSION_IN_NAME.exec(name)
  return m !== null && m[0] !== VERSION
}

const isDeliverable = (name) => DELIVERABLE_SUFFIXES.some((s) => name.endsWith(s))

function fail(msg) {
  console.error(`[releases] ✗ ${msg}`)
  process.exit(1)
}

function sizeOf(path) {
  const st = statSync(path)
  if (!st.isDirectory()) return st.size
  return readdirSync(path).reduce((sum, name) => sum + sizeOf(join(path, name)), 0)
}

/**
 * 所有 bundle/ 工作区。**不止一处**：交叉构建的产物落在带三元组的目录里 ——
 * `cargo-xwin` 打 Windows 包写的是 `target/x86_64-pc-windows-msvc/release/bundle/`，
 * 只看 `target/release/bundle/` 会得出「没有交付物」的结论，而安装包其实刚打出来。
 * 判定方式是「该目录下真有 release/bundle」，不按目录名白名单猜三元组。
 */
function bundleDirs() {
  if (!existsSync(TARGET_ROOT)) return []
  const candidates = [join(TARGET_ROOT, 'release', 'bundle')]
  for (const entry of readdirSync(TARGET_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'release') continue
    candidates.push(join(TARGET_ROOT, entry.name, 'release', 'bundle'))
  }
  return candidates.filter((dir) => existsSync(dir))
}

/** bundle/<格式>/<文件>：只扫一层，Tauri 的布局就是一层 */
function scanBundle() {
  const deliverables = []
  const scratch = []
  for (const bundle of bundleDirs()) {
    for (const format of readdirSync(bundle, { withFileTypes: true })) {
      if (!format.isDirectory()) continue
      for (const entry of readdirSync(join(bundle, format.name), { withFileTypes: true })) {
        if (!isDeliverable(entry.name)) continue
        const path = join(bundle, format.name, entry.name)
        if (DMG_SCRATCH.test(entry.name)) scratch.push(path)
        else deliverables.push(path)
      }
    }
  }
  return { deliverables, scratch }
}

/**
 * cargo 的裸可执行文件（Windows 免安装版）。只认 `.exe`：Linux 宿主上 cargo 也产出一个同名
 * 无后缀的二进制，那是 deb/rpm 的原料，不是给人双击的交付物。
 * 收的时候要**改名**：cargo 给的名字不带版本与架构，两个架构放一个目录会互撞
 * （x64 与 arm64 都叫 cc-session-analysis-tool.exe），而 releases/ 是平铺的。
 */
function appBinaries() {
  if (!WITH_APP || !CARGO_BIN) return []
  const found = []
  const candidates = [
    { dir: join(TARGET_ROOT, 'release'), arch: TRIPLE_ARCH[process.arch] },
    ...readdirSync(TARGET_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== 'release')
      .map((e) => ({
        dir: join(TARGET_ROOT, e.name, 'release'),
        arch: TRIPLE_ARCH[e.name.split('-')[0]],
      })),
  ]
  for (const { dir, arch } of candidates) {
    const exe = join(dir, `${CARGO_BIN}.exe`)
    if (existsSync(exe)) found.push({ path: exe, name: `${PRODUCT_NAME}_${VERSION}_${arch}-portable.exe` })
  }
  return found
}

const { deliverables: found, scratch } = scanBundle()
const stale = found.filter((p) => isOtherVersion(basename(p)))
if (stale.length > 0) {
  fail(
    `bundle/ 里是别的版本的产物（package.json 现在是 ${VERSION}）：${stale.map((p) => basename(p)).join('、')}\n` +
      `      先重新构建（just package mac / win / linux），或清掉 src-tauri/target/*/release/bundle/`,
  )
}

const artifacts = found
  .filter((p) => isCurrentVersion(basename(p)))
  .map((p) => ({ src: p, name: basename(p), move: true }))
// 免安装 exe 与安装包同样算交付物：它不走 bundle/，名字也得自己起
for (const app of appBinaries()) {
  artifacts.push({ src: app.path, name: app.name, move: false })
}

if (artifacts.length === 0) {
  // dmg 那步失败时这里只剩半成品镜像 —— 说清楚，否则「bundle/ 里明明有东西却没收到」很难查
  const hint =
    scratch.length > 0
      ? `\n      bundle/dmg 里有 ${scratch.length} 个 dmg 半成品（rw.*，上一次 dmg 制作失败留下的），那不是交付物`
      : ''
  fail(`bundle/ 里没有 ${VERSION} 的交付物。先构建：just package（或 package mac / win / linux）${hint}`)
}

mkdirSync(RELEASES, { recursive: true })

// 清掉 releases/ 里明写着别的版本的残留 —— 当前版本其他平台的产物保留，
// 跨平台发布就是在这一个目录上攒的（Win 包拷过来、Linux 包由容器链路放进来的那些）
const pruned = readdirSync(RELEASES).filter((f) => isDeliverable(f) && isOtherVersion(f))
for (const f of pruned) rmSync(join(RELEASES, f), { recursive: true, force: true })

const seen = new Set()
const collected = []
for (const { src, name, move } of artifacts) {
  if (seen.has(name)) fail(`两个来源产出了同名文件：${name}`)
  seen.add(name)
  const dest = join(RELEASES, name)
  // 本机重建会撞上上一轮的同一个名字 —— 那是同一个产物的新版本，换掉即可（旧件已先删）
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
  // 安装包搬走（bundle/ 是构建工作区，不该留第二份）；免安装 exe 复制 ——
  // 它是 cargo 的编译产物，搬走会让 target/ 少一个已被指纹记账的输出，下次要重新链接。
  if (move) renameSync(src, dest)
  else copyFileSync(src, dest)
  collected.push({ name, bytes: sizeOf(dest) })
}

const toMB = (b) => (b / BYTES_PER_MB).toFixed(1)
console.log(`[releases] → 收集 ${VERSION} 交付物 → releases/（平铺）`)
for (const { name, bytes } of collected) console.log(`    ${name}  (${toMB(bytes)} MB)`)
for (const f of pruned) console.log(`    清掉旧版本残留: ${f}`)
for (const p of scratch) console.log(`    跳过 dmg 半成品（可自行删）: ${relative(process.cwd(), p)}`)
const total = collected.reduce((sum, c) => sum + c.bytes, 0)
console.log(`[releases] ✅ ${collected.length} 个交付物，合计 ${toMB(total)} MB → releases/`)
