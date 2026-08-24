import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  scanProjects: () => ipcRenderer.invoke('projects:scan'),
  loadSession: (path: string) => ipcRenderer.invoke('session:load', path),
  analyzeReport: (kind: 'whole' | 'node', sessionPath: string, focusToolUseId?: string, window?: { start: number; end: number }) =>
    ipcRenderer.invoke('analyze:run', { kind, sessionPath, focusToolUseId, window }),
  onAnalyzeChunk: (cb: (chunk: { sessionPath: string; text: string }) => void) => {
    const listener = (_e: unknown, chunk: { sessionPath: string; text: string }) => cb(chunk)
    ipcRenderer.on('analyze:chunk', listener)
    return () => {
      ipcRenderer.removeListener('analyze:chunk', listener)
    }
  },
  saveReport: (text: string, name: string) => ipcRenderer.invoke('report:save', text, name),
  openTerminal: (claudeId: string) =>
    ipcRenderer.invoke('terminal:open', { claudeId }),
  onImportSession: (cb: (path: string) => void) => {
    const listener = (_e: unknown, path: string) => cb(path)
    ipcRenderer.on('session:import', listener)
    return () => {
      ipcRenderer.removeListener('session:import', listener)
    }
  },
  getMonitorPort: () => ipcRenderer.invoke('monitor:get-port'),
  pingMonitor: () => ipcRenderer.invoke('monitor:ping'),
  enterFloatMode: () => ipcRenderer.invoke('monitor:enter-float'),
})

// cc-monitor 悬浮窗 (mini.html, 加载自 proxy http://localhost:port) 的桥:
// 与 cc-monitor 原版 preload 同名同参, dashboard.html 悬浮框按钮也走它 (直连窗口时).
contextBridge.exposeInMainWorld('ccMonitor', {
  enterFloatMode: () => ipcRenderer.invoke('monitor:enter-float'),
  backToDashboard: () => ipcRenderer.invoke('monitor:back-to-dashboard'),
  resizeFloat: (w: number, h: number) => ipcRenderer.invoke('monitor:resize-float', { w, h }),
  floatDragStart: (x: number, y: number) => ipcRenderer.send('monitor:float-drag-start', x, y),
  floatDragMove: (x: number, y: number) => ipcRenderer.send('monitor:float-drag-move', x, y),
})
