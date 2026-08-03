# 项目命令入口。用法：`just <recipe>`，例如 `just check`。输入 `just` 查看帮助列表。
# Windows 下 just 默认用 sh，但 PowerShell/cmd 环境没有 sh → 用 cmd.exe；
# macOS/Linux 用默认 sh 即可。

[windows]
set shell := ["cmd", "/C"]

# 无参数运行 just 时显示帮助列表
[default]
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

# 预览构建产物
preview:
    npm run preview

# 构建 Windows 安装包 (NSIS + portable) -> dist/
# 设置工具链镜像（国内网络 GitHub 超时）
dist-win: build
    set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
    npm run dist:win

# 构建 macOS 安装包 (dmg + zip) -> dist/
dist-mac: build
    npm run dist:mac

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
