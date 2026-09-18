// 安装包入口：`just package [平台]`。
//
//   不带参数      → 三平台都打（本机打不了的那个会打印一行原因后跳过）
//   mac           → 仅 macOS（.app + .dmg）
//   win           → 仅 Windows（NSIS Setup）
//   linux         → 仅 Linux（deb + rpm，两个架构都打：x86_64 与 aarch64）
//
// 为什么要有这一层分派：同一个平台在不同宿主上的打法不同，这不是命名问题而是事实 ——
//   · macOS 只能在 macOS 上打（Tauri CLI 在别的宿主上直接拒绝 app/dmg）
//   · Windows 在 Windows 上是原生的；在 macOS 上要经 cargo-xwin 交叉编译
//   · Linux 在 Linux 上是原生的；在别的宿主上要进容器（见 build/linux/）
// 把这些判断写在 justfile 里会变成一堆 os() 三元表达式，写在脚本里则只有一处、还跨平台。
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 三平台的稳定名字，也是 `just package <平台>` 的合法取值。 */
const PLATFORMS = {
  mac: {
    nativeHost: 'darwin',
    // app 与 dmg 一起出：.app 是运行实体，.dmg 是分发形态，缺一个都不算"打了 mac 包"。
    nativeCommand: 'npx tauri build --bundles app,dmg',
  },
  win: {
    nativeHost: 'win32',
    nativeCommand: 'npx tauri build --bundles nsis',
    crossHost: 'darwin',
    crossTarget: 'x86_64-pc-windows-msvc',
  },
  linux: {
    nativeHost: 'linux',
    nativeCommand: 'npx tauri build --bundles deb,rpm,appimage',
  },
}

/** 容器链路要出的 Linux 架构（docker 的写法）：两种都给，因为 deb/rpm 的包体按架构分开。 */
const LINUX_ARCHES = ['amd64', 'arm64']

function run(command) {
  process.stdout.write(`\n$ ${command}\n`)
  // shell 是必须的：npx 在 Windows 上是 npx.cmd，不经 shell 找不到。
  const res = spawnSync(command, { shell: true, stdio: 'inherit', cwd: REPO_ROOT })
  if (res.status !== 0) {
    process.exitCode = res.status ?? 1
    throw new Error(`命令失败（退出码 ${res.status}）：${command}`)
  }
}

/**
 * 原生构建完都要收拢一次：产物只该出现在 releases/ 的平铺里。
 * `--with-app` 只在 win 分支给：那个免安装 exe 躺在 cargo 的产物目录里**无法自证新鲜**，
 * 若每次收拢都顺手带上，跑完 linux 再收拢就会把上一次 win 的 exe 当成本次产物。
 */
function collect(withApp = false) {
  run(`node build/collect-releases.mjs${withApp ? ' --with-app' : ''}`)
}

/**
 * cargo-xwin 需要 MSVC 风格的归档器（llvm-lib），而 homebrew 的 llvm 是 keg-only、
 * 不进 PATH。不写死版本号：问 brew 要路径，再确认那个目录里真有 llvm-lib。
 */
function llvmBinDir() {
  for (const formula of ['llvm', 'llvm@19', 'llvm@18']) {
    const prefix = spawnSync('brew', ['--prefix', formula], { encoding: 'utf8' })
    if (prefix.status !== 0) continue
    const bin = join(prefix.stdout.trim(), 'bin')
    if (existsSync(join(bin, 'llvm-lib'))) return bin
  }
  return null
}

function packageMac() {
  run(PLATFORMS.mac.nativeCommand)
  collect()
}

function packageWin(host) {
  if (host === PLATFORMS.win.nativeHost) {
    run(PLATFORMS.win.nativeCommand)
    // 只有 Windows 才有那个免安装 exe（cargo 的裸输出），所以只有这条分支要 --with-app
    collect(true)
    return
  }
  if (host !== PLATFORMS.win.crossHost) {
    // Linux 宿主上打 Windows 包要另配 osxcross 之外的整套 MSVC 兼容层，本项目没铺这条路。
    process.stdout.write('win：跳过（只支持 Windows 宿主原生构建，或 macOS 宿主经 cargo-xwin 交叉）\n')
    return
  }
  const llvmBin = llvmBinDir()
  if (!llvmBin) throw new Error('找不到带 llvm-lib 的 llvm（cargo-xwin 需要它来归档 MSVC 目标）')
  // 只有这一步需要改 PATH，所以不污染其它平台分支的环境。
  // 显式 --bundles nsis：配置里是 targets: all，而 .msi 由 WiX 生成、只能在 Windows 宿主上做，
  // 不写这一句 tauri 会先 Warn ignoring msi 再继续（不是错，但日志里多一句无谓的警告）。
  const command =
    `PATH="${llvmBin}:$PATH" npx tauri build --runner cargo-xwin ` +
    `--target ${PLATFORMS.win.crossTarget} --bundles nsis`
  run(command)
  // 交叉构建同样产出裸 exe（就是免安装版），与 Windows 宿主那条分支一样要收
  collect(true)
}

/**
 * 原生 Linux 构建出来的 deb 同样要重写 Depends（Ubuntu 24.04 的 t64 改名）。
 * 容器那条路在 Dockerfile 里调同一个脚本 —— 实现只有 fix-deb-depends.mjs 一份。
 */
function fixDebDepends() {
  const dir = join(REPO_ROOT, 'src-tauri/target/release/bundle/deb')
  if (!existsSync(dir)) return
  const debs = readdirSync(dir).filter((f) => f.endsWith('.deb'))
  if (debs.length === 0) return
  run(`node build/fix-deb-depends.mjs ${debs.map((f) => `"${join(dir, f)}"`).join(' ')}`)
}

function packageLinux(host) {
  if (host === PLATFORMS.linux.nativeHost) {
    // 原生：一次构建出当前架构的三种格式（AppImage 在 Linux 宿主上不涉及容器内下载）。
    run(PLATFORMS.linux.nativeCommand)
    fixDebDepends()
    collect()
    return
  }
  // 非 Linux 宿主：走容器。一条命令一个架构，因为 deb/rpm 的包体与工具链都是按架构分开的。
  for (const arch of LINUX_ARCHES) run(`sh build/linux/build.sh linux/${arch}`)
}

function parseArgs(argv) {
  const [platform] = argv
  if (platform !== undefined && !(platform in PLATFORMS)) {
    process.stdout.write(`未知平台：${platform}\n用法：just package [${Object.keys(PLATFORMS).join('|')}]\n`)
    process.exit(2)
  }
  return platform
}

const platform = parseArgs(process.argv.slice(2))
const host = process.platform
// 不带参数时按 mac → win → linux 的顺序全打；带参数就只打那一个。
const wanted = platform ? [platform] : Object.keys(PLATFORMS)

for (const name of wanted) {
  process.stdout.write(`\n===== ${name}（宿主 ${host}）=====\n`)
  if (name === 'mac') {
    if (host !== 'darwin') {
      process.stdout.write('mac：跳过（只能在 macOS 宿主上打）\n')
      continue
    }
    packageMac()
  } else if (name === 'win') {
    packageWin(host)
  } else {
    packageLinux(host)
  }
}
