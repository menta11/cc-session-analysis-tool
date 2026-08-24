#!/usr/bin/env node
// 把「最新版本」的安装包打成一个 zip → dist/
//   - 版本取自 package.json 的 version 字段（不按 mtime，避免旧版本残留混入）
//   - 内容：Win NSIS Setup 安装包 + Mac dmg（各平台的标准「安装包」）
//   - 跨平台打包：win 用系统 tar(bsdtar，-a 按扩展名自动产 .zip)；mac/linux 用系统 zip
//   - 只消费 dist/ 现有产物，不触发构建（与 just dist-mac「不重复依赖」一致）
// 入口：just dist-zip
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import process from 'node:process'

const DIST = join(process.cwd(), 'dist')
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const VER = pkg.version

// 版本边界匹配：避免 ver=0.1.3 误命中 0.1.30（后接数字）/ 11.3（前接数字）这类。
// 注：假设三段 semver；四段如 0.1.3.1 仍会被 0.1.3 命中——本仓库用三段，可忽略。
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const preDigit = new RegExp(`\\d${escapeRe(VER)}`)
const postDigit = new RegExp(`${escapeRe(VER)}\\d`)
const versionMatches = (name) => name.includes(VER) && !preDigit.test(name) && !postDigit.test(name)

function fail(msg) {
  console.error(`[pack-zip] ✗ ${msg}`)
  process.exit(1)
}

if (!existsSync(DIST)) {
  fail(
    `未找到 dist/。先构建安装包：just dist-win 与 just dist-mac（Mac dmg 需在 macOS 上构建后拷贝到本机 dist/）`,
  )
}

// dmg：版本匹配即可（arch 后缀 arm64/x64/universal 都兼容）
// setup：必须含 "Setup"（排除免安装 portable）、排除 .blockmap、版本匹配
const dmg = readdirSync(DIST).filter((f) => f.endsWith('.dmg') && versionMatches(f))
const setup = readdirSync(DIST).filter(
  (f) => f.endsWith('.exe') && !f.endsWith('.blockmap') && f.toLowerCase().includes('setup') && versionMatches(f),
)

const missing = []
if (dmg.length === 0) missing.push(`Mac dmg（版本 ${VER}）—— 跑 just dist-mac（需 macOS）后把产物拷到 dist/`)
if (setup.length === 0) missing.push(`Win NSIS Setup .exe（版本 ${VER}）—— 跑 just dist-win`)
if (missing.length) fail(`缺少 ${VER} 版本安装包：\n  - ${missing.join('\n  - ')}`)

if (dmg.length > 1) console.warn(`[pack-zip] ! 找到多个 dmg，取第一个：\n  ${dmg.join('\n  ')}`)
if (setup.length > 1) console.warn(`[pack-zip] ! 找到多个 Setup exe，取第一个：\n  ${setup.join('\n  ')}`)

const dmgFile = dmg[0]
const setupFile = setup[0]
const outName = `ccsa-${VER}-win-mac.zip`
const outPath = join(DIST, outName)
rmSync(outPath, { force: true })

console.log(`[pack-zip] → 打包 ${VER}：
    ${setupFile}
    ${dmgFile}
  → ${outName}`)

try {
  if (process.platform === 'win32') {
    // Win10 1803+ 自带 bsdtar；-a 按输出扩展名自动产出 zip；cwd=dist 使归档内为裸文件名
    execFileSync('tar', ['-a', '-c', '-f', outName, setupFile, dmgFile], { cwd: DIST, stdio: 'inherit' })
  } else {
    // macOS 自带 zip；-j 去路径(只存文件名)，-X 不带扩展属性
    execFileSync('zip', ['-jX', outName, setupFile, dmgFile], { cwd: DIST, stdio: 'inherit' })
  }
} catch (e) {
  const tool = process.platform === 'win32' ? 'tar' : 'zip'
  fail(`打包工具 ${tool} 调用失败：${e.message}`)
}

const sizeMB = (statSync(outPath).size / 1024 / 1024).toFixed(1)
console.log(`[pack-zip] ✅ 完成: ${outName} (${sizeMB} MB) → dist/${outName}`)
console.log(`[pack-zip] → 分发: 解压后即得 Win Setup 安装包 + Mac dmg`)
