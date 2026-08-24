import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { scanProjects } from '../../core/discovery/scan'
import { parseJsonl } from '../../core/parser/parse'
import { buildAgentIndex } from '../../core/discovery/agentIndex'
import { linkSubagents } from '../../core/discovery/linkSubagents'
import { runClaudeStream } from './claudeCli'
import { buildAnalyzeRequest } from '../../core/ai/analyzeRequest'
import type { Session } from '../../core/parser/types'
import { openTerminal } from './terminal'
import { initMonitor } from './monitorHost'

function projectsRoot(): string {
  return join(app.getPath('home'), '.claude', 'projects')
}

/** 缓存已加载会话（含 agentIndex/路径），供 analyze:run 在主进程组装提示词。 */
interface CachedSession {
  session: Session
  agentIndex: Map<string, string>
  mainFilePath: string
  /** relOf 的基准 = 会话所在目录（projects/<sanitized-cwd>/），主/子文件相对它显示。
   *  注意不是会话目录本身 —— 否则主文件路径会被剥成 ".jsonl"。 */
  projectsRoot: string
}
const sessionCache = new Map<string, CachedSession>()

function setMenu(win: BrowserWindow): void {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = []
  if (isMac) template.push({ role: 'appMenu' })
  template.push({
    label: '文件',
    submenu: [
      {
        label: '导入会话 (.jsonl)…',
        click: async () => {
          const res = await dialog.showOpenDialog(win, {
            filters: [{ name: 'JSONL', extensions: ['jsonl'] }],
            properties: ['openFile'],
          })
          if (!res.canceled && res.filePaths[0]) win.webContents.send('session:import', res.filePaths[0])
        },
      },
      { type: 'separator' },
      isMac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' },
    ],
  })
  template.push({ role: 'editMenu', label: '编辑' })
  template.push({ role: 'viewMenu', label: '视图' })
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// 主窗口引用：monitorHost 的托盘/悬浮窗切换需要读写它
let mainWin: BrowserWindow | null = null

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mainWin = win
  win.on('closed', () => {
    mainWin = null
  })

  setMenu(win)

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  ipcMain.handle('projects:scan', () => scanProjects(projectsRoot()))

  ipcMain.handle('session:load', (_e, path: string) => {
    const sessionDir = path.replace(/\.jsonl$/, '')
    const index = buildAgentIndex(sessionDir)
    const session = parseJsonl(path)
    linkSubagents(session, index, (p) => parseJsonl(p, { subagent: true }))
    sessionCache.set(path, {
      session,
      agentIndex: index,
      mainFilePath: path,
      // 基准 = 会话所在目录：主文件剥成 <sessionId>.jsonl，子agent 剥成 <sessionId>/subagents/...
      projectsRoot: dirname(sessionDir),
    })
    return session
  })

  ipcMain.handle('analyze:run', async (e, args: { kind: 'whole' | 'node'; sessionPath: string; focusToolUseId?: string; window?: { start: number; end: number } }) => {
    const cached = sessionCache.get(args.sessionPath)
    if (!cached) {
      return { ok: false, text: '', error: '会话未加载，请重新选择会话' }
    }
    let systemPrompt: string
    let userMessage: string
    try {
      const r = buildAnalyzeRequest(cached.session, {
        kind: args.kind,
        projectsRoot: cached.projectsRoot,
        mainFilePath: cached.mainFilePath,
        agentIndex: cached.agentIndex,
        focusToolUseId: args.focusToolUseId,
        window: args.window,
      })
      systemPrompt = r.systemPrompt
      userMessage = r.userMessage
    } catch (err) {
      return { ok: false, text: '', error: '组装提示词失败：' + (err instanceof Error ? err.message : String(err)) }
    }
    const win = BrowserWindow.fromWebContents(e.sender)
    // chunk 携带 sessionPath，渲染端并发分析时只接收本会话的流式内容
    return runClaudeStream(userMessage, systemPrompt, (chunk) => {
      win?.webContents.send('analyze:chunk', { sessionPath: args.sessionPath, text: chunk })
    }, { timeoutMs: 600_000 })
  })

  ipcMain.handle('terminal:open', (_e, { claudeId }) => openTerminal(claudeId))

  ipcMain.handle('report:save', async (_e, text: string, name: string) => {
    const res = await dialog.showSaveDialog({
      defaultPath: name,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    })
    if (res.canceled || !res.filePath) return null
    await fs.writeFile(res.filePath, text, 'utf8')
    return res.filePath
  })

  createWindow()
  initMonitor(
    () => mainWin,
    () => createWindow(),
  )
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
