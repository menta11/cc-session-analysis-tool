import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin(),
      // monitor 模块整体作为外部文件拷到 out/main/monitor/, 主进程运行时 require —
      // 2553 行 CJS proxy (透传契约/SSE 分帧) 不经任何 bundler 转换, 保真 + 零转换风险.
      viteStaticCopy({
        targets: [
          { src: 'electron/main/monitor/*.html', dest: 'monitor' },
          { src: 'electron/main/monitor/*.js', dest: 'monitor' },
          { src: 'electron/main/monitor/config.json', dest: 'monitor' },
          { src: 'electron/main/monitor/shared/*', dest: 'monitor/shared' },
          { src: 'electron/main/monitor/assets/*', dest: 'monitor/assets' },
        ],
      }),
    ],
    build: { rollupOptions: { input: { index: resolve('electron/main/index.ts') } } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve('electron/preload/index.ts') } } },
  },
  renderer: {
    root: resolve('src'),
    build: { rollupOptions: { input: { index: resolve('src/index.html') } } },
    resolve: { alias: { '@': resolve('src') } },
    plugins: [react()],
  },
})
