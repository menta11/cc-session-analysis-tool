import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // 全局安装 Node 版 FsBridge / ProcBridge：core/ 已把 syscall 与子进程抽成可注入的桥
    // （core/fsBridge.ts / core/procBridge.ts），测试跑在 Node 上，集中装一次即可。
    setupFiles: ['test/setup/bridges.ts'],
  },
})
