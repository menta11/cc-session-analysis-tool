// 把 Linux 构建要用的包体预先取到本地，好让容器里的构建阶段一个字节都不用下。
//
// 为什么必须预取：npm 的 cacache 里只有**当前平台**的原生包（这台是 macOS），
// 而渲染层构建跑在 Linux 容器里 —— esbuild / rollup / @tauri-apps/cli 都要各自的
// 平台二进制，它们是按平台分包的（@esbuild/linux-x64 这类），macOS 上从没下过。
// cargo 侧同理：macOS 构建不会取 webkit2gtk/gtk 那一族 Linux 专有 crate。
//
// 清单从 package-lock.json 与 Cargo.toml 派生，不手写包名 —— 依赖升级后清单自动跟着变。
//
// 用法：node build/linux/prefetch.mjs       （幂等；已取过的不会重取）
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MARKER_DIR = join(REPO_ROOT, 'build', 'linux', '.cache')

/** 容器是 Ubuntu，即 glibc；musl 变体（rollup/cli 都有）不该取。 */
const GLIBC = 'glibc'

/** 目标平台：两种架构都要，因为两种包都要出。 */
const LINUX_TARGETS = [
  { cargo: 'x86_64-unknown-linux-gnu', cpu: 'x64', node: 'x64' },
  { cargo: 'aarch64-unknown-linux-gnu', cpu: 'arm64', node: 'arm64' },
]

const NODE_VERSION = '20.18.0'
const NODE_MIRROR = 'https://npmmirror.com/mirrors/node'

/** rust 工具链的来源：镜像站的 dist 布局与原站同构（/dist/<日期>/<组件>.tar.xz）。 */
const RUST_DIST_SERVER = 'https://rsproxy.cn'

/**
 * rustup 的 minimal profile 就是这三个组件：rustc（编译器）、rust-std（该三元组的目标库）、
 * cargo（包管理器）。直接铺它们的组件包，比在容器里跑 rustup 短一层，也才谈得上离线。
 */
const RUST_COMPONENTS = ['rustc', 'rust-std', 'cargo']

function npmCacheDir() {
  return execFileSync('npm', ['config', 'get', 'cache'], { encoding: 'utf8' }).trim()
}

/**
 * 平台受限的包在 lockfile 里带 os / cpu / libc 字段，直接按它们筛，不按包名猜。
 * 只取 linux + 目标 CPU + glibc 的那些。
 */
function linuxOnlyNpmPackages() {
  const lock = JSON.parse(readFileSync(join(REPO_ROOT, 'package-lock.json'), 'utf8'))
  const wanted = []
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path.startsWith('node_modules/')) continue
    if (!entry.os && !entry.cpu && !entry.libc) continue
    if (!(entry.os ?? []).includes('linux')) continue
    const libc = entry.libc ?? []
    if (libc.length > 0 && !libc.includes(GLIBC)) continue
    const cpu = entry.cpu ?? []
    for (const target of LINUX_TARGETS) {
      // 不写 cpu 的包两种架构都适用
      if (cpu.length > 0 && !cpu.includes(target.cpu)) continue
      wanted.push({ spec: `${path.slice('node_modules/'.length)}@${entry.version}`, cpu: target.cpu })
    }
  }
  return wanted
}

function markerFresh(marker, inputs) {
  if (!existsSync(marker)) return false
  const recorded = readFileSync(marker, 'utf8')
  return recorded === inputs
}

function run(label, cmd, args) {
  process.stdout.write(`  ${label}\n`)
  execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'] })
}

function prefetchNpm() {
  const cacheDir = npmCacheDir()
  const packages = linuxOnlyNpmPackages()
  // marker 里记的是「清单 + 版本」，依赖一变就重取；不变则整段跳过，连元数据请求都不发。
  const fingerprint = JSON.stringify(packages.map((p) => p.spec))
  const marker = join(MARKER_DIR, 'npm-linux.marker')
  if (markerFresh(marker, fingerprint)) {
    process.stdout.write(`npm：清单未变，跳过（${packages.length} 个包）\n`)
    return
  }
  process.stdout.write(`npm：预取 ${packages.length} 个 Linux 原生包 → ${cacheDir}\n`)
  for (const pkg of packages) {
    // --os/--cpu 让 npm 在 macOS 上也愿意碰别的平台的包（否则报 EBADPLATFORM）。
    run(`    ${pkg.spec}`, 'npm', [
      'cache',
      'add',
      pkg.spec,
      '--cache',
      cacheDir,
      '--os=linux',
      `--cpu=${pkg.cpu}`,
    ])
  }
  writeFileSync(marker, fingerprint)
}

function prefetchCargo() {
  const manifest = join(REPO_ROOT, 'src-tauri', 'Cargo.toml')
  for (const target of LINUX_TARGETS) {
    const marker = join(MARKER_DIR, `cargo-${target.cargo}.marker`)
    const fingerprint = readFileSync(join(REPO_ROOT, 'src-tauri', 'Cargo.lock'), 'utf8')
    if (markerFresh(marker, fingerprint)) {
      process.stdout.write(`cargo：${target.cargo} 清单未变，跳过\n`)
      continue
    }
    process.stdout.write(`cargo：预取 ${target.cargo} 的依赖源码 → ~/.cargo/registry\n`)
    // cargo fetch 不编译，只把 .crate 拉到 registry 缓存里；宿主的 ~/.cargo 正是后面灌给容器的种子。
    run(`    cargo fetch --target ${target.cargo}`, 'cargo', [
      'fetch',
      '--manifest-path',
      manifest,
      '--target',
      target.cargo,
    ])
    writeFileSync(marker, fingerprint)
  }
}

async function prefetchNodeTarballs() {
  const dir = join(MARKER_DIR, 'node')
  mkdirSync(dir, { recursive: true })
  for (const target of LINUX_TARGETS) {
    const file = join(dir, `node-v${NODE_VERSION}-linux-${target.node}.tar.xz`)
    if (existsSync(file)) {
      process.stdout.write(`node：${target.node} 已存在，跳过\n`)
      continue
    }
    const url = `${NODE_MIRROR}/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${target.node}.tar.xz`
    process.stdout.write(`node：下载 ${url}\n`)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`node tarball ${target.node}: HTTP ${res.status}`)
    writeFileSync(file, Buffer.from(await res.arrayBuffer()))
  }
}

/**
 * 从 dist 清单里取某组件的下载地址与校验和。
 * 清单是 TOML，但这里只需要 `[pkg.<组件>.target.<三元组>]` 段落里的三个键，
 * 按行切段即可，不引 TOML 解析器。
 */
function rustComponentEntry(manifest, component, triple) {
  const header = `[pkg.${component}.target.${triple}]`
  const lines = manifest.split('\n')
  const start = lines.indexOf(header)
  if (start < 0) return null
  const entry = {}
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('[')) break
    // 值有两种写法：字符串带引号、布尔裸写（available = true），所以引号要可省。
    const match = /^(\w+)\s*=\s*(?:"([^"]*)"|(\S+))/.exec(line.trim())
    if (match) entry[match[1]] = match[2] ?? match[3]
  }
  return entry.available === 'true' ? entry : null
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

async function download(url) {
  // 镜像站对 dist 文件会 302 到自家 CDN，fetch 默认跟随跳转。
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

async function prefetchRust() {
  const manifestUrl = `${RUST_DIST_SERVER}/dist/channel-rust-stable.toml`
  const manifest = (await download(manifestUrl)).toString('utf8')
  for (const target of LINUX_TARGETS) {
    const dir = join(MARKER_DIR, 'rust', target.cargo.replace(/-unknown-linux-gnu$/, ''))
    mkdirSync(dir, { recursive: true })
    for (const component of RUST_COMPONENTS) {
      const entry = rustComponentEntry(manifest, component, target.cargo)
      if (!entry) throw new Error(`清单里找不到 ${component} / ${target.cargo}`)
      const file = join(dir, entry.xz_url.split('/').pop())
      if (existsSync(file)) {
        process.stdout.write(`rust：${entry.xz_url.split('/').pop()} 已存在，跳过\n`)
        continue
      }
      // 组件包的地址按镜像站重写：清单里写的仍是原站地址。
      const url = `${RUST_DIST_SERVER}/dist/${entry.xz_url.split('/dist/')[1]}`
      process.stdout.write(`rust：下载 ${url}\n`)
      const buf = await download(url)
      const actual = sha256(buf)
      if (actual !== entry.xz_hash) {
        // 工具链装上去才炸的话，报错会离现场很远；在这里按清单里的哈希拦住。
        throw new Error(`${component}/${target.cargo} 校验和不符：期望 ${entry.xz_hash}，实际 ${actual}`)
      }
      writeFileSync(file, buf)
    }
  }
}

mkdirSync(MARKER_DIR, { recursive: true })
prefetchNpm()
prefetchCargo()
await prefetchNodeTarballs()
await prefetchRust()
process.stdout.write('预取完成\n')
