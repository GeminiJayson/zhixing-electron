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
  systemPreferences,
} from 'electron'
import { join } from 'node:path'
import { release } from 'node:os'
import { extractDeepLink, parseDeepLink, toAccelerator } from '../shared/deep-link'
import { resolveThemePack } from '../shared/theme-packs'
import { WINDOW_MATERIALS, type WindowMaterial } from '../shared/settings'
import { initFileLog } from './log'
import { hardenWindow } from './security'
import { autoBackup, closeDb, currentSettings, dbPath, dbOpenError, dbReadonlyReason, ensureDefaultSettings, listTodayTasks, open, registerDbHandlers, saveWidgetGeometry, setDataChangedHook } from './db'

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
/** 启动欢迎页（对齐 view/shell/splash.py）：初始化完成后才露主窗。 */
let splashWindow: BrowserWindow | null = null
/** 主窗是否已经过 splash 阶段正式显示。此前不参与浮窗联动，避免启动瞬间弹出浮窗。 */
let mainReady = false
/** 是否正在真正退出（托盘「退出」/before-quit）。用来放行关闭拦截。 */
let quitting = false
/** 浮窗贴边状态：缩为把手后记住原宽度与所在侧，鼠标进入时滑出。 */
let widgetDock: { side: 'left' | 'right'; expandedWidth: number } | null = null
/** 浮窗边缘缩放进行中的状态（对齐 desktop_widget 的 _resize_dir/_resize_start_geom）。 */
let widgetResize: {
  edges: string
  startCursor: { x: number; y: number }
  start: { x: number; y: number; width: number; height: number }
} | null = null
/** 贴边把手宽度（对齐 desktop_widget 的 10px 把手） */
const DOCK_HANDLE_W = 10
/** 边缘缩放命中带宽度（对齐 desktop_widget 的 _RESIZE_MARGIN） */
const WIDGET_RESIZE_MARGIN = 6
/** 上一次托盘图标的配色，用于避免无谓的重着色 */
let lastTrayColor = ''

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

  // 几何写库（S19）：拖拽/缩放过程中 moved/resized 会连续触发，去抖到停手后只写一次；
  // 贴边态不写 —— 与 desktop_widget 一致，贴边时保留「未贴边」的用户几何，
  // 滑出/取消贴边时按原值还原。
  let persistTimer: NodeJS.Timeout | null = null
  const persistNow = (): void => {
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    if (!widgetWindow || widgetWindow.isDestroyed() || widgetDock) return
    const [x, y] = widgetWindow.getPosition()
    const [w, h] = widgetWindow.getSize()
    saveWidgetGeometry(x, y, w, h)
  }
  const persistSoon = (): void => {
    if (widgetDock) return
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null
      persistNow()
    }, 400)
  }
  // 贴边检测放在移动之后：拖动到屏幕边缘即缩成把手
  widgetWindow.on('moved', () => {
    if (!widgetDock) maybeDockWidget()
    else persistSoon()
  })
  widgetWindow.on('resized', persistSoon)
  widgetWindow.on('ready-to-show', () => {
    // 启动阶段只创建不显示（对齐 app_controller.startup 末尾的 self.widget.hide()）：
    // 主窗显示→隐藏浮窗、主窗隐藏→显示浮窗，统一由 syncWidgetVisibility 裁决。
    syncWidgetVisibility()
    // 恢复上次就贴在边缘的几何时也进入把手状态
    maybeDockWidget()
  })
  widgetWindow.on('hide', persistNow)
  widgetWindow.on('closed', () => {
    persistNow()
    widgetResize = null
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
  // 滑出后立即写库：此时已不是贴边态，几何就是用户最终看到的值
  const [nx, ny] = widgetWindow.getPosition()
  const [nw, nh] = widgetWindow.getSize()
  saveWidgetGeometry(nx, ny, nw, nh)
}

/** 用户显式切过浮窗：该状态下不被主窗显隐联动覆盖，直到主窗再次显隐。 */
let widgetManualOpen = false

function toggleWidget(): void {
  if (widgetWindow && widgetWindow.isVisible()) {
    widgetManualOpen = false
    widgetWindow.hide()
    return
  }
  widgetManualOpen = true
  if (!widgetWindow) createWidgetWindow()
  widgetWindow?.show()
  widgetWindow?.webContents.send('app:action', 'widget-refresh')
}

/**
 * 主窗显隐 → 浮窗显隐联动（对齐 app_controller._on_main_shown / _on_main_hidden）：
 * 主窗显示时隐藏浮窗，主窗隐藏（关闭到浮窗/最小化）时显示浮窗并刷新今日待办。
 */
function syncWidgetVisibility(): void {
  if (!widgetWindow || widgetWindow.isDestroyed()) return
  // splash 阶段主窗还没露面，此时不该弹浮窗
  if (!mainReady) {
    widgetWindow.hide()
    return
  }
  if (!currentSettings().widget_enabled) {
    widgetWindow.hide()
    return
  }
  if (widgetManualOpen) return
  const mainVisible =
    !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized()
  if (mainVisible) {
    widgetWindow.hide()
    return
  }
  widgetWindow.show()
  // 浮窗自身每 5s 轮询一次；主窗刚隐藏时立刻推一次，避免先看到过期列表
  widgetWindow.webContents.send('app:action', 'widget-refresh')
}

/**
 * 浮窗边缘缩放（S17，对齐 desktop_widget 的 _resize_hit/_apply_resize）：
 * 渲染层判定命中的边（'n'/'se'/'w' 等）后开始，主进程按屏幕光标位移重算尺寸。
 * 之所以放主进程算：光标可能移出窗口，渲染层拿不到完整位移。
 */
function widgetResizeStart(edges: string): void {
  if (!widgetWindow || widgetWindow.isDestroyed() || widgetDock) return
  const b = widgetWindow.getBounds()
  widgetResize = {
    edges: String(edges ?? ''),
    startCursor: screen.getCursorScreenPoint(),
    start: { x: b.x, y: b.y, width: b.width, height: b.height },
  }
}

function widgetResizeTo(): void {
  const rs = widgetResize
  if (!rs || !widgetWindow || widgetWindow.isDestroyed()) return
  const p = screen.getCursorScreenPoint()
  const dx = p.x - rs.startCursor.x
  const dy = p.y - rs.startCursor.y
  let { x, y, width, height } = rs.start
  if (rs.edges.includes('w')) {
    const nw = rs.start.width - dx
    if (nw >= WIDGET_MIN[0]) {
      x = rs.start.x + dx
      width = nw
    }
  }
  if (rs.edges.includes('e')) width = Math.max(WIDGET_MIN[0], rs.start.width + dx)
  if (rs.edges.includes('n')) {
    const nh = rs.start.height - dy
    if (nh >= WIDGET_MIN[1]) {
      y = rs.start.y + dy
      height = nh
    }
  }
  if (rs.edges.includes('s')) height = Math.max(WIDGET_MIN[1], rs.start.height + dy)
  widgetWindow.setBounds({ x, y, width, height })
}

/** 结束缩放：清状态并写一次几何（对齐 mouseReleaseEvent 里的 save_geometry）。 */
function widgetResizeEnd(): void {
  if (!widgetResize) return
  widgetResize = null
  if (!widgetWindow || widgetWindow.isDestroyed() || widgetDock) return
  const [x, y] = widgetWindow.getPosition()
  const [w, h] = widgetWindow.getSize()
  saveWidgetGeometry(x, y, w, h)
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
 * 热键注册状态（S20）：settings 键 → 中文状态串，与 Python 的
 * app_controller.hotkey_status 同形，设置页据此显示「已注册 / 冲突降级」。
 */
const hotkeyStatus: Record<string, string> = {}

/** 热键设置键 → 动作名（对齐 app_controller._hotkey_bindings）。 */
const HOTKEY_BINDINGS: { setting: string; action: string }[] = [
  { setting: 'capture_hotkey', action: 'capture' },
  { setting: 'select_quick_hotkey', action: 'select-quick' },
  { setting: 'quick_capture_hotkey', action: 'quick-capture' },
  { setting: 'widget_hotkey', action: 'toggle-widget' },
]

/**
 * 全局热键：键名从 settings 表读（与 Python 版共用同一份配置），
 * ctrl+alt+n 这种写法由 toAccelerator 转成 Electron Accelerator。
 *
 * 每次注册都刷新 hotkeyStatus：Electron 的 globalShortcut.register 在组合键被
 * 别的程序占用时返回 false（而不是抛错），此前这里没接收返回值，于是「改键后
 * 完全没反应」既无提示也无降级说明。
 */
function registerHotkeys(): Record<string, string> {
  globalShortcut.unregisterAll()
  const s = currentSettings()
  for (const { setting, action } of HOTKEY_BINDINGS) {
    const raw = String((s as unknown as Record<string, string>)[setting] ?? '')
    if (!raw) {
      delete hotkeyStatus[setting]
      continue
    }
    const accel = toAccelerator(raw)
    if (!accel) {
      hotkeyStatus[setting] = '键名无效（未注册）'
      continue
    }
    let ok = false
    try {
      ok = globalShortcut.register(accel, () => {
        // 浮窗显隐是主进程侧动作，不需要绕到渲染进程
        if (action === 'toggle-widget') toggleWidget()
        else sendAction(action)
      })
    } catch (err) {
      console.error('[hotkey] 注册失败', accel, err)
      ok = false
    }
    hotkeyStatus[setting] = ok ? '✓ 已注册' : '未授权/冲突（已降级为托盘菜单）'
  }
  // 开机自启（对齐 autostart.py 的跨平台注册；mac/win 由 Electron 代劳）
  try {
    app.setLoginItemSettings({ openAtLogin: s.autostart_enabled })
  } catch (err) {
    console.error('[autostart] 设置失败', err)
  }
  return { ...hotkeyStatus }
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

/**
 * 托盘图标配色：取当前主题包的 fg2（对齐 main_window._update_tray_icon 的
 * ThemeEngine.t("fg2")），明暗按 theme_mode / 系统实际值取对应的一套。
 */
function trayIconColor(): string {
  try {
    const s = currentSettings()
    const mode: 'light' | 'dark' =
      s.theme_mode === 'dark'
        ? 'dark'
        : s.theme_mode === 'light'
          ? 'light'
          : nativeTheme.shouldUseDarkColors
            ? 'dark'
            : 'light'
    const pack = resolveThemePack(s.theme_pack)
    return (mode === 'dark' ? pack.dark : pack.light).fg2 || '#666666'
  } catch {
    return '#666666'
  }
}

/**
 * 托盘图标：把模板图按主题色重着色（Python 侧用 icons.pixmap 按主题色重渲染图标；
 * Electron 侧没有图标渲染器，改为读模板 PNG 的位图、按 alpha 做单色填充）。
 * 任何一步失败都退回原图 —— 绝不出现「托盘图标消失」这种更糟的回退。
 */
function buildTrayImage(): Electron.NativeImage {
  const base = nativeImage.createFromPath(join(__dirname, '../../resources/trayTemplate.png'))
  if (base.isEmpty()) return base
  // macOS 用模板图自动适配菜单栏明暗，不做重着色
  if (process.platform === 'darwin') {
    base.setTemplateImage(true)
    return base
  }
  try {
    const { width, height } = base.getSize()
    const src = base.toBitmap()
    if (!width || !height) return base
    // 目录里有 trayTemplate@2x.png，toBitmap 可能返回 2 倍光栅：
    // 必须先按字节数反推出倍数，否则 createFromBitmap 会按 16×16 解读 32×32 的缓冲。
    let scale = 0
    for (const cand of [1, 2, 3]) {
      if (src.length === width * cand * height * cand * 4) {
        scale = cand
        break
      }
    }
    if (!scale) return base
    const hex = trayIconColor().replace('#', '')
    const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex
    if (!/^[0-9a-fA-F]{6}$/.test(full)) return base
    const r = parseInt(full.slice(0, 2), 16)
    const g = parseInt(full.slice(2, 4), 16)
    const b = parseInt(full.slice(4, 6), 16)
    const out = Buffer.from(src)
    // toBitmap 是 BGRA；按 alpha 加权写入，兼容预乘/非预乘两种排布
    for (let i = 0; i < out.length; i += 4) {
      const a = out[i + 3]
      out[i] = Math.round((b * a) / 255)
      out[i + 1] = Math.round((g * a) / 255)
      out[i + 2] = Math.round((r * a) / 255)
    }
    const img = nativeImage.createFromBitmap(out, {
      width: width * scale,
      height: height * scale,
      scaleFactor: scale,
    })
    return img.isEmpty() ? base : img
  } catch (err) {
    console.error('[tray] 图标重着色失败，沿用原图', err)
    return base
  }
}

/** 主题变化后重建托盘图标（对齐 main_window._on_theme → _update_tray_icon）。 */
function refreshTrayIcon(): void {
  if (!tray || tray.isDestroyed()) return
  const color = trayIconColor()
  if (color === lastTrayColor) return
  lastTrayColor = color
  const img = buildTrayImage()
  if (!img.isEmpty()) tray.setImage(img)
}

/**
 * 系统托盘菜单：动作集与 Python 的 _dispatch_action 对齐
 * （quick-capture / new-note / flash-inbox / capture / select-quick / widget）。
 */
function createTray(): void {
  const image = buildTrayImage()
  if (image.isEmpty()) return
  lastTrayColor = trayIconColor()
  tray = new Tray(image)
  updateTrayTooltip()
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => showMain() },
      { label: '快速添加任务', click: () => sendAction('quick-capture') },
      { label: '新建笔记', click: () => sendAction('new-note') },
      { label: '记闪念', click: () => sendAction('flash-inbox') },
      { label: '划词捕获', click: () => sendAction('capture') },
      { label: '读取选中并速记', click: () => sendAction('select-quick') },
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

/**
 * 材质 + 实际下发的取值。数据变更钩子每次写库都会跑，带着窗口引用去重：
 * 既省掉无谓的重复调用，又能保证窗口重建后一定重新下发一次。
 */
let lastMaterial: { win: BrowserWindow; material: WindowMaterial } | null = null

/**
 * 本机真正支持的材质。
 *
 * Electron 的 setBackgroundMaterial 在不支持的机器上**既不报错也不生效**（静默失效），
 * 所以支持性必须自己判：非 win32、Windows 10（build < 22000）、DWM 合成被关掉时
 * 一律退回 none。tabbed 要 22H2（build 22621）起才有，低版本同样降级。
 * 宁可给用户一个确定的实色窗口，也不要一个「选了没反应」的半透明项。
 */
function supportedMaterial(material: WindowMaterial): WindowMaterial {
  if (material === 'none' || process.platform !== 'win32') return 'none'
  const build = Number(/^\d+\.\d+\.(\d+)/.exec(release())?.[1] ?? 0)
  if (!build || build < 22000) return 'none'
  if (material === 'tabbed' && build < 22621) return 'none'
  try {
    // DWM 合成关闭时半透明窗口会画错，Electron 文档也建议先判这一项
    if (!systemPreferences.isAeroGlassEnabled()) return 'none'
  } catch {
    return 'none'
  }
  return material
}

/** 兼容两种载荷：旧调用点传布尔（true→mica、false→none），新代码传枚举字符串。 */
function normalizeMaterial(value: unknown): WindowMaterial {
  if (typeof value === 'boolean') return value ? 'mica' : 'none'
  return typeof value === 'string' && (WINDOW_MATERIALS as readonly string[]).includes(value)
    ? (value as WindowMaterial)
    : 'none'
}

/**
 * 下发窗口材质（对齐 Python 侧对 K_MICA 调 setMicaEffectEnabled）。
 *
 * 半透明材质是锦上添花：任何一步失败都只记录并退回 none，绝不让主进程因为一个
 * 外观选项崩掉 —— 这也是「枚举材质」比旧布尔开关多出来的风险面（acrylic / tabbed
 * 在低版本系统上更容易失效）。
 */
function applyMaterial(win: BrowserWindow | null, material: WindowMaterial): void {
  if (!win || win.isDestroyed()) return
  const effective = supportedMaterial(material)
  if (lastMaterial?.win === win && lastMaterial.material === effective) return
  // 窗口自带的 backgroundColor 会整块盖住材质（Mica/Acrylic 是 DWM 画在窗口底下的）——
  // 这是「切了材质没反应」的直接原因。材质生效时底色必须让位；退回 none 时给回不透明底色，
  // 否则 Win10 或 DWM 合成关闭的机器会直接透出桌面。
  try {
    win.setBackgroundColor(
      effective === 'none' ? (nativeTheme.shouldUseDarkColors ? '#1F1F1F' : '#F3F3F3') : '#00000000'
    )
  } catch {
    // 背景色只是材质的配套项，设不了也不该让主进程挂掉
  }
  try {
    win.setBackgroundMaterial(effective)
  } catch (err) {
    console.error('[window] 材质不可用，回退实色底', material, err)
    try {
      win.setBackgroundMaterial('none')
    } catch {
      // 连 none 都设不了就维持窗口自带的 backgroundColor，不再往上抛
    }
    lastMaterial = { win, material: 'none' }
    return
  }
  lastMaterial = { win, material: effective }
}

/** 材质设置变更后即时生效（对齐 app_controller 的 K_MICA 分支：改完不必重启）。 */
function syncWindowMaterial(): void {
  applyMaterial(mainWindow, currentSettings().material)
}

/**
 * 启动欢迎页（对齐 view/shell/splash.py + __main__.py:106-135）：
 * 无边框、居中、置顶，直到渲染层报告「首屏数据已就绪」才关闭并显示主窗，
 * 避免主窗先露出半成品界面。HTML 内联为 data: URL —— 启动页只有几十行，
 * 不值得为它单独增加一个渲染产物入口。
 */
function createSplash(): void {
  const dark = nativeTheme.shouldUseDarkColors
  const s = currentSettings()
  const bg = dark ? '#1F1F1F' : '#F3F3F3'
  const fg = dark ? '#F2F2F2' : '#1A1A1A'
  const accent = s.accent_color || '#0D9488'
  splashWindow = new BrowserWindow({
    width: 400,
    height: 300,
    frame: false,
    resizable: false,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;font-family:"PingFang SC","Microsoft YaHei UI",system-ui,sans-serif}
.s{box-sizing:border-box;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:28px;background:${bg};color:${fg};border-radius:14px;border:1px solid rgba(128,128,128,.20)}
.n{font-size:24px;font-weight:600}
.sub{font-size:13px;opacity:.6}
.bar{width:70%;height:4px;border-radius:2px;background:rgba(128,128,128,.18);overflow:hidden;margin-top:12px}
.bar>i{display:block;height:100%;width:40%;border-radius:2px;background:${accent};animation:p 1.1s ease-in-out infinite}
.st{font-size:12px;opacity:.6}
@keyframes p{0%{margin-left:-40%}100%{margin-left:100%}}
</style></head><body><div class="s">
<svg width="64" height="64" viewBox="0 0 64 64" fill="none" stroke="${accent}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">
<circle cx="18" cy="17" r="6.2"/><circle cx="46" cy="17" r="6.2"/><circle cx="32" cy="44" r="6.2"/>
<path d="M23.6 18.6 40.4 18.6"/><path d="M18.4 23.2 27.4 38.4"/><path d="M45.6 23.2 36.6 38.4"/>
<path d="M27.2 44.2l3.4 3.4 6.4-6.4"/></svg>
<div class="n">知行 ZhiXing</div><div class="sub">本地优先的个人待办与知识图谱</div>
<div class="bar"><i></i></div><div class="st">正在启动…</div>
</div></body></html>`
  void splashWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  splashWindow.on('ready-to-show', () => splashWindow?.show())
  splashWindow.on('closed', () => {
    splashWindow = null
  })
}

/** 关闭欢迎页并显示主窗（对齐 __main__.py 的 splash.fade_out → controller.show_main）。 */
function revealMain(): void {
  if (mainReady) return
  mainReady = true
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close()
  splashWindow = null
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.focus()
  }
  syncWidgetVisibility()
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    // 最小尺寸对齐 Python main_window.py:41-44 的 size=(1280, 820), min_size=(1024, 700)
    minWidth: 1024,
    minHeight: 700,
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
  // 窗口材质（旧 mica_enabled；其他平台/系统不支持时降级为不透明）
  applyMaterial(win, currentSettings().material)
  // 主窗显隐 → 浮窗显隐联动（S16）。主窗显示时收起浮窗，隐藏/最小化时放出浮窗。
  const onMainVisibility = (): void => {
    widgetManualOpen = false
    syncWidgetVisibility()
  }
  win.on('show', onMainVisibility)
  win.on('hide', onMainVisibility)
  win.on('minimize', onMainVisibility)
  win.on('restore', onMainVisibility)
  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
    if (!quitting) syncWidgetVisibility()
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
  // 欢迎页要先于主窗出现（对齐 __main__.py：splash.show() 在 AppContext 构造之前）
  try {
    createSplash()
  } catch (err) {
    console.error('[splash] 创建欢迎页失败', err)
  }
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
  // 任何写操作后刷新托盘标题（今日待办数）；主题/主题包改动会走同一条链路，
  // refreshTrayIcon 内部按最后一次配色去重，因此不会每次勾选任务都重着色。
  setDataChangedHook(() => {
    updateTrayTooltip()
    refreshTrayIcon()
    // widget_enabled / close_to_widget 改动后浮窗显隐立刻跟着变，不必重启
    syncWidgetVisibility()
    // 材质也是设置项：settings 域的任何写入都顺势重设一次（applyMaterial 内部去重）
    syncWindowMaterial()
  })
  // 浮窗随应用启动创建，但**不显示**（对齐 app_controller.startup 末尾的 self.widget.hide()）：
  // 启动只露主窗，之后由主窗显隐联动浮窗。
  if (currentSettings().widget_enabled) createWidgetWindow()

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    dbPath: dbPath(),
    // D2：ready=库是否打开；readonly=能打开但迁移失败（只读模式）；error=完全打不开的中文原因。
    // 渲染层据此决定是否弹危险横幅并给「恢复备份」入口。
    dbReady: open() !== null,
    dbReadonly: dbReadonlyReason(),
    dbError: open() === null ? dbOpenError() : '',
  }))

  // 主题同时驱动系统外观与窗口底色，避免新窗口或缩放时闪出另一套配色
  ipcMain.handle('theme:set', (e, theme: 'light' | 'dark' | 'system') => {
    nativeTheme.themeSource = theme
    // system 模式下窗口底色取系统实际明暗，避免新窗口闪出另一套配色
    const dark = theme === 'system' ? nativeTheme.shouldUseDarkColors : theme === 'dark'
    BrowserWindow.fromWebContents(e.sender)?.setBackgroundColor(dark ? '#1F1F1F' : '#F3F3F3')
    // 托盘图标 = 主题派生色，换明暗要重建（对齐 main_window._on_theme）
    refreshTrayIcon()
  })
  // 系统明暗变化（theme_mode=system 时）同样要重建托盘图标
  nativeTheme.on('updated', () => {
    refreshTrayIcon()
    const dark = nativeTheme.shouldUseDarkColors
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.setBackgroundColor(dark ? '#1F1F1F' : '#F3F3F3')
    }
  })

  /**
   * 材质即时设置。设置页现在走「写 settings → 数据变更钩子」这条主链路，
   * 这个通道保留是为了 preload 里已暴露的 app.setMica（其公开签名仍是布尔，
   * 不在本次改动范围）：载荷放宽为 unknown，布尔按老语义映射，非法值一律 none，
   * 旧调用点不会因此报错。
   */
  ipcMain.handle('app:setMica', (_e, value: unknown) =>
    applyMaterial(mainWindow, normalizeMaterial(value))
  )
  // 渲染层首屏就绪 → 关闭欢迎页并显示主窗（splash 流程的「完成」信号）
  ipcMain.handle('app:ready', () => revealMain())
  // 托盘图标随主题重建（S23）：设置页改主题/主题包后由数据变更钩子触发
  ipcMain.handle('app:refreshTray', () => refreshTrayIcon())

  // 改键流程（S20）：设置页进入捕获态前注销全部热键，避免被系统层吞掉按键；
  // 捕获完成或取消后统一重注册并回传状态（对齐 _suspend_hotkeys/_rebind_hotkeys）。
  ipcMain.handle('app:hotkeyStatus', () => ({ ...hotkeyStatus }))
  ipcMain.handle('app:suspendHotkeys', () => {
    globalShortcut.unregisterAll()
  })
  ipcMain.handle('app:rebindHotkeys', () => registerHotkeys())

  // 浮窗边缘缩放（S17）：渲染层命中边缘后开始/推进/结束
  ipcMain.handle('widget:resizeStart', (_e, edges: string) => widgetResizeStart(edges))
  ipcMain.handle('widget:resizeTo', () => widgetResizeTo())
  ipcMain.handle('widget:resizeEnd', () => widgetResizeEnd())

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
  // 初始化完成信号由渲染层给（App.tsx 首屏数据就绪后调 app.ready）；
  // 兜底定时器防止渲染层异常时应用一直停在欢迎页后面没有任何窗口。
  setTimeout(() => revealMain(), 8000)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
      revealMain()
    }
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
