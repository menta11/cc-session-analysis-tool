# 默认: 启动开发模式 (热重载 main + renderer)
default: dev

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

# 类型检查 + 测试 一起跑 (提交前自检)
ci: typecheck test
