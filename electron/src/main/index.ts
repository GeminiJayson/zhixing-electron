import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  Tray,
  globalShortcut,
  nativeImage,
  nativeTheme,
  screen,
} from 'electron'
import { join } from 'node:path'
import { extractDeepLink, parseDeepLink, toAccelerator } from '../shared/deep-link'
import { initFileLog } from './log'
import { hardenWindow } from './security'
import { autoBackup, closeDb, currentSettings, dbPath, ensureDefaultSettings, listTodayTasks, registerDbHandlers, saveWidgetGeometry, setDataChangedHook } from './db'

const SCHEME = 'zhixing'

// 文件日志要在最前面挂上，否则启动早期的问题不会被记录
initFileLog()

/**
 * 主进程兜底：未捕获异常 / 未处理的 Promise 拒绝只记录，不让整个应用直接消失。
 * （此前 workflow 的 spawn 错误无人监听时会走到这里直接把主进程带崩。）
 */
process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection', reason)
})

const isDev = !!process.env.ELECTRON_RENDERER_URL

let mainWindow: BrowserWindow | null = null
let widgetWindow: BrowserWindow | null = null
let tray: Tray | null = null
/** 是否正在真正退出（托盘「退出」/before-quit）。用来放行关闭拦截。 */
let quitting = false
/** 浮窗贴边状态：缩为把手后记住原宽度与所在侧，鼠标进入时滑出。 */
let widgetDock: { side: 'left' | 'right'; expandedWidth: number } | null = null
/** 贴边把手宽度（对齐 desktop_widget 的 10px 把手） */
const DOCK_HANDLE_W = 10

/** 浮窗展开尺寸与缩放下限，取自 desktop_widget.py。 */
const WIDGET_SIZE: [number, number] = [290, 380]
const WIDGET_MIN: [number, number] = [200, 160]

/** 读取浮窗上次的位置与尺寸（ui_state.widget_geometry）。 */
function readWidgetGeometry(): { x?: number; y?: number; width: number; height: number } {
  const s = currentSettings()
  let width = WIDGET_SIZE[0]
  let height = WIDGET_SIZE[1]
  try {
    const state = JSON.parse(s.ui_state) as { widget_geometry?: unknown }
    const g = state.widget_geometry
    if (Array.isArray(g) && g.length >= 2) {
      const x = Number(g[0])
      const y = Number(g[1])
      if (g.length >= 4) {
        width = Math.max(WIDGET_MIN[0], Number(g[2]) || width)
        height = Math.max(WIDGET_MIN[1], Number(g[3]) || height)
      }
      return { x, y, width, height }
    }
  } catch {
    // 配置损坏时退回默认尺寸
  }
  return { width, height }
}

/**
 * 桌面浮窗：无边框 + 置顶 + 可缩放，尺寸/位置持久化到 settings.ui_state。
 * 与主窗口共用同一份渲染产物，用 ?widget=1 区分视图。
 */
function createWidgetWindow(): void {
  if (widgetWindow) {
    widgetWindow.show()
    widgetWindow.focus()
    return
  }
  const geo = readWidgetGeometry()
  const s = currentSettings()
  const opacity = Math.max(0.3, Math.min(1, s.widget_opacity / 100))

  widgetWindow = new BrowserWindow({
    width: geo.width,
    height: geo.height,
    ...(geo.x !== undefined && geo.y !== undefined ? { x: geo.x, y: geo.y } : {}),
    minWidth: WIDGET_MIN[0],
    minHeight: WIDGET_MIN[1],
    show: false,
    frame: false,
    transparent: true,
    // 透明窗口要显式给全透明底色：不设的话部分平台会补一层白色方底，
    // 卡片自己的圆角边框就变成了「第二层」，直角那层是窗口补的
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  hardenWindow(widgetWindow)
  widgetWindow.setOpacity(opacity)
  // 高于普通窗口，但不抢系统级焦点（对齐 Qt 的 WindowStaysOnTopHint 语义）
  widgetWindow.setAlwaysOnTop(true, 'floating')
  widgetWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  const persist = (): void => {
    if (!widgetWindow) return
    const [x, y] = widgetWindow.getPosition()
    const [w, h] = widgetWindow.getSize()
    saveWidgetGeometry(x, y, w, h)
  }
  // 贴边检测放在移动之后：拖动到屏幕边缘即缩成把手
  widgetWindow.on('moved', () => {
    if (!widgetDock) maybeDockWidget()
    else persist()
  })
  widgetWindow.on('resized', persist)
  widgetWindow.on('ready-to-show', () => {
    widgetWindow?.show()
    // 恢复上次就贴在边缘的几何时也进入把手状态
    maybeDockWidget()
  })
  widgetWindow.on('closed', () => {
    widgetWindow = null
  })

  if (isDev) {
    void widgetWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}?widget=1`)
  } else {
    void widgetWindow.loadFile(join(__dirname, '../renderer/index.html'), { query: { widget: '1' } })
  }
}

/**
 * 浮窗贴边：贴近屏幕左右边缘时缩成把手（对齐 desktop_widget 的贴边半隐）。
 * 只记录状态、不改变用户的几何持久化值 —— 滑出时按原宽度还原。
 */
function maybeDockWidget(): void {
  if (!widgetWindow || widgetWindow.isDestroyed()) return
  const b = widgetWindow.getBounds()
  const wa = screen.getDisplayMatching(b).workArea
  const nearLeft = b.x - wa.x <= 8
  const nearRight = wa.x + wa.width - (b.x + b.width) <= 8
  if (!nearLeft && !nearRight) {
    widgetDock = null
    return
  }
  const side: 'left' | 'right' = nearLeft ? 'left' : 'right'
  if (widgetDock?.side === side) return
  widgetDock = { side, expandedWidth: Math.max(b.width, WIDGET_MIN[0]) }
  // 最小宽度会把 setBounds 钳回去，贴边前必须先放开
  widgetWindow.setMinimumSize(DOCK_HANDLE_W, WIDGET_MIN[1])
  widgetWindow.setBounds({
    x: side === 'left' ? wa.x : wa.x + wa.width - DOCK_HANDLE_W,
    y: b.y,
    width: DOCK_HANDLE_W,
    height: b.height,
  })
}

/** 滑出：从把手恢复原宽度（对齐桌面浮窗的悬停滑出 / 双击取消贴边）。 */
function undockWidget(): void {
  if (!widgetWindow || widgetWindow.isDestroyed() || !widgetDock) return
  const b = widgetWindow.getBounds()
  const wa = screen.getDisplayMatching(b).workArea
  const width = widgetDock.expandedWidth
  const x = widgetDock.side === 'left' ? wa.x : wa.x + wa.width - width
  widgetDock = null
  widgetWindow.setMinimumSize(WIDGET_MIN[0], WIDGET_MIN[1])
  widgetWindow.setBounds({ x, y: b.y, width, height: b.height })
}

function toggleWidget(): void {
  if (widgetWindow && widgetWindow.isVisible()) {
    widgetWindow.hide()
    return
  }
  createWidgetWindow()
}

function applyWidgetOpacity(value: number): void {
  widgetWindow?.setOpacity(Math.max(0.3, Math.min(1, value / 100)))
}

/** 鼠标穿透：开启后浮窗不挡操作（对齐 set_click_through），改用热键/托盘隐藏。 */
function applyWidgetClickThrough(enabled: boolean): void {
  widgetWindow?.setIgnoreMouseEvents(enabled, { forward: true })
}
/** 冷启动时收到的深链：等渲染进程就绪后再派发 */
let pendingDeepLink: string | null = null

function showMain(): void {
  // 主窗口被真正关掉过（关掉「关闭到浮窗」时）就重新开一个，
  // 否则托盘「显示主窗口」会变成一个没反应的死菜单项。
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function deliverDeepLink(url: string): void {
  const parsed = parseDeepLink(url)
  if (!parsed) return
  if (mainWindow) {
    showMain()
    mainWindow.webContents.send('app:deeplink', parsed)
  } else {
    pendingDeepLink = url
  }
}

function sendAction(action: string): void {
  showMain()
  mainWindow?.webContents.send('app:action', action)
}

/**
 * 全局热键：键名从 settings 表读（与 Python 版共用同一份配置），
 * ctrl+alt+n 这种写法由 toAccelerator 转成 Electron Accelerator。
 */
function registerHotkeys(): void {
  globalShortcut.unregisterAll()
  const s = currentSettings()
  const entries: { key: string; action: string }[] = [
    { key: s.quick_capture_hotkey, action: 'quick-capture' },
    { key: s.capture_hotkey, action: 'capture' },
    // 浮窗显隐热键：此前字段存在但从未注册，等于没有
    { key: s.widget_hotkey, action: 'toggle-widget' },
    // 划词速记（应用内动作与全局热键同一入口）
    { key: s.select_quick_hotkey, action: 'select-quick' },
  ]
  for (const { key, action } of entries) {
    const accel = toAccelerator(key)
    if (!accel) continue
    try {
      globalShortcut.register(accel, () => {
        // 浮窗显隐是主进程侧动作，不需要绕到渲染进程
        if (action === 'toggle-widget') toggleWidget()
        else sendAction(action)
      })
    } catch (err) {
      console.error('[hotkey] 注册失败', accel, err)
    }
  }
  // 开机自启（对齐 autostart.py 的跨平台注册；mac/win 由 Electron 代劳）
  try {
    app.setLoginItemSettings({ openAtLogin: s.autostart_enabled })
  } catch (err) {
    console.error('[autostart] 设置失败', err)
  }
}

/**
 * 托盘提示显示今日待办数（对齐 app_controller._update_tray_count）。
 * 此前 tooltip 是固定文案，少了一处「不打开应用也能看到今天还剩多少」的提醒。
 */
function updateTrayTooltip(): void {
  if (!tray || tray.isDestroyed()) return
  try {
    const n = listTodayTasks().roots.length
    tray.setToolTip(`知行 ZhiXing · 今天待办 ${n}`)
  } catch {
    tray.setToolTip('知行 ZhiXing')
  }
}

/** 系统托盘菜单，与 Python 版托盘项对齐（浮窗项待浮窗模块落地后再挂）。 */
function createTray(): void {
  const image = nativeImage.createFromPath(join(__dirname, '../../resources/trayTemplate.png'))
  if (image.isEmpty()) return
  if (process.platform === 'darwin') image.setTemplateImage(true)
  tray = new Tray(image)
  updateTrayTooltip()
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => showMain() },
      { label: '快速添加任务', click: () => sendAction('quick-capture') },
      { label: '划词捕获', click: () => sendAction('capture') },
      { label: '显示/隐藏浮窗', click: () => toggleWidget() },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          app.quit()
        },
      },
    ])
  )
  tray.on('click', () => showMain())
}

/**
 * 只用标准菜单（App / 编辑 / 窗口），**不挂 viewMenu**：
 * Electron 默认菜单带 View→Zoom，页面缩放会按 origin 存进 profile，
 * 一旦误触就整屏变大且重启不恢复——桌面应用不该有这种状态。
 */
function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { role: 'editMenu' as const },
    { role: 'windowMenu' as const },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1040,
    minHeight: 640,
    show: false,
    frame: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1F1F1F' : '#F3F3F3',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // 关闭到托盘：拦截关闭改为隐藏（对齐 close_to_widget），浮窗仍在运行。
  // 托盘「退出」走 app.quit → before-quit 已置 quitting，这里放行。
  win.on('close', (e) => {
    if (quitting) return
    if (currentSettings().close_to_widget) {
      e.preventDefault()
      win.hide()
    }
  })
  // Windows 11 云母材质（对齐 mica_enabled；其他平台/系统不支持时静默回退）
  if (process.platform === 'win32' && currentSettings().mica_enabled) {
    try {
      win.setBackgroundMaterial('mica')
    } catch (err) {
      console.error('[window] 云母材质不可用，回退实色底', err)
    }
  }
  win.on('ready-to-show', () => win.show())
  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  // 双保险：捏合缩放禁用，且启动时把 zoom 归位（清掉 profile 里的历史缩放）
  void win.webContents.setVisualZoomLevelLimits(1, 1).catch(() => undefined)
  win.webContents.setZoomLevel(0)
  win.webContents.on('did-finish-load', () => {
    win.webContents.setZoomLevel(0)
    // 冷启动深链在这里补发（那时窗口还不存在）
    if (pendingDeepLink) {
      const url = pendingDeepLink
      pendingDeepLink = null
      win.webContents.send('app:deeplink', parseDeepLink(url))
    }
  })

  // 导航、弹窗、webview 三道出口统一收口（见 main/security.ts）
  hardenWindow(win)

  if (isDev) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL as string)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

// 深链：macOS 走 open-url，Windows/Linux 走二次启动的 argv
app.setAsDefaultProtocolClient(SCHEME)
app.on('open-url', (event, url) => {
  event.preventDefault()
  deliverDeepLink(url)
})

const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const url = extractDeepLink(argv)
    if (url) deliverDeepLink(url)
    else showMain()
  })
}

app.whenReady().then(() => {
  app.setName('知行 ZhiXing')
  buildMenu()
  registerDbHandlers()
  // 首次运行把默认设置落库（对齐 ensure_defaults）：两版共用同一张 settings 表，
  // 不落库就会各自回退到不同默认，切换客户端时行为跳变。
  try {
    ensureDefaultSettings()
  } catch (err) {
    console.error('[db] 写入默认设置失败', err)
  }
  // 剪贴板监听（对齐 app_controller 的 clipboard_monitor）：
  // 复制后提示可快速捕获，带长度过滤、去重，且不打断用户输入。
  let lastClip = clipboard.readText()
  setInterval(() => {
    try {
      if (!currentSettings().clipboard_monitor) return
      const text = clipboard.readText()
      if (!text || text === lastClip) return
      lastClip = text
      if (text.trim().length < 8 || text.length > 2000) return
      sendAction('clipboard-notice')
    } catch (err) {
      console.error('[clipboard] 监听失败', err)
    }
  }, 2000)

  // 启动自动备份一次（对齐 BackupService.backup("auto")，保留最近 10 份）
  try {
    autoBackup('auto')
  } catch (err) {
    console.error('[backup] 启动备份失败', err)
  }
  registerHotkeys()
  createTray()
  // 任何写操作后刷新托盘标题（今日待办数）
  setDataChangedHook(updateTrayTooltip)
  // 浮窗默认随应用启动（widget_enabled / 关闭到浮窗的行为后续接入设置项）
  if (currentSettings().widget_enabled) createWidgetWindow()

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    dbPath: dbPath(),
    dbReady: true,
  }))

  // 主题同时驱动系统外观与窗口底色，避免新窗口或缩放时闪出另一套配色
  ipcMain.handle('theme:set', (e, theme: 'light' | 'dark' | 'system') => {
    nativeTheme.themeSource = theme
    // system 模式下窗口底色取系统实际明暗，避免新窗口闪出另一套配色
    const dark = theme === 'system' ? nativeTheme.shouldUseDarkColors : theme === 'dark'
    BrowserWindow.fromWebContents(e.sender)?.setBackgroundColor(dark ? '#1F1F1F' : '#F3F3F3')
  })

  ipcMain.handle('widget:toggle', () => {
    toggleWidget()
    return widgetWindow?.isVisible() ?? false
  })
  ipcMain.handle('widget:close', () => widgetWindow?.hide())
  ipcMain.handle('widget:setOpacity', (_e, value: number) => applyWidgetOpacity(value))
  ipcMain.handle('widget:setClickThrough', (_e, enabled: boolean) => applyWidgetClickThrough(enabled))
  ipcMain.handle('widget:undock', () => undockWidget())
  // 浮窗右键菜单（对齐 desktop_widget 的右键项：今日视图 / 取消贴边 / 隐藏浮窗）
  ipcMain.handle('widget:contextMenu', () => {
    if (!widgetWindow) return
    Menu.buildFromTemplate([
      { label: '今日视图', click: () => showMain() },
      { label: '取消贴边', click: () => undockWidget() },
      { type: 'separator' },
      { label: '隐藏浮窗', click: () => widgetWindow?.hide() },
    ]).popup({ window: widgetWindow })
  })
  ipcMain.handle('widget:openMain', () => showMain())

  ipcMain.handle('window:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.handle('window:toggleMaximize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (!w) return false
    if (w.isMaximized()) w.unmaximize()
    else w.maximize()
    return w.isMaximized()
  })
  ipcMain.handle('window:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  quitting = true
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  closeDb()
})
