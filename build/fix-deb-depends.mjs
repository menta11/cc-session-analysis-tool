// 重写 .deb 的 `Depends:`，把「同一个库在不同发行版里的两个包名」变成「或」关系。
//
// 为什么必须打包后改：tauri-cli 是**无条件**把 `libgtk-3-0` / `libwebkit2gtk-4.1-0` 追加进
// 依赖表的（见 tauri-cli/src/interface/rust.rs：
// `depends_deb.push("libgtk-3-0".to_string())`），而 `bundle.linux.deb.depends` 只做追加、
// 删不掉它 —— 实测配了 `libgtk-3-0 | libgtk-3-0t64` 之后 Depends 变成六项，那个裸名还单独
// 要一次，等于白配。
//
// 而 Ubuntu 24.04 做过 time_t 64 位迁移：`libgtk-3-0` 改名为 `libgtk-3-0t64`，且**没有**
// 过渡包（实测 packages.ubuntu.com：noble 上 `libgtk-3-0` 不存在）。于是不带备选名的 deb
// 在 24.04 上直接报 "The following packages have unmet dependencies"，装都装不上。
//
// 用法：node build/fix-deb-depends.mjs <a.deb> [b.deb ...]
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 等价包名分组：组内任一名字能满足这条依赖，Debian 的写法是 `a | b`。
 * 只列**确实存在改名**的那些 —— 多列一个不存在的备选名没有坏处，但会让人以为有这回事。
 * 实测（packages.ubuntu.com）：libwebkit2gtk-4.1-0 与 libayatana-appindicator3-1 在
 * jammy 与 noble 上同名，无需备选。
 */
const EQUIVALENT_GROUPS = [['libgtk-3-0', 'libgtk-3-0t64']]

/** 每个名字 → 它所在组的「或」表达式；不在任何组里的名字原样返回。 */
const GROUP_EXPRESSION = new Map()
for (const group of EQUIVALENT_GROUPS) {
  const expression = group.join(' | ')
  for (const name of group) GROUP_EXPRESSION.set(name, expression)
}

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('用法：node build/fix-deb-depends.mjs <a.deb> [...]')
  process.exit(2)
}

for (const file of files) {
  if (!existsSync(file)) {
    console.error(`✗ 找不到 ${file}`)
    process.exitCode = 1
    continue
  }
  const work = mkdtempSync(join(tmpdir(), 'deb-fix-'))
  try {
    // dpkg-deb -R 解包（control 与 data），改完再 -b 打回去。
    execFileSync('dpkg-deb', ['-R', file, work], { stdio: ['ignore', 'ignore', 'inherit'] })
    const controlPath = join(work, 'DEBIAN', 'control')
    const control = readFileSync(controlPath, 'utf8')
    const before = /^Depends: (.*)$/m.exec(control)?.[1] ?? ''

    const seen = new Set()
    const rewritten = []
    for (const raw of before.split(',')) {
      const entry = raw.trim()
      if (entry === '') continue
      // 裸名与已合成的「或」表达式会归到同一个 key 上，因此重复项自然被合并掉
      const expression = GROUP_EXPRESSION.get(entry) ?? entry
      if (seen.has(expression)) continue
      seen.add(expression)
      rewritten.push(expression)
    }
    if (rewritten.length === 0) {
      console.error(`✗ ${file} 的 control 里没有 Depends，没东西可改`)
      process.exitCode = 1
      continue
    }

    writeFileSync(controlPath, control.replace(/^Depends: .*$/m, `Depends: ${rewritten.join(', ')}`))
    execFileSync('dpkg-deb', ['-b', work, file], { stdio: ['ignore', 'ignore', 'inherit'] })
    console.log(`[deb] ${file.split('/').pop()}`)
    console.log(`      ${before}`)
    console.log(`   →  ${rewritten.join(', ')}`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
