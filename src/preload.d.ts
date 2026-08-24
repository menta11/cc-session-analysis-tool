import type { Session } from '../core/parser/types'
import type { SessionRef } from '../core/discovery/scan'

declare global {
  interface Window {
    api: {
      scanProjects: () => Promise<SessionRef[]>
      loadSession: (path: string) => Promise<Session>
      analyzeReport: (
        kind: 'whole' | 'node',
        sessionPath: string,
        focusToolUseId?: string,
        window?: { start: number; end: number },
      ) => Promise<{ ok: boolean; text: string; error?: string; sessionId?: string; costUsd?: number; durationMs?: number; numTurns?: number }>
      /** 流式 chunk，携带 sessionPath 以便并发分析时各会话只收自己的内容 */
      onAnalyzeChunk: (cb: (chunk: { sessionPath: string; text: string }) => void) => () => void
      saveReport: (text: string, name: string) => Promise<string | null>
      openTerminal: (claudeId: string) => Promise<{ ok: boolean; error?: string }>
      onImportSession: (cb: (path: string) => void) => () => void
      getMonitorPort: () => Promise<number>
      /** 代理存活探测（主进程 fetch，规避渲染页跨源 CORS） */
      pingMonitor: () => Promise<boolean>
      enterFloatMode: () => Promise<void>
    }
    /** cc-monitor 悬浮窗桥（mini.html / dashboard.html 使用，与原版 preload 同名同参） */
    ccMonitor: {
      enterFloatMode: () => Promise<void>
      backToDashboard: () => Promise<void>
      resizeFloat: (w: number, h: number) => Promise<void>
      floatDragStart: (x: number, y: number) => void
      floatDragMove: (x: number, y: number) => void
    }
  }
}

export {}
