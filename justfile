# 项目命令入口。用法：`just <recipe>`，例如 `just ci`。输入 `just` 查看帮助列表。
# 跨平台兼容 (Win/macOS/Linux)：环境变量统一用 just 的 export 注入子进程，
# 不依赖任何 shell 语法 (sh/bash/zsh/cmd/powershell 均可执行)。

# Windows 用 cmd.exe（PowerShell/cmd 无 sh）；macOS/Linux 用 sh（显式声明）
# 平台属性 [windows]/[unix] 不能加在 set 上（报 Extraneous attribute），
# 跨平台正确写法：windows-shell 仅 Windows 生效，shell 管其余平台
set windows-shell := ["cmd", "/C"]
set shell := ["sh", "-cu"]

# electron-builder 打包工具链镜像（国内加速 GitHub 下载；仅 dist-* 命令消费，其他 recipe 无副作用）
export ELECTRON_BUILDER_BINARIES_MIRROR := "https://npmmirror.com/mirrors/electron-builder-binaries/"

# 无参数运行 just 时显示帮助列表 (recipe 名 default 即为默认动作)
default:
    @just --list

# 安装依赖
install:
    npm install

# 开发模式: electron-vite dev (热重载)
dev:
    npm run dev

# 构建三端产物 (main/preload/renderer) -> out/
build:
    npm run build

# 构建 Windows 安装包 (NSIS + portable) -> dist/
# npm script 自带 build，just 不重复依赖（避免构建两次）
dist-win:
    npm run dist:win

# 构建 macOS dmg (压缩 ~95M，自带拖拽安装界面) + ad-hoc 自签 (afterPack 自动注入)
# 产物: dist/Claude会话耗时分析-<version>-arm64.dmg
# 分发: 对方双击 dmg → 拖入 Applications → 首次右键→打开→确认 (ad-hoc 签名限制)
# 仅 mac 可跑（electron-builder mac 打包不支持跨平台；bash 块 Win 上也无解释器）
[macos]
dist-mac:
    #!/usr/bin/env bash
    set -euo pipefail
    npm run dist:mac
    DMG=$(ls dist/*.dmg 2>/dev/null | head -1)
    if [ -z "$DMG" ]; then
        echo "❌ 未找到 dmg 产物"
        exit 1
    fi
    echo "✅ 完成: $DMG ($(du -h "$DMG" | cut -f1))"
    echo "→ 分发: 对方双击 dmg → 拖入 Applications → 首次右键→打开→确认"

# 构建 Linux 安装包 (AppImage + deb) -> dist/
dist-linux:
    npm run dist:linux

# 把最新版本(package.json 的 version)的 dmg + Win NSIS Setup 打成一个 zip -> dist/
# 只消费 dist/ 现有产物，不重新构建（与 dist-mac「不重复依赖」一致）
# 前置：先跑 just dist-win；Mac dmg 需在 macOS 上 just dist-mac 后拷贝到本机 dist/
# 跨平台：win 用系统 tar(bsdtar)，mac/linux 用系统 zip
dist-zip:
    node build/pack-zip.mjs

# 清理打包产物（node fs 实现，Win cmd 无 rm）
clean:
    npm run clean

# 预览构建产物
preview:
    npm run preview

# 类型检查 (node + web 两套 tsconfig)
typecheck:
    npm run typecheck

# 单次测试
test:
    npm test

# 监听模式测试
test-watch:
    npm run test:watch

# 单测某文件: just test-one test/parser.test.ts
test-one file:
    npx vitest run {{file}}

# 按名称运行测试: just test-name "parses session metadata"
test-name name:
    npx vitest run -t "{{name}}"

# 类型检查 + 测试 一起跑 (提交前自检)
ci: typecheck test