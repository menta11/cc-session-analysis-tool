import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

/**
 * Tauri 渲染层构建配置 —— 仓库里**唯一**的渲染层构建配置。
 *
 * 产物 `out/tauri-renderer/`，由 `src-tauri/tauri.conf.json` 的 `frontendDist` 消费。
 * （Electron 壳已随全量迁移完成删除，原先并存的 `electron.vite.config.ts` 不再存在。）
 *
 * `base: './'` —— 产出相对资源路径，Tauri 自定义协议下最稳。
 */
export default defineConfig({
  root: resolve('src'),
  base: './',
  build: {
    outDir: resolve('out/tauri-renderer'),
    emptyOutDir: true,
    target: 'chrome110', // Tauri 用系统 WebView；macOS 12+ / Win10+ 的 WebView2 均满足
  },
  // `tauri dev` 会跑 `beforeDevCommand`（本配置）并把窗口指向 devUrl —— 而 devUrl 在
  // src-tauri/tauri.conf.json 里是**硬编码**的 http://localhost:5173。
  // 不锁端口的话：5173 被占用时 Vite 静默改用 5174，Tauri 仍去 5173 取页面
  // → 窗口空白（或加载到别人的服务）且不报错。strictPort 让它当场失败。
  server: {
    port: 5173,
    strictPort: true,
  },
  resolve: {
    alias: { '@': resolve('src') },
  },
  plugins: [react()],
})
