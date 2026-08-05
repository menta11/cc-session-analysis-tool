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
})
