// 把「我们的 deb + 目标发行版的全部运行时依赖 deb」组装成一个可离线安装的 tar.gz。
//
// 为什么需要：deb 的常规模型里依赖由系统提供（我们的包只有 4.2 MB，库里几百 MB 都在发行版
// 仓库），于是目标机一旦连不上仓库就装不上，报 "The following packages have unmet
// dependencies"。这个包把那份闭包随身带上，装的过程一个字节都不用下载。
//
// 用法：node build/offline-deb-bundle.mjs <x86_64|aarch64> <ubuntu 版本> <依赖 deb 目录>
import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import process from 'node:process'

const REPO_ROOT = join(import.meta.dirname, '..')
const RELEASES = join(REPO_ROOT, 'releases')

/** 包管理器认的架构串（deb 文件名与 Depends 都用这个，不是 x86_64/aarch64）。 */
const DEB_ARCH = { x86_64: 'amd64', aarch64: 'arm64' }

const [packageArch, ubuntuRelease, depsDir] = process.argv.slice(2)
if (!DEB_ARCH[packageArch] || !ubuntuRelease || !depsDir) {
  console.error('用法：node build/offline-deb-bundle.mjs <x86_64|aarch64> <ubuntu 版本> <依赖 deb 目录>')
  process.exit(2)
}
const debArch = DEB_ARCH[packageArch]

const productName = JSON.parse(readFileSync(join(REPO_ROOT, 'src-tauri/tauri.conf.json'), 'utf8')).productName
const version = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version

// 我们的包名由 tauri 按 productName 生成，这里按同样的规则拼出来 —— 找不到就报错，
// 而不是悄悄打一个只含依赖的包出去。
const ourDeb = join(RELEASES, `${productName}_${version}_${debArch}.deb`)
if (!existsSync(ourDeb)) {
  console.error(`✗ 找不到 ${ourDeb}\n  先构建：just package linux`)
  process.exit(1)
}
if (!existsSync(depsDir)) {
  console.error(`✗ 找不到依赖目录 ${depsDir}`)
  process.exit(1)
}

const deps = readdirSync(depsDir).filter((f) => f.endsWith('.deb'))
if (deps.length === 0) {
  console.error(`✗ ${depsDir} 里没有 .deb`)
  process.exit(1)
}

/**
 * 安装脚本走 dpkg 而不是 `apt-get install <本地 deb>`。
 *
 * 实测 apt 那条路在这个场景里走不通：把 200 多个本地 deb 交给 apt（带或不带 --no-download、
 * 相对或绝对路径都试过），依赖解析明明成功（日志里算出 224 个包），但真正装的时候报
 * `E: Internal Error, Pathname to install is not absolute 'libapparmor1_....deb'` ——
 * apt 记录的是文件名而不是我们给它的路径。dpkg 没有这层间接，直接吃文件。
 *
 * 跑两遍是因为 dpkg 单遍不保证配置顺序：第一遍把包全部解包、能配的先配，
 * 第二遍把因顺序未满足而跳过的补上；最后 `--configure -a` 兜底。
 * 第一遍的失败是预期内的，所以吞掉；第二遍的失败必须暴露出来。
 */
const INSTALL_SH = `#!/bin/sh
# 离线安装：本目录已包含运行所需的全部依赖，全过程不联网。
set -eu
cd "$(dirname "$0")"
# 桌面机上要 sudo；容器/CI 里本来就是 root，此时 sudo 往往不存在
if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi
echo "==> 安装依赖与主程序（离线，共 $((${deps.length} + 1)) 个包）"
$SUDO dpkg -i deps/*.deb >/dev/null 2>&1 || true   # 第一遍：解包为主，配置顺序未满足属正常
$SUDO dpkg -i deps/*.deb                            # 第二遍：补上一遍跳过的配置
$SUDO dpkg -i ./*.deb
$SUDO dpkg --configure -a >/dev/null
echo "==> 完成，可从应用菜单启动「${productName}」"
`

const README = `# ${productName} ${version} · Ubuntu ${ubuntuRelease} 离线安装包（${debArch}）

本目录含主程序与它运行所需的**全部依赖**（${deps.length} 个 deb），目标机不需要联网。

    ./install.sh

装完从应用菜单启动。依赖清单与版本取自 Ubuntu ${ubuntuRelease} 官方仓库；
换发行版要重新解闭包（build/linux/offline-bundle.sh）。
`

const work = mkdtempSync(join(tmpdir(), 'offline-deb-'))
const bundleName = `${productName}_${version}_offline_${debArch}_ubuntu${ubuntuRelease}`
const bundleDir = join(work, bundleName)
const tarball = join(RELEASES, `${bundleName}.tar.gz`)

try {
  mkdirSync(join(bundleDir, 'deps'), { recursive: true })
  copyFileSync(ourDeb, join(bundleDir, basename(ourDeb)))
  for (const dep of deps) cpSync(join(depsDir, dep), join(bundleDir, 'deps', dep))
  writeFileSync(join(bundleDir, 'install.sh'), INSTALL_SH, { mode: 0o755 })
  writeFileSync(join(bundleDir, 'README.md'), README)

  // 打成 tar.gz：整个工作目录一起进包，解出来就是一个自洽的目录。
  execFileSync('tar', ['-czf', tarball, '-C', work, bundleName], { stdio: ['ignore', 'ignore', 'inherit'] })

  const mb = (statSync(tarball).size / 1024 / 1024).toFixed(1)
  console.log(`[offline] ${basename(tarball)}  (${mb} MB，主程序 + ${deps.length} 个依赖)`)
  console.log(`[offline] 目标机：解开 → ./install.sh`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
