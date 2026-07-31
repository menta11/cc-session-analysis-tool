import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
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
