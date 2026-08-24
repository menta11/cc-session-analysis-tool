// cc-monitor 能力的宿主：内嵌 MITM proxy 生命周期 + 托盘 + 悬浮窗 + 相关 IPC.
// 监控数据链路零 IPC —— dashboard (iframe) / mini (悬浮窗) 直连 http://localhost:PORT 的 HTTP/SSE API,
// 这里只管 proxy 的启停编排、系统级入口 (托盘/悬浮窗) 和窗口切换.
// 逻辑移植自 cc-monitor-app/main.js, 差异点:
//   - proxy 启动失败不退出应用 (本工具集还有会话分析页), 弹错误 + 托盘可 Restart
//   - 悬浮框模式隐藏主窗口而非销毁 (React 状态保留, 返回无需重建)
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, screen, Tray } from 'electron'
import { join } from 'node:path'
// proxy.js 是 2553 行 CJS (透传契约/SSE 分帧), 不进 bundle 不经任何转换:
// 由 viteStaticCopy 拷到 out/main/monitor/, 这里运行时 require (类型从 proxy.d.ts 来).
import { createRequire } from 'node:module'
import type monitorProxyType from './monitor/proxy.js'

const monitorProxy: typeof monitorProxyType = createRequire(__filename)('./monitor/proxy.js')
const { getPort, restoreBaseUrlIfStale, startProxy, stopProxy } = monitorProxy

const IS_MAC = process.platform === 'darwin'
const PORT = getPort()
const ASSETS_DIR = join(__dirname, 'monitor', 'assets')

let tray: Tray | null = null
let floatWin: BrowserWindow | null = null
let floatPositioned = false
let proxyStarted = false
let getMainWindow: () => BrowserWindow | null = () => null
let createMainWindow: () => void = () => {}

function showMainWindow(): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  win.show()
  win.focus()
}

// --- 监控开关状态 (GET /config/baseurl 的 monitoring 字段). 与 dashboard 顶部开关
// 复用同一 HTTP 端点 (单一契约, proxy 零改动). toggle 前先读真实态, 避免缓存滞后反向操作. ---
let monitorOn = false

async function refreshMonitorStatus(): Promise<void> {
  try {
    const r = await fetch(`http://localhost:${PORT}/config/baseurl`)
    if (r.ok) monitorOn = ((await r.json()) as { monitoring?: boolean }).monitoring === true
  } catch {
    // proxy 未起 / 端口未就绪: 保持上次值
  }
}

async function toggleMonitor(): Promise<void> {
  try {
    const cur = (await (await fetch(`http://localhost:${PORT}/config/baseurl`)).json()) as {
      monitoring?: boolean
    }
    const action = cur.monitoring ? 'disable' : 'enable'
    const r = await fetch(`http://localhost:${PORT}/config/baseurl`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    })
    const data = (await r.json()) as { ok?: boolean; monitoring?: boolean; error?: string }
    if (!r.ok || !data.ok) throw new Error(data.error ?? `HTTP ${r.status}`)
    monitorOn = data.monitoring === true
  } catch (e) {
    dialog.showErrorBox('实时监控', '切换监控失败: ' + (e instanceof Error ? e.message : String(e)))
  }
}

// --- 托盘 ---
function createTray(): void {
  let icon
  try {
    if (IS_MAC) {
      // 菜单栏模板图: setTemplateImage → 系统按菜单栏深浅自动反色. 22px = 菜单栏逻辑高度.
      icon = nativeImage.createFromPath(join(ASSETS_DIR, 'trayTemplate.png'))
      if (!icon.isEmpty()) {
        icon = icon.resize({ width: 22, height: 22 })
        icon.setTemplateImage(true)
      }
    } else {
      // Windows 系统托盘: 惯例彩色 logo, 16px
      icon = nativeImage.createFromPath(join(ASSETS_DIR, 'icon.png'))
      if (!icon.isEmpty()) icon = icon.resize({ width: 16, height: 16 })
    }
  } catch {
    icon = nativeImage.createEmpty()
  }
  if (!icon || icon.isEmpty()) icon = nativeImage.createEmpty()

  tray = new Tray(icon)
  tray.setToolTip('AI 会话工具集 · 实时监控')
  tray.on('click', () => {
    const win = getMainWindow()
    if (!win || win.isDestroyed()) {
      createMainWindow()
    } else if (win.isVisible()) {
      win.hide()
    } else {
      showMainWindow()
    }
  })
  // 右键弹菜单: 每次弹出前刷新监控状态 → 标签与 dashboard 实时一致
  tray.on('right-click', async (_e, bounds) => {
    await refreshMonitorStatus()
    tray?.popUpContextMenu(Menu.buildFromTemplate(buildMenuTemplate()), bounds)
  })
  void refreshMonitorStatus()
}

function buildMenuTemplate(): Electron.MenuItemConstructorOptions[] {
  const status = proxyStarted ? 'Running' : 'Stopped'
  return [
    { label: `实时监控 (${status})`, enabled: false },
    { type: 'separator' },
    { label: '打开主窗口', click: () => showMainWindow() },
    // 监控开/关: ●/○ 直观显示当前态, 对应 dashboard 顶部开关
    { label: monitorOn ? '●监控中' : '○已停用', click: () => void toggleMonitor() },
    {
      label: '重启代理',
      click: async () => {
        await stopProxy()
        proxyStarted = false
        await startProxyIfDown()
      },
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]
}

// --- Proxy 生命周期 ---
async function startProxyIfDown(): Promise<boolean> {
  if (proxyStarted) return true
  try {
    await startProxy()
    proxyStarted = true
    return true
  } catch (err) {
    console.error('[monitor] proxy start failed:', err)
    dialog.showErrorBox(
      '实时监控',
      '代理启动失败（端口被占用？config.json 的 port）。\n会话分析页不受影响，可从托盘「重启代理」重试。\n' +
        (err instanceof Error ? err.message : String(err)),
    )
    return false
  }
}

// --- 悬浮窗 (透明 + 置顶 + 无边框): 仅显示活动 agent 的 state/tps ---
function createFloatWindow(): void {
  floatWin = new BrowserWindow({
    width: 1,
    height: 1, // 初始最小, 由 mini.html ResizeObserver 动态调
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: join(__dirname, '../preload/index.js'),
      backgroundThrottling: false, // 透明/失焦窗口不节流 → poll 实时
    },
  })
  floatWin.loadURL(`http://localhost:${PORT}/mini.html`)
  floatWin.on('closed', () => {
    floatWin = null
  })
}

// dashboard → 悬浮框模式: 隐藏主窗口 (React 状态保留) + 显示悬浮框
ipcMain.handle('monitor:enter-float', () => {
  if (!floatWin || floatWin.isDestroyed()) {
    createFloatWindow()
    floatPositioned = false
  }
  floatWin?.show()
  const win = getMainWindow()
  if (win && !win.isDestroyed()) win.hide()
})

// 悬浮框 → 主窗口: 销毁悬浮框 + 恢复主窗口
ipcMain.handle('monitor:back-to-dashboard', () => {
  if (floatWin && !floatWin.isDestroyed()) floatWin.destroy()
  showMainWindow()
})

// mini.html ResizeObserver 报告卡片尺寸 → 动态 resize 悬浮窗
ipcMain.handle('monitor:resize-float', (_e, dims: { w: number; h: number }) => {
  if (floatWin && !floatWin.isDestroyed() && dims) {
    floatWin.setSize(dims.w | 0, dims.h | 0)
    // 首次 resize 时同步定位右上角 (mini 初始 size=1x1, 必须等真实尺寸上报)
    if (!floatPositioned && dims.w > 1 && dims.h > 1) {
      const { width: sw } = screen.getPrimaryDisplay().workArea
      floatWin.setPosition(sw - dims.w - 110, 8)
      floatPositioned = true
    }
  }
})

// 自定义拖动 (弃 -webkit-app-region:drag, 它吞 click). mini mouse→IPC→setPosition.
let floatDragMouse: { x: number; y: number } | null = null
let floatDragWin: Electron.Rectangle | null = null
ipcMain.on('monitor:float-drag-start', (_e, x: number, y: number) => {
  if (!floatWin || floatWin.isDestroyed()) return
  floatDragMouse = { x, y }
  floatDragWin = floatWin.getBounds()
})
ipcMain.on('monitor:float-drag-move', (_e, x: number, y: number) => {
  if (!floatWin || floatWin.isDestroyed() || !floatDragMouse || !floatDragWin) return
  floatWin.setPosition(
    floatDragWin.x + (x - floatDragMouse.x),
    floatDragWin.y + (y - floatDragMouse.y),
  )
})

ipcMain.handle('monitor:get-port', () => PORT)

// 代理存活探测: 渲染页 origin (5173/file://) 直连 8090 是跨源请求, 会被浏览器 CORS 拦掉,
// 所以探测下沉到主进程 (Node fetch 无 CORS).
ipcMain.handle('monitor:ping', async () => {
  try {
    const r = await fetch(`http://localhost:${PORT}/status`, { signal: AbortSignal.timeout(2000) })
    return r.ok
  } catch {
    return false
  }
})

/** 在 app.whenReady 中调用：自愈残留 baseurl → 起 proxy → 套用启动偏好 → 托盘 + 退出恢复. */
export function initMonitor(
  mainWindowGetter: () => BrowserWindow | null,
  mainWindowCreator: () => void,
): void {
  getMainWindow = mainWindowGetter
  createMainWindow = mainWindowCreator

  void (async () => {
    // 启动自愈：修复上次崩溃/强杀残留的 localhost:8090（before-quit 没机会跑）
    try {
      const healed = restoreBaseUrlIfStale()
      if (healed.restored) console.log('[monitor] healed stale ANTHROPIC_BASE_URL →', healed.previous)
    } catch (e) {
      console.error('[monitor] startup self-heal failed:', e)
    }
    // 只起代理不自动开监控: 监控保持 OFF, 由用户在 dashboard 或托盘手动开启 (不静默改写
    // 用户的 ANTHROPIC_BASE_URL). 出错仅记日志, dashboard 显示 OFF 可手动开.
    await startProxyIfDown()
    createTray()
  })()

  app.on('before-quit', () => {
    // 退出前恢复 cc 配置：监控开着就改回原值，工具关后 cc 仍能直连
    try {
      const r = restoreBaseUrlIfStale()
      if (r.restored) console.log('[monitor] restored ANTHROPIC_BASE_URL to', r.previous)
    } catch (e) {
      console.error('[monitor] restore base url failed:', e)
    }
  })
}
