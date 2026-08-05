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
      onAnalyzeChunk: (cb: (chunk: { sessionPath: string; text: string }) => void) => () => void
      saveReport: (text: string, name: string) => Promise<string | null>
      openTerminal: (claudeId: string) => Promise<{ ok: boolean; error?: string }>
      onImportSession: (cb: (path: string) => void) => () => void
    }
  }
}

export {}
