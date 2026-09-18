# 项目命令入口。用法：`just <recipe>`，例如 `just ci`。输入 `just` 查看帮助列表。
# 跨平台兼容 (Win/macOS/Linux)：环境变量统一用 just 的 export 注入子进程，
# 不依赖任何 shell 语法 (sh/bash/zsh/cmd/powershell 均可执行)。
#
# 分两区：上面是日常闭环（装依赖、开 dev、打安装包、跑测试），下面是附加命令
# （产物护栏、专项测试）—— 附加命令不是每天都要敲，但都不能删。

# Windows 用 cmd.exe（PowerShell/cmd 无 sh）；macOS/Linux 用 sh（显式声明）
# 平台属性 [windows]/[unix] 不能加在 set 上（报 Extraneous attribute），
# 跨平台正确写法：windows-shell 仅 Windows 生效，shell 管其余平台
set windows-shell := ["cmd", "/C"]
set shell := ["sh", "-cu"]

# ─────────────────────────── 核心命令 ───────────────────────────

# 无参数运行 just 时显示帮助列表 (recipe 名 default 即为默认动作)
default:
    @just --list

# 安装依赖
install:
    npm install

# tauri CLI 默认会轮询 devUrl、确认可访问后才启动 cargo，实测这段白等 1.67s ——
# 而 Vite 只要 ~100ms 就绪，cargo 编译 + 进程启动却要 1s 以上，窗口必然晚于 dev server，
# 所以跳过这段等待不会白屏：实测启动 4.8s → 2.0s。
# 值必须是 true/false：tauri CLI 把它当 `--no-dev-server-wait` 参数解析，写 "1" 直接报
# `invalid value '1' for '--no-dev-server-wait'`。
export TAURI_CLI_NO_DEV_SERVER_WAIT := "true"

# 开发模式: tauri dev（Rust 侧改动自动重启 + 渲染层 HMR）
dev:
    npm run dev

# 打安装包（默认三平台；linux 两个架构都打，产物平铺进 releases/）
package platform='':
    node build/package.mjs {{platform}}

# 构建**本机平台**的可分发产物 -> src-tauri/target/release/bundle/（不收拢进 releases/）
#   macOS: .app + .dmg   Windows: NSIS Setup   Linux: deb + rpm + AppImage
build:
    npm run build

# 只构建渲染层（Vite）-> out/tauri-renderer/，不碰 Rust（快速验证前端）
renderer:
    npm run build:renderer

# 单次测试（vitest：core/ + 渲染层 + 契约套件）
test:
    npm test

# 监听模式测试
test-watch:
    npm run test:watch

# 类型检查 (node + web 两套 tsconfig)
typecheck:
    npm run typecheck

# 提交前自检
ci: typecheck test assert-size

# 清理构建产物（node fs 实现，Win cmd 无 rm）
clean:
    npm run clean

# ─────────────────────── 附加：安装包相关 ───────────────────────
#
# package 怎么选平台/宿主，规则在 build/package.mjs 里一处写清，这里只列要点：
#   mac    只能在 macOS 宿主上打
#   win    Windows 宿主原生；macOS 宿主经 cargo-xwin 交叉
#   linux  Linux 宿主原生；其它宿主进容器（见 build/linux/，默认 amd64 + arm64 两个架构）
# 容器链路默认只出 deb + rpm —— 这两种不需要任何外网资源。要 AppImage 就显式开：
#   BUNDLES=deb,rpm,appimage just package linux
# （它的 linuxdeploy 工具由 tauri 打包器每次从 GitHub 现下，解到 /tmp，没有缓存能力。）
# 包体与工具链在宿主预取一次后长期复用，缓存见 build/linux/.cache/。

# 给构建容器断网（--network=none）再打一遍 Linux 包 —— 只要有任何一处想联网就当场失败。
# 预取做全了它才绿，而它同时也是最快的回归（预取都在本地，只跑编译）。
# 它不是省事开关，别拿它替代 package linux 的常规构建。

# 判据：断网重打 Linux 包，证明构建阶段零下载
assert-linux-offline:
    OFFLINE=1 sh build/linux/build.sh linux/amd64
    OFFLINE=1 sh build/linux/build.sh linux/arm64

# 出「自带依赖」的 Linux 离线安装包 → releases/*.tar.gz
# deb 的常规模型里依赖由系统提供，目标机连不上仓库就报 unmet dependencies；这个包把
# 运行时闭包（按目标发行版解，默认 Ubuntu 24.04）连同主程序一起带上，装的过程不联网。
package-linux-offline:
    sh build/linux/offline-bundle.sh linux/amd64
    sh build/linux/offline-bundle.sh linux/arm64

# 只收拢不构建：把 bundle/ 里当前版本的交付物平铺进 releases/（package 末尾已自动跑）
releases:
    node build/collect-releases.mjs

# ─────────────────────────── 附加：专项测试 ───────────────────────────

# Rust 侧单元/集成测试
test-rust:
    cargo test --manifest-path src-tauri/Cargo.toml

# ⚠️ 必须带 --features standalone，否则 proxy-standalone 不在默认 feature 里、
#    构建不出来，而 harness 会因为找不到二进制**静默跳过 Rust 那一半**（只跑 Node 也是绿的）。

# 黑盒契约测试：同一批用例分别打 Node 参考实现与 Rust 实现，做差分
test-contract:
    cargo build --release --features standalone --bin proxy-standalone --manifest-path src-tauri/Cargo.toml
    npx vitest run test/proxy-contract/

# 单测某文件: just test-one test/parser.test.ts
test-one file:
    npx vitest run {{file}}

# 按名称运行测试: just test-name "parses session metadata"
test-name name:
    npx vitest run -t "{{name}}"

# ─────────────────────────── 附加：产物护栏 ───────────────────────────

# 产物体积护栏：运行时依赖白名单（始终检查）+ 渲染层产物 ≤ 2MB（有产物时检查）
# 防 Electron→Tauri 的体积收益静默反弹
assert-size:
    node build/check-bundle-budget.mjs

# 同上，但要求渲染层产物必须已存在（发布前自检）
assert-size-strict:
    node build/check-bundle-budget.mjs --require-renderer
