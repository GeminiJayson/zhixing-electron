import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  Tray,
  globalShortcut,
  type MenuItemConstructorOptions,
  nativeImage,
  nativeTheme,
  screen,
  systemPreferences,
  dialog,
  Notification,
  shell,
  net,
  protocol,
} from 'electron'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx'
import {
  buildDocxParagraphs,
} from './docx-export'
import { release } from 'node:os'
import { quietFailure } from '../shared/quiet-failure'
import { extractDeepLink, parseDeepLink, toAccelerator } from '../shared/deep-link'
import { BLOUB_DEFAULT_SHAPE, BLOUB_SHAPES, normalizeBloubShape } from '../shared/bloub'
import { resolveThemePack } from '../shared/theme-packs'
import { initFileLog } from './log'
import { hardenWindow } from './security'
import { resolveAttachFile } from './clip-images'
import { refreshMountWatches } from './mounted-folder'
import { CLIP_ATTACH_SCHEME } from '../shared/clip-image'
import { logTaskActivity } from './db/task-activity'
import { dueTargets } from './db/workflow-scheduler'
import { startTriggerServer, stopTriggerServer } from './http-trigger'
import { listSettings, setSetting } from './db/settings'
import { registerKnowledgeIpc } from './knowledge-ipc'
import { registerVaultIpc, stopVaultTimers } from './vault/ipc'
import { startVaultServer, stopVaultServer } from './vault/server'
import { syncAllFolderLinkedTasks, autoBackup, broadcastDataChanged, closeDb, currentSettings, dbPath, dbOpenError, dbReadonlyReason, dueReminders, recordReminderFire, reminderPolicy, ensureDefaultSettings, listTodayTasks, open, registerDbHandlers, saveWidgetGeometry, saveWidgetBall, setDataChangedHook, snoozeReminder, dismissReminder, instantiateWorkflow, listScheduleTargets } from './db'
import { decideReminder } from '../shared/reminder'
import {
  cancelOrganizeLibrary,
  currentLibraryProgress,
  organizeLibraryWithAi,
  organizeNoteWithAi,
  setAiLibraryNotifier,
  testAiConnection,
} from './ai'
import { PRESET_ACCENTS, hexToRgb, nearestAccent } from './accent'
import { createHotkeyModule } from './hotkey'
import { createWindowModule } from './window'
import { createTrayModule } from './tray'
import { createWidgetModule } from './widget'
import {
  BALL_MARGIN,
  BALL_SIZE_DEFAULT,
  BALL_SIZE_MAX,
  BALL_SIZE_MIN,
  BALL_WIN_MIN,
  DOCK_EDGE,
  ballWindowPx,
  clampBallSize,
} from './widget-geometry'
import { findClipboardTriggers, listFolderTriggerTargets, recoverStuckInstances, setConditionAsker } from './db/workflow'
import { refreshFolderWatches, stopFolderWatches } from './folder-trigger'
import {
  checkNoteScript,
  checkUserScript,
  createUserScript,
  deleteUserScript,
  ensureScriptsDir,
  listUserScripts,
  readUserScript,
  renameUserScript,
  runUserScript,
  scriptReferences,
  scriptsDir,
  setScriptPinned,
  writeUserScript,
} from './user-scripts'
import { importAttachment, importAttachmentData, importAttachmentDataBatch } from './db/attachments'
import { syncExternalTasks, taskSyncStatus } from './task-sync'
import { readSelectedText } from './selection'
import { addFlash } from './db/inbox'

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

/*
  窗口状态。放在这里而不是 window.ts 里 —— 主进程别处大量读它：
  bubbleAvailable 判断提醒走气泡还是卡片、tray 的 getMainWindow、
  sendRemindersTo 往主窗推、多处 isDestroyed 判断。共 34 处引用。
  所以用可变对象持有，函数搬进 window.ts 后通过它读写，语义完全不变。
*/
const winState: {
  main: BrowserWindow | null
  splash: BrowserWindow | null
  /** 主窗是否已经过 splash 阶段正式显示 */
  ready: boolean
  /** 待处理的深链（启动早期收到的，等主窗就绪后再送） */
  pendingDeepLink: string | null
} = { main: null, splash: null, ready: false, pendingDeepLink: null }

const isDev = !!process.env.ELECTRON_RENDERER_URL

let tray: Tray | null = null
/** 上次渲染托盘图标用的强调色 key（用来判断要不要重建） */
let lastAccentKey = ''
/** 启动欢迎页：初始化完成后才露主窗。 */
/** 主窗是否已经过 splash 阶段正式显示。此前不参与浮窗联动，避免启动瞬间弹出浮窗。 */
/** 是否正在真正退出（托盘「退出」/before-quit）。用来放行关闭拦截。 */
let quitting = false
/** 待处理的深链（启动早期收到的，等主窗就绪后再送）。 */
/**
 * 浮窗形态：'full' 完整卡片 / 'ball' 悬浮球。
 * 球形态是一颗会做表情的球（bloub 引擎），而且**可以拖动、可以改大小**，
 * 不只是贴在边缘的一个把手。
 * 形态与位置是解耦的：球的位置/边长独立存在 widget_ball，贴边只是它的一种停靠状态。
 */
/** 球拖动中的起点：渲染层按下后由主进程按屏幕光标位移重算位置（光标可能移出窗口） */
let widgetBallDrag: {
  startCursor: { x: number; y: number }
  start: { x: number; y: number }
} | null = null
/** 浮窗边缘缩放进行中的状态。 */
let widgetResize: {
  edges: string
  startCursor: { x: number; y: number }
  start: { x: number; y: number; width: number; height: number }
} | null = null

function showMain(): void {
  // 主窗口被真正关掉过（关掉「关闭到浮窗」时）就重新开一个，
  // 否则托盘「显示主窗口」会变成一个没反应的死菜单项。
  if (!winState.main || winState.main.isDestroyed()) {
    winMod.createWindow()
    return
  }
  if (winState.main.isMinimized()) winState.main.restore()
  winState.main.show()
  winState.main.focus()
}

function deliverDeepLink(url: string): void {
  const parsed = parseDeepLink(url)
  if (!parsed) return
  if (winState.main) {
    showMain()
    winState.main.webContents.send('app:deeplink', parsed)
  } else {
    winState.pendingDeepLink = url
  }
}

function sendAction(action: string, payload?: unknown): void {
  showMain()
  winState.main?.webContents.send('app:action', action, payload ?? '')
}

/** 这三个热键动作都要把「当前选中的文字」带进去 */
const SELECTION_ACTIONS = new Set(['capture', 'select-quick', 'quick-capture'])

/**
 * 热键动作分发。读选区的三个动作必须**先取文本、再显示窗口** ——
 * showMain 会把焦点抢过来，之后模拟复制就只剩自己的界面可复制了。
 */
async function dispatchHotkeyAction(action: string): Promise<void> {
  // 划词直接入闪念：读完选区**不打开任何窗口**，直接落库。
  // 它和下面三个「读选区 + 开捕获窗」的动作不同，是按下即完成的静默路径，
  // 所以必须在 openCaptureWindow 那条分支之前单独处理掉。
  if (action === 'flash-quick') {
    const selected = await readSelectedText()
    const text = selected.text.trim()
    // 没选中任何文字就当没按过：写一条空闪念只会变成垃圾数据
    if (!text) return
    addFlash(text)
    broadcastDataChanged('flash')
    return
  }
  if (action === 'quick-note') {
    // 快速笔记浮窗：独立窗口、不显示主窗口 —— 用户是按热键唤出来随手记的
    openQuickNoteWindow()
    return
  }
  if (SELECTION_ACTIONS.has(action)) {
    const selected = await readSelectedText()
    // 独立窗口，且**不显示主窗口**：用户正按着热键在别的应用里选词
    openCaptureWindow(action === 'quick-capture' ? 'quick' : 'capture', selected)
    return
  }
  sendAction(action)
}

/*
  悬浮球 / 浮窗模块。状态在它自己的闭包里 —— 这里只拿到一组函数与几个只读访问器。
  依赖用注入而不是 import：那些函数定义在本文件里、又反过来要用 widget，
  互相 import 会成环。
*/
const widget = createWidgetModule({
  isDev,
  followWidgetSoon,
  isMainReady: () => winState.ready,
  getMainWindow: () => winState.main,
  getActiveReminders: () => activeReminders,
  dispatchReminders,
  showMain,
  sendAction,
  dispatchHotkeyAction,
  currentSettings,
})


/* 系统托盘模块。依赖 widget.toggleWidget（菜单里的「显示/隐藏浮窗」），
   所以排在 widget 之后。段内那两个图标函数（accentIconKey / themeIconPath）
   也搬过去了 —— 窗口图标要用 themeIconPath，这里通过 appIconPath 拿。 */
const trayMod = createTrayModule({
  currentSettings,
  listTodayTasks,
  showMain,
  sendAction,
  dispatchHotkeyAction,
  toggleWidget: () => widget.toggleWidget(),
  getMainWindow: () => winState.main,
})


/* 全局热键模块。依赖 widget.toggleWidget 与两个窗口开启函数，所以排在它们之后。 */
const hotkeyMod = createHotkeyModule({
  currentSettings,
  addFlash,
  readSelectedText,
  sendAction,
  toggleWidget: () => widget.toggleWidget(),
  openQuickNoteWindow,
  openCaptureWindow,
})

/* 主窗与欢迎页模块。状态用 winState（定义在上面）—— 别处大量读它，不搬走。 */
const winMod = createWindowModule({
  state: winState,
  currentSettings,
  isDev,
  widget: {
    syncWidgetVisibility: () => widget.syncWidgetVisibility(),
    setManualOpen: (v: boolean) => widget.setManualOpen(v),
  },
  isQuitting: () => quitting,
  tray: {
    updateTrayTooltip: () => trayMod.updateTrayTooltip(),
    appIconPath: (kind: 'app' | 'tray') => trayMod.appIconPath(kind),
  },
})

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

/**
 * AI 整理的两个入口。命名成 ai: 前缀而不是塞进 db:* ——
 * 它不是数据库操作，而是一次外部网络请求 + 审计 + 可能的写库。
 */
// ---------------------------------------------------------------- 捕获面板（独立窗口）

let captureWindow: BrowserWindow | null = null
let captureShowOnce: (() => void) | null = null

/**
 * 全局热键唤出的捕获面板：**独立小窗口**，且**不显示主窗口**。
 *
 * 与条件确认窗同理 —— 用户按下热键时正在别的应用里做事，把主窗口拽到前台等于打断他。
 * 窗口已经开着就直接复用（连按两次不会开出两个）。
 */
function openCaptureWindow(mode: 'quick' | 'capture', seed: { text: string; html: string }): void {
  const height = mode === 'capture' ? 470 : 300
  if (captureWindow && !captureWindow.isDestroyed()) {
    captureWindow.setSize(560, height)
    captureWindow.webContents.send('capture:open', { mode, seed })
    captureWindow.show()
    captureWindow.focus()
    return
  }
  const win = new BrowserWindow({
    width: 560,
    height,
    useContentSize: true,
    // 与条件窗一致：无边框 + 透明，只显示卡片；高度随后由 window:fitHeight 贴合
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    // 同条件窗：去掉 WS_THICKFRAME，消除透明窗口上那圈浅灰方角描边
    thickFrame: false,
    minWidth: 420,
    minHeight: 160,
    // 透明窗口在 Windows 上对 resizable 支持很差（会出现不显示/闪烁），
    // 尺寸反正已经跟着卡片高度自动贴合了，这里固定不可缩放。
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    center: true,
    show: false,
    title: mode === 'quick' ? '快速添加任务' : '划词捕获',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  captureWindow = win
  let shown = false
  const showOnce = (): void => {
    if (shown || win.isDestroyed()) return
    shown = true
    captureShowOnce = null
    win.show()
    win.focus()
  }
  captureShowOnce = showOnce
  win.on('closed', () => {
    if (captureWindow === win) captureWindow = null
    if (captureShowOnce === showOnce) captureShowOnce = null
  })
  win.webContents.once('did-finish-load', () => {
    if (win.isDestroyed()) return
    win.webContents.send('capture:open', { mode, seed })
    // 与条件窗一样：等渲染层把主题应用完再显示（1.5s 兜底）
    setTimeout(showOnce, 1500)
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}?capture=1`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { query: { capture: '1' } })
  }
}

// ---------------------------------------------------------------- 快速笔记浮窗

let quickNoteWindow: BrowserWindow | null = null
let quickNoteShowOnce: (() => void) | null = null
/** 拖拽改尺寸的起始矩形（主进程持有，见 quicknote:resizeStart 的注释） */
let quickNoteResizeFrom: Electron.Rectangle | null = null

/**
 * 快速笔记浮窗（形态 C）。
 *
 * 与捕获窗同一套窗口配置：无边框 + 透明 + 置顶 + 不可缩放，高度由 window:fitHeight 贴合。
 * 差别在**失焦行为**：捕获窗是"写完就走"，这里可以钉住 —— 钉住后 blur 不收，
 * 方便边做事边记；没钉住时 blur 只是 hide（不是 close），已存的内容都在库里，
 * 再按热键唤出来列表还在。
 */
export function openQuickNoteWindow(): void {
  if (quickNoteWindow && !quickNoteWindow.isDestroyed()) {
    quickNoteWindow.show()
    quickNoteWindow.focus()
    return
  }
  const win = new BrowserWindow({
    width: 560,
    height: 420,
    useContentSize: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    thickFrame: false,
    minWidth: 380,
    minHeight: 200,
    // 保持 resizable:false —— 透明窗口在 Windows 上对原生缩放支持很差（会闪烁/不显示）。
    // 尺寸改由渲染层的拖拽手柄调 setContentSize，程序化改尺寸不受这个限制影响。
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    center: true,
    show: false,
    title: '快速笔记',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  quickNoteWindow = win
  let shown = false
  const showOnce = (): void => {
    if (shown || win.isDestroyed()) return
    shown = true
    quickNoteShowOnce = null
    win.show()
    win.focus()
  }
  quickNoteShowOnce = showOnce
  win.on('blur', () => {
    // 钉住时常驻；没钉住只隐藏，数据仍在库里
    if (!quickNotePinned && !win.isDestroyed()) win.hide()
  })
  win.on('closed', () => {
    if (quickNoteWindow === win) quickNoteWindow = null
    if (quickNoteShowOnce === showOnce) quickNoteShowOnce = null
  })
  win.webContents.once('did-finish-load', () => {
    if (win.isDestroyed()) return
    setTimeout(showOnce, 1500)
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}?quicknote=1`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { query: { quicknote: '1' } })
  }
}

// ---------------------------------------------------------------- 番茄钟（独立小窗）

let pomodoroWindow: BrowserWindow | null = null
let pomodoroShowOnce: (() => void) | null = null
/** 拖动后的位置写库防抖：moved 事件一次拖动能触发几十次 */
let pomodoroMovedTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 番茄钟窗口位置：与浮窗几何同一个约定 —— 存在 `settings.ui_state` 这个 JSON 里。
 *
 * 读的时候要**校验还在不在可见工作区**：显示器拔掉/换分辨率之后，老坐标可能落在屏幕外，
 * 那样窗口会跑到看不见的地方（用户以为"番茄钟打不开了"）。
 */
function readPomodoroPos(): { x: number; y: number } | null {
  try {
    const raw = listSettings().ui_state ?? ''
    const state = JSON.parse(raw) as { pomodoro_pos?: { x?: number; y?: number } }
    const pos = state.pomodoro_pos
    if (typeof pos?.x !== 'number' || typeof pos.y !== 'number') return null
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea
      return pos.x! >= a.x - 40 && pos.x! < a.x + a.width - 40 && pos.y! >= a.y - 40 && pos.y! < a.y + a.height - 40
    })
    return visible ? { x: pos.x, y: pos.y } : null
  } catch {
    return null
  }
}

/** 记住番茄钟窗口位置（拖动后调用，已防抖）。存不下就算了 —— 它只是个顺手的偏好。 */
function savePomodoroPos(x: number, y: number): void {
  try {
    const raw = listSettings().ui_state ?? ''
    const state = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    state.pomodoro_pos = { x, y }
    setSetting('ui_state', JSON.stringify(state))
  } catch {
    // 忽略：位置记不住不影响专注
  }
}

/** 番茄钟卡片宽度：内容是一行时间 + 一行任务名 + 两个按钮，240 以下会挤。 */
const POMODORO_W = 300

/**
 * 番茄钟：**独立小窗**，不占主窗口。
 *
 * 为什么从主窗口右下角的浮条改成独立窗：
 * 1. 它与主窗口的生命周期本来就不同 —— 主窗口关掉（收进托盘/浮窗）时专注还该继续，
 *    而浮条跟着主窗口一起没了；
 * 2. 它要有自己的「被看见」的方式：贴在工作区右下角、alwaysOnTop，不抢主窗口的视线。
 * 卡片与截图里的捕获窗/条件窗共用同一套 .modal 骨架，所以外观天然一致。
 */
function openPomodoroWindow(payload: { taskId: number | null; title: string }): void {
  if (pomodoroWindow && !pomodoroWindow.isDestroyed()) {
    pomodoroWindow.webContents.send('pomodoro:open', payload)
    pomodoroWindow.show()
    pomodoroWindow.focus()
    return
  }
  // 贴工作区右下角（不是屏幕右下角）：多显示器与任务栏位置都按当前显示器算
  const area = screen.getPrimaryDisplay().workArea
  // 位置优先用上次拖动后的（用户把它拖到哪儿，下次就在哪儿），没有才贴右下角
  const saved = readPomodoroPos()
  const win = new BrowserWindow({
    width: POMODORO_W,
    height: 200,
    useContentSize: true,
    x: saved?.x ?? area.x + area.width - POMODORO_W - 24,
    y: saved?.y ?? area.y + area.height - 200 - 24,
    // 与捕获窗 / 条件窗一致：无边框 + 透明，只显示卡片；高度随后由 window:fitHeight 贴合
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    thickFrame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    show: false,
    title: '番茄钟',
    // 不占任务栏：它是个常驻的小工具，任务栏里再出现一个「知行」只会让人困惑
    skipTaskbar: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // **隐藏后计时不能被节流**：收起（hide）时窗口仍在跑 setInterval，
      // 默认的后台节流会把它压到约一分钟一次，倒计时当场失真。
      backgroundThrottling: false,
    },
  })
  pomodoroWindow = win
  // 拖动之后记住位置：下一次发起专注回到用户放的地方（不再永远贴右下角）。
  // moved 事件触发很密，防抖后再写库。
  win.on('moved', () => {
    if (pomodoroMovedTimer) clearTimeout(pomodoroMovedTimer)
    pomodoroMovedTimer = setTimeout(() => {
      pomodoroMovedTimer = null
      if (win.isDestroyed()) return
      const [x, y] = win.getPosition()
      savePomodoroPos(x, y)
    }, 600)
  })
  let shown = false
  const showOnce = (): void => {
    if (shown || win.isDestroyed()) return
    shown = true
    pomodoroShowOnce = null
    win.show()
    win.focus()
  }
  pomodoroShowOnce = showOnce
  win.on('closed', () => {
    if (pomodoroWindow === win) pomodoroWindow = null
    if (pomodoroShowOnce === showOnce) pomodoroShowOnce = null
  })
  win.webContents.once('did-finish-load', () => {
    if (win.isDestroyed()) return
    win.webContents.send('pomodoro:open', payload)
    // 与捕获窗一样：等渲染层把主题应用完再显示（1.5s 兜底）
    setTimeout(showOnce, 1500)
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}?pomodoro=1`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { query: { pomodoro: '1' } })
  }
}

/**
 * 独立弹窗的高度贴合：无边框窗口里多出来的空白很显眼，
 * 让渲染层量完卡片后回报，窗口高度跟着卡片走（宽度保持不变）。
 */
/**
 * 快速笔记浮窗的"钉住"标志。
 *
 * 窗口本身就是 alwaysOnTop，钉住改变的是**失焦后收不收窗** ——
 * 那是窗口侧的决策，所以标志放这里由它读（见 openQuickNoteWindow）。
 */
let quickNotePinned = false

export function isQuickNotePinned(): boolean {
  return quickNotePinned
}

function registerQuickNote(): void {
  ipcMain.handle('quicknote:setPinned', (_e, pinned: boolean) => {
    quickNotePinned = !!pinned
    return quickNotePinned
  })
  ipcMain.handle('quicknote:open', () => {
    openQuickNoteWindow()
    return true
  })
  /**
   * 尺寸可调（渲染层拖窗口边缘/角落）。
   *
   * 为什么不用窗口的 resizable：透明无边框窗口在 Windows 上的原生缩放会闪烁，
   * 项目里其余浮窗也都关着它（见 openCaptureWindow 的注释）。这里自绘八向热区，
   * 程序化 setBounds —— 观感与原生一致，又不受那个限制影响。
   *
   * 起始矩形记在**主进程**：渲染层每次只报位移增量，若由渲染层自己累加，
   * 快速拖动时窗口尺寸跟不上指针会产生累积误差（越拖越偏）。
   */
  ipcMain.handle('quicknote:resizeStart', () => {
    const win = quickNoteWindow
    if (!win || win.isDestroyed()) return false
    quickNoteResizeFrom = win.getBounds()
    return true
  })
  ipcMain.handle('quicknote:resize', (_e, dir: string, dx: number, dy: number) => {
    const win = quickNoteWindow
    const from = quickNoteResizeFrom
    if (!win || win.isDestroyed() || !from) return false
    const MIN_W = 380
    const MIN_H = 200
    let { x, y, width, height } = from
    const mx = Math.round(dx)
    const my = Math.round(dy)
    if (dir.includes('e')) width = Math.max(MIN_W, from.width + mx)
    if (dir.includes('s')) height = Math.max(MIN_H, from.height + my)
    if (dir.includes('w')) {
      width = Math.max(MIN_W, from.width - mx)
      // 左边拖：右边缘不动，所以 x 要跟着宽度变化走
      x = from.x + (from.width - width)
    }
    if (dir.includes('n')) {
      height = Math.max(MIN_H, from.height - my)
      y = from.y + (from.height - height)
    }
    win.setBounds({ x, y, width, height })
    return true
  })
  ipcMain.handle('quicknote:resizeEnd', () => {
    const win = quickNoteWindow
    quickNoteResizeFrom = null
    if (!win || win.isDestroyed()) return false
    const b = win.getBounds()
    return b.width + 'x' + b.height
  })
  ipcMain.on('quicknote:ready', () => quickNoteShowOnce?.())
  ipcMain.on('quicknote:close', () => quickNoteWindow?.close())
  ipcMain.on('quicknote:notice', (_e, message: string) => {
    // 回执只发给主窗口 —— 用户此刻多半在别的应用里，不要把主窗口拽到前台
    if (winState.main && !winState.main.isDestroyed()) {
      winState.main.webContents.send('app:action', 'notice', String(message ?? ''))
    }
  })
}

function registerWindowFit(): void {
  ipcMain.on('window:fitHeight', (e, height: number) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || win.isDestroyed()) return
    /**
     * 快速笔记窗**不参与** fitHeight：它的尺寸由用户拖拽决定（quicknote:setSize），
     * 卡片在 CSS 里撑满窗口、列表吃剩余空间。
     * 之前让它参与的结果是"拖大了也会被下一次 fitHeight 缩回卡片高度" ——
     * 表现为高度调不动。
     */
    if (win === quickNoteWindow) return
    const next = Math.max(120, Math.round(Number(height) || 0))
    const [w, cur] = win.getContentSize()
    if (Math.abs(cur - next) < 2) return
    win.setContentSize(w, next)
  })
}

/**
 * 到点提醒的**唯一消费者**。
 *
 * 此前渲染层自己轮询 `db:dueReminders`（查与清合一），主进程另开一条只读通道发系统通知 ——
 * 两个地方都从同一个 reminder_at 读，谁是消费方只是一个隐式约定。一旦再来第三个读者
 * （悬浮表情气泡），两边就会互相抢着清，用户反而少看到一条提醒。
 *
 * 现在收归这里一处：查出到期项 → 立刻消费（清 reminder_at，一次性语义）→ 把「已消费但
 * 用户还没处理」的那一份留在 activeReminders → 按优先级派发：
 *   1. 悬浮表情可见 → 气泡窗口（「从悬浮表情出现」）
 *   2. 否则         → 主窗口那张卡片（浮窗关掉 / 收进托盘时的兜底）
 * 两个窗口都只是显示器，只读不写。
 */
type ReminderRow = ReturnType<typeof dueReminders>[number]

/** 待展示的提醒（主进程唯一持有）：reminder_at 已清，这是「欠着用户、还没处理」的那一份。 */
let activeReminders: ReminderRow[] = []
let reminderWindow: BrowserWindow | null = null
let reminderNotifyTimer: NodeJS.Timeout | null = null
let reminderFollowTimer: NodeJS.Timeout | null = null
/** 气泡内容高度：渲染层量完上报，定位时要用 */
let reminderHeight = 200
let notifiedReminders = new Set<string>()

/** 气泡宽度：够放标题与一排按钮，又不至于横着占掉半屏 */
const REMINDER_W = 320
/** 气泡与浮窗之间的间隙 */
const REMINDER_GAP = 10

/**
 * 提醒气泡窗口。
 *
 * 为什么是独立窗口而不是画在浮窗里：浮窗贴边收成球时整个窗口只有球那么大
 * （BALL_WIN_MIN），气泡根本塞不下；把球窗口临时撑大又要跟贴边、拖拽、滚轮缩放
 * 那一整套几何逻辑打架。独立窗口让球留在自己的位置上，气泡从旁边长出来。
 */
function createReminderWindow(): void {
  if (reminderWindow && !reminderWindow.isDestroyed()) return
  reminderWindow = new BrowserWindow({
    width: REMINDER_W,
    height: reminderHeight,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    // 与浮窗同一个理由：Windows 下 resizable:false 会让 setBounds 的尺寸部分失效，
    // 而气泡高度由内容决定（渲染层量完上报），必须保持可程序化改尺寸。
    resizable: true,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  hardenWindow(reminderWindow)
  reminderWindow.setAlwaysOnTop(true, 'floating')
  reminderWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  reminderWindow.on('closed', () => {
    reminderWindow = null
  })
  if (isDev) {
    void reminderWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}?reminder=1`)
  } else {
    void reminderWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { reminder: '1' },
    })
  }
}

/**
 * 气泡落点：贴在浮窗 / 悬浮球旁边，并夹回工作区。
 * 浮窗落在屏幕右半边就放到它左边，反之放右边 —— 贴边的那一侧没有空间。
 */
function placeReminderWindow(height = reminderHeight): void {
  if (!reminderWindow || reminderWindow.isDestroyed()) return
  // 浮窗隐藏时也拿它上次的几何作锚：提醒就该从「球在的地方」长出来。
  // 若改成「不可见就退回右上角」，主窗口在前台时提醒又会变回原来那张卡片 ——
  // 那正是这次要换掉的行为。
  const ww = widget.getWindow()
  const anchor = ww && !ww.isDestroyed() ? ww.getBounds() : null
  const wa = (anchor ? screen.getDisplayMatching(anchor) : screen.getPrimaryDisplay()).workArea
  const h = Math.max(120, Math.round(height))
  let x: number
  let y: number
  if (anchor) {
    const onRightHalf = anchor.x + anchor.width / 2 > wa.x + wa.width / 2
    x = onRightHalf
      ? anchor.x - REMINDER_W - REMINDER_GAP
      : anchor.x + anchor.width + REMINDER_GAP
    y = Math.round(anchor.y + anchor.height / 2 - h / 2)
  } else {
    // 没有浮窗可依：贴右上角，与从前的卡片位置一致
    x = wa.x + wa.width - REMINDER_W - REMINDER_GAP
    y = wa.y + REMINDER_GAP
  }
  x = Math.max(wa.x, Math.min(x, wa.x + wa.width - REMINDER_W))
  y = Math.max(wa.y, Math.min(y, wa.y + wa.height - h))
  reminderWindow.setBounds({ x, y, width: REMINDER_W, height: h })
}

/**
 * 提醒走气泡的条件：浮窗启用着（球有地方可依）。
 *
 * 刻意**不要求浮窗此刻可见** —— 主窗口在前台时浮窗是隐藏的（widget.syncWidgetVisibility 的
 * 显隐联动），若把可见性也算进来，那种情况下提醒又会退回主窗口右上角那张卡片，
 * 「从悬浮表情出现」就等于没做。球不可见时气泡照样锚在它上次的位置上。
 */
function bubbleAvailable(): boolean {
  return !!widget.getWindow() && !(widget.getWindow()?.isDestroyed() ?? true) && currentSettings().widget_enabled
}

function sendRemindersTo(win: BrowserWindow | null, rows: ReminderRow[]): void {
  if (!win || win.isDestroyed()) return
  win.webContents.send('reminder:push', rows)
}

/** 把这一批提醒交给该显示它的那个窗口，并同步悬浮球的表情。 */
function dispatchReminders(): void {
  const toBubble = bubbleAvailable()
  sendRemindersTo(reminderWindow, toBubble ? activeReminders : [])
  sendRemindersTo(winState.main, toBubble ? [] : activeReminders)
  if (widget.getWindow() && !(widget.getWindow()?.isDestroyed() ?? true)) {
    // 有提醒时球切 notify 表情（由 WidgetBall 的节拍接管，见 widget:notice）
    widget.getWindow()!.webContents.send('widget:notice', toBubble ? activeReminders.length : 0)
  }
  if (toBubble && activeReminders.length) {
    // 「从悬浮表情出现」：球可能正被主窗口的显隐联动藏着，提醒来了就让它露面。
    // 只唤球，不唤整块卡片 —— 卡片凭空弹出来太打扰。
    if (
      widget.isBall() &&
      widget.getWindow() &&
      !(widget.getWindow()?.isDestroyed() ?? true) &&
      !(widget.getWindow()?.isVisible() ?? false)
    ) {
      widget.show()
    }
    placeReminderWindow()
    // showInactive：提醒露面但不把焦点从用户手上抢走
    reminderWindow?.showInactive()
  } else {
    reminderWindow?.hide()
  }
}

/** 浮窗移动 / 缩放时气泡跟着走（去抖：拖动过程每帧重排会闪）。 */
function followWidgetSoon(): void {
  if (!reminderWindow || reminderWindow.isDestroyed() || !reminderWindow.isVisible()) return
  if (reminderFollowTimer) clearTimeout(reminderFollowTimer)
  reminderFollowTimer = setTimeout(() => {
    reminderFollowTimer = null
    if (reminderWindow?.isVisible()) placeReminderWindow()
  }, 200)
}

/** 系统通知：与窗口内提醒同一批数据，独立开关。 */
function notifyReminders(rows: ReminderRow[]): void {
  if (!Notification.isSupported()) return
  for (const t of rows) {
    const key = String(t.id) + ':' + (t.reminder_at ?? '')
    if (notifiedReminders.has(key)) continue
    notifiedReminders.add(key)
    const note = new Notification({
      title: '待办提醒 · ' + t.title,
      body: t.due_date ? '截止 ' + t.due_date : '到点了',
    })
    note.on('click', () => showMain())
    note.show()
  }
  if (notifiedReminders.size > 200) {
    notifiedReminders = new Set([...notifiedReminders].slice(-100))
  }
}

/**
 * 工作流的定时调度：每分钟醒一次，问纯函数「哪些模板到点了」。
 *
 * 一分钟一次而不是"算好下一次的时刻再 setTimeout"：后者的定时器要跟着
 * 每次改计划重建，漏一次重建就再也不触发；分钟级扫描最多晚 60 秒，够用且不会坏。
 *
 * 应用没开就不跑 —— 这是桌面应用，不装常驻服务。错过的时间不补：
 * "每天九点"要的是九点那次，不是"开机补一次"。
 */
function startWorkflowScheduler(): void {
  const tick = (): void => {
    try {
      const hits = dueTargets(listScheduleTargets(), new Date())
      // 顺带核对一次目录监视的目标：模板编辑走 IPC 时会立刻刷新（见 setDataChangedHook），
      // 这里兜住"库被外部改了 / 首次启动"这类没有广播可听的情况
      refreshFolderWatches(listFolderTriggerTargets())
      for (const hit of hits) {
        // 不 await：长流程会跑很久，调度器不能被它卡住（下一分钟还要扫）
        void instantiateWorkflow(hit.id, null, null, undefined, 'schedule').then((inst) => {
          if (inst) console.log(`[wf] 按计划启动「${hit.name}」（${hit.label}）→ 实例 #${inst.id}`)
        })
      }
    } catch (err) {
      // 调度器不能因为一次异常就停摆
      console.error('[wf] 定时调度出错', err)
    }
  }
  const timer = setInterval(tick, 60_000)
  // 启动时先扫一次：应用常开时上一次关掉到这次打开之间可能正好跨过一个间隔
  tick()
  app.on('before-quit', () => clearInterval(timer))
}

function startReminderDispatch(): void {
  // E2E 脚本要验证提醒的**读取规则**（已到期 / 未到 / 等待中 / 已完成），而派发循环会
  // 抢先把 reminder_at 清掉，让那些断言随机失败。给脚本留一个开关，见 scripts/rollcheck.mjs。
  if (process.env.ZHIXING_NO_REMINDER_DISPATCH === '1') return
  if (reminderNotifyTimer) clearInterval(reminderNotifyTimer)
  reminderNotifyTimer = setInterval(() => {
    try {
      const s = currentSettings()
      if (!s.reminder_enabled) {
        // 关掉开关就是「别再打扰我」：连已经欠着的那一批也一起撤掉
        if (activeReminders.length) {
          activeReminders = []
          dispatchReminders()
        }
        return
      }
      // 上一批还没处理完就不叠加 —— 提醒是欠着的，不该被新一轮冲掉。
      if (activeReminders.length) return
      const rows = dueReminders()
      if (!rows.length) return

      /**
       * 顺序很要紧：**先派发成功、再消费**。
       *
       * 原来的写法是先 dismissReminder 再 dispatchReminders —— 消费不可回滚，一旦派发抛错，
       * activeReminders 已经非空而窗口什么都没收到；下一轮 tick 开头的
       * `if (activeReminders.length) return` 直接返回，这批提醒就再也不会推给任何窗口
       * （只有窗口重载时靠 reminder:current 拉回）。等于「提醒永久消失」。
       *
       * 现在：派发失败就撤掉这批、也不清 reminder_at —— 下一轮会重新查到并重试。
       * 反过来（派发成功但清库失败）只会导致重复提醒一次，比丢失安全。
       */
      activeReminders = rows
      try {
        if (s.reminder_notify) notifyReminders(rows)
        dispatchReminders()
      } catch (err) {
        activeReminders = []
        console.error('[reminder] 派发失败，本轮不作消费，下轮重试', err)
        return
      }
      // 确认已经交出去（webContents.send 是同步入队）之后才记账：
      // 记下「这是第几次」，次数用完才清掉显式的 reminder_at（一次性语义不变）。
      // 自动提醒没有 reminder_at 可清，靠这个计数停下。
      const policy = reminderPolicy()
      const now = new Date()
      for (const t of rows) {
        const d = decideReminder(t, policy, now)
        recordReminderFire(t.id, d.fired, d.base, d.done)
        // 活动流：这次提醒确实推给用户了才记账（上面的 try 已经保证派发成功）
        logTaskActivity(t.id, 'remind', '第 ' + d.fired + ' 次提醒')
      }
    } catch (err) {
      console.error('[reminder] 派发失败', err)
    }
  }, 30_000)
}

function registerReminderHandlers(): void {
  // 渲染层挂载时先拉一次：推送可能早于窗口加载完成
  ipcMain.handle('reminder:current', () => activeReminders)
  ipcMain.handle('reminder:dismiss', (_e, id: number) => {
    logTaskActivity(Number(id), 'dismiss')
    activeReminders = activeReminders.filter((t) => t.id !== id)
    dispatchReminders()
    return activeReminders
  })
  ipcMain.handle('reminder:snooze', (_e, id: number, minutes: number) => {
    const min = Number(minutes)
    snoozeReminder(Number(id), min)
    logTaskActivity(Number(id), 'snooze', min + ' 分钟后')
    activeReminders = activeReminders.filter((t) => t.id !== id)
    dispatchReminders()
    return activeReminders
  })
  /**
   * 「不再提醒」：与「知道了」共用同一套消费（清掉 reminder_at、把这一轮的计数推到用完），
   * 区别只在活动流里记的是 mute —— 用户明确表达了"别再提醒我"，这与"我看过了"不是一回事，
   * 速览的时间轴上要能分出来。**只对这一次生效**：以后重新设了提醒照样会响。
   */
  ipcMain.handle('reminder:mute', (_e, id: number, reason?: string | null) => {
    const taskId = Number(id)
    dismissReminder(taskId)
    logTaskActivity(taskId, 'mute', '不再提醒这条', reason ?? null)
    activeReminders = activeReminders.filter((t) => t.id !== taskId)
    dispatchReminders()
    return activeReminders
  })
  // 渲染层量完内容高度上报，气泡才不会留一截空白或者裁掉按钮
  ipcMain.handle('reminder:resize', (_e, height: number) => {
    reminderHeight = Math.max(120, Math.min(1200, Math.round(Number(height) || 0)))
    if (reminderWindow?.isVisible()) placeReminderWindow(reminderHeight)
  })
  ipcMain.handle('reminder:openTask', (_e, id: number) => {
    showMain()
    winState.main?.webContents.send('reminder:openTask', Number(id))
  })
}

/**
 * 目录选择与路径探测。
 *
 * 目录变化触发只认绝对路径 —— 让用户手敲一个带盘符的路径既容易错，
 * 也没法验证存在性；走系统对话框是唯一靠谱的入口。
 */
function registerDirectoryHandlers(): void {
  ipcMain.handle('app:pickDirectory', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const options = { properties: ['openDirectory' as const] }
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (picked.canceled || !picked.filePaths.length) return ''
    return picked.filePaths[0]
  })
  ipcMain.handle('app:pathExists', (_e, path: string) => {
    try {
      return existsSync(String(path ?? ''))
    } catch {
      return false
    }
  })
  ipcMain.handle('app:extensionDir', () => resolveExtensionDir())
  ipcMain.handle('app:openExtensionDir', async () => {
    const dir = resolveExtensionDir()
    const err = await shell.openPath(dir)
    return err ? { ok: false, message: err, dir } : { ok: true, message: dir, dir }
  })
}

/**
 * 浏览器扩展的目录。
 *
 * 打包后在 `resources/browser-extension`（见 electron-builder.yml 的 extraResources），
 * 开发时就在仓库根 —— 两处都找不到时返回打包路径，让设置页把"该放哪"如实显示出来，
 * 而不是给一个空字符串让用户对着空白发呆。
 */
function resolveExtensionDir(): string {
  const packed = join(process.resourcesPath, 'browser-extension')
  if (existsSync(join(packed, 'manifest.json'))) return packed
  const dev = join(app.getAppPath(), 'browser-extension')
  if (existsSync(join(dev, 'manifest.json'))) return dev
  return packed
}

/**
 * 用户脚本：列清单、跑一个、打开目录。
 *
 * 执行只走主进程 —— 渲染层没有 Node 能力（sandbox: true），
 * 而"能跑本机程序"这种权限不该被摊到界面进程里。
 */
function registerUserScriptHandlers(): void {
  ipcMain.handle('app:listUserScripts', () => listUserScripts())
  ipcMain.handle('app:runUserScript', (_e, file: string) => runUserScript(String(file ?? '')))
  ipcMain.handle('app:scriptsDir', () => ensureScriptsDir())
  ipcMain.handle('app:openScriptsDir', async () => {
    const dir = ensureScriptsDir()
    const err = await shell.openPath(dir)
    return err ? { ok: false, message: err } : { ok: true, message: dir }
  })
  // 知识库页的脚本站（树上的固定文件夹 + 编辑区）：读 / 写 / 新建 / 改名 / 删除
  ipcMain.handle('app:readUserScript', (_e, file: string) => readUserScript(String(file ?? '')))
  ipcMain.handle('app:writeUserScript', (_e, file: string, content: string) =>
    writeUserScript(String(file ?? ''), String(content ?? ''))
  )
  ipcMain.handle('app:createUserScript', (_e, name: string, runtime: string) =>
    createUserScript(String(name ?? ''), runtime as 'powershell' | 'cmd' | 'python' | 'node')
  )
  ipcMain.handle('app:renameUserScript', (_e, file: string, newName: string) =>
    renameUserScript(String(file ?? ''), String(newName ?? ''))
  )
  ipcMain.handle('app:deleteUserScript', (_e, file: string) => deleteUserScript(String(file ?? '')))
  ipcMain.handle('app:setScriptPinned', (_e, file: string, pinned: boolean) =>
    setScriptPinned(String(file ?? ''), Boolean(pinned))
  )
  ipcMain.handle('app:scriptReferences', (_e, file: string) => scriptReferences(String(file ?? '')))
  // 脚本笔记的语法校验：正文存在库里，运行时看 note.script_runtime
  ipcMain.handle('app:checkNoteScript', (_e, noteId: number, content: string) =>
    checkNoteScript(Number(noteId), String(content ?? ''))
  )
  // 语法校验：只解析不执行（判断在 main/user-scripts.ts 里，纯解析部分在 shared）
  ipcMain.handle('app:checkUserScript', (_e, file: string, content?: string) =>
    checkUserScript(String(file ?? ''), content === undefined ? undefined : String(content))
  )
  // 启动时就把目录与说明文件准备好：用户第一次去找它时它已经在了
  ensureScriptsDir()
  console.log('[scripts] 用户脚本目录：' + scriptsDir())
}

/** 附件：选文件 → 复制进数据目录 → 落库，返回归档后的路径给渲染层写进正文。 */
function registerAttachmentHandlers(): void {
  ipcMain.handle('attachment:pick', async (e, noteId: number) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const picked = win
      ? await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] })
      : await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })
    if (picked.canceled || !picked.filePaths.length) {
      return { ok: false, message: '已取消', paths: [] as string[] }
    }
    const paths: string[] = []
    const problems: string[] = []
    for (const src of picked.filePaths) {
      const res = importAttachment(noteId, src)
      if (res.ok && res.path) paths.push(res.path)
      else problems.push(res.message)
    }
    return {
      ok: paths.length > 0,
      message: paths.length
        ? `已归档 ${paths.length} 个附件${problems.length ? `（${problems.length} 个失败）` : ''}`
        : problems[0] ?? '导入失败',
      paths,
    }
  })
  // 粘贴/拖入的图片没有源文件路径，走这条把二进制直接存成附件
  ipcMain.handle('attachment:saveData', (_e, noteId: number, fileName: string, base64: string) =>
    importAttachmentData(Number(noteId), String(fileName ?? ''), String(base64 ?? ''))
  )
  // 多图上传：一次 IPC 存一批（渲染层原先在循环里逐张调 attachment:saveData）
  ipcMain.handle(
    'attachment:saveDataBatch',
    /**
     * noteId 为 null 表示「还没有归属」（快速笔记粘贴的图片）。
     *
     * **不能写成 Number(noteId)：Number(null) 是 0，不是 null** ——
     * 那会让下游去查 id=0 的笔记、查不到、返回「笔记不存在」，
     * 而调用方不检查返回值，于是整件事**静默失败**，用户只看到图片没落盘。
     */
    (_e, noteId: number | null, files: { fileName: string; base64: string }[]) =>
      importAttachmentDataBatch(
        noteId === null || noteId === undefined ? null : Number(noteId),
        (Array.isArray(files) ? files : []).map((f) => ({
          fileName: String(f?.fileName ?? ''),
          base64: String(f?.base64 ?? ''),
        }))
      )
  )
}

/** 用系统默认应用打开本地文件（Word / Excel 笔记的正文就是这个文件）。 */
function registerShellHandlers(): void {
  /**
   * Word 笔记导出：把编辑区当前的 HTML 转成 .docx。
   *
   * **绝不覆写原文件** —— 需求是「保留原文原件」，而 docx → HTML → docx 的往返
   * 一定会丢排版（分页、页眉页脚、精确字号这些 HTML 表达不了）。所以导出的是
   * 同目录下的一个新文件，原件保持原样、随时可回溯。
   */
  ipcMain.handle('word:exportDocx', async (_e, srcPath: string, html: string, title: string) => {
    try {
      const src = String(srcPath ?? '').trim()
      const dir = src ? dirname(src) : app.getPath('documents')
      const stem = (String(title ?? '').trim() || basename(src || '未命名')).replace(/\.docx$/i, '')
      // 目标目录不存在就建出来（用户给的路径可能指向一个还没建的文件夹）
      mkdirSync(dir, { recursive: true })
      const out = join(dir, stem + '-编辑版-' + Date.now().toString(36) + '.docx')
      const body = buildDocxParagraphs(String(html ?? ''))
      const doc = new Document({
        sections: [{ properties: {}, children: body as Paragraph[] }],
      })
      const buf = await Packer.toBuffer(doc)
            writeFileSync(out, buf)
      return { ok: true, path: out }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
  })

  ipcMain.handle('shell:openPath', async (_e, target: string) => {
    const p = String(target ?? '').trim()
    if (!p) return '路径为空'
    return await shell.openPath(p)
  })
}

function registerCaptureWindow(): void {
  // 应用内的入口（快捷键 n / 右下角浮条）：同样开独立窗口，不占主窗口
  ipcMain.handle('capture:open', (_e, mode: 'quick' | 'capture') => {
    openCaptureWindow(mode === 'capture' ? 'capture' : 'quick', { text: '', html: '' })
    return true
  })
  ipcMain.on('capture:ready', () => captureShowOnce?.())
  ipcMain.on('capture:close', () => captureWindow?.close())
  ipcMain.on('capture:done', (_e, message: string) => {
    captureWindow?.close()
    // 回执只发给主窗口（不把它显示出来 —— 用户此刻在别的应用里）
    if (winState.main && !winState.main.isDestroyed()) {
      winState.main.webContents.send('app:action', 'notice', String(message ?? ''))
    }
  })

  // 番茄钟：主窗口与浮窗都只是发起方，计时与落库在那个小窗里（见 openPomodoroWindow）
  ipcMain.handle('pomodoro:open', (_e, payload: { taskId: number | null; title: string }) => {
    openPomodoroWindow({
      taskId: typeof payload?.taskId === 'number' ? payload.taskId : null,
      title: String(payload?.title ?? ''),
    })
    return true
  })
  // 小窗每秒上报一次当前状态：主进程只转发给浮窗（收起后倒计时显示在悬浮表情上）
  ipcMain.on('pomodoro:state', (_e, state: unknown) => {
    widget.sendPomodoro((state ?? null) as never)
  })
  // 收起 / 展开：窗口是**隐藏**而不是关闭 —— 计时宿主在它里面，关掉计时就没了
  ipcMain.on('pomodoro:collapse', () => {
    if (pomodoroWindow && !pomodoroWindow.isDestroyed()) pomodoroWindow.hide()
  })
  ipcMain.on('pomodoro:expand', () => {
    if (pomodoroWindow && !pomodoroWindow.isDestroyed()) {
      pomodoroWindow.show()
      pomodoroWindow.focus()
      // 告诉小窗"你已经展开了"：它据此把上报里的 collapsed 置回 false，浮窗上那行倒计时才会收掉
      pomodoroWindow.webContents.send('pomodoro:expanded')
    }
  })
  ipcMain.on('pomodoro:ready', () => pomodoroShowOnce?.())
  ipcMain.on('pomodoro:close', () => {
    // 窗口没了就没有正在跑的番茄钟：把浮窗上的倒计时收掉，别让它挂着一个不动的数字
    widget.sendPomodoro(null)
    pomodoroWindow?.close()
  })
  ipcMain.on('pomodoro:done', (_e, message: string) => {
    // 一轮结束/中断：提示与「统计变了」都回给主窗口（它不因此被显示出来）
    if (winState.main && !winState.main.isDestroyed()) {
      winState.main.webContents.send('pomodoro:done', String(message ?? ''))
    }
  })
}

/** 正在等待应答的人工确认（工作流条件节点）：一次只开一个窗口 */
let conditionAsk: { id: string; resolve: (ok: boolean) => void } | null = null
let conditionAskSeq = 0
let conditionWindow: BrowserWindow | null = null
/** 当前窗口的「可以显示了」回调（渲染层应用完主题后调用） */
let conditionShowOnce: (() => void) | null = null
/**
 * 「把问询发给确认窗口」这件事**必须能被重放**。
 *
 * 原来的时序是：`did-finish-load` 里发 `condition:confirm` —— 但那只保证**页面加载完**，
 * 不保证 React 的 `useEffect` 已经挂上监听。实测会丢：窗口弹出来了，界面停在
 * 「正在读取条件…」，点「成立 / 不成立」**毫无反应**（`ConditionApp` 的 `answer()` 在
 * `ask` 为 null 时直接 return）。
 * 所以渲染层在挂载完成、应用完外观之后发的 `condition:ready`，这里要**再发一次**。
 */
let conditionSendAsk: (() => void) | null = null
/** 兜底等待上限：极端情况（窗口开着但没人理）不能让实例永久挂起 */
const CONDITION_ASK_TIMEOUT_MS = 10 * 60 * 1000

/** 排队：真出现并发询问（多个实例同时跑到条件节点）时一个一个来 */
const conditionQueue: { prompt: string; resolve: (ok: boolean | null) => void }[] = []
let conditionQueueBusy = false

/**
 * 工作流条件节点的「提示确认」：**单独开一个小窗口**（像浮窗那样独立于主窗口）。
 *
 * 为什么不像其它确认那样弹在应用窗口里：工作流是在后台推进的 —— 那一刻主窗口可能
 * 被最小化、藏进托盘，用户也可能正在别处。弹在应用窗口里要么看不见、要么像打断。
 * 独立小窗钉在屏幕中央、置顶，谁的窗口状态都不影响它出现。
 * 判定语义与原生模态完全一致：「成立」走条件分支，「不成立」走顺序下一步，直接关窗按「不成立」。
 */
function showConditionWindow(prompt: string): Promise<boolean | null> {
  return new Promise<boolean | null>((resolve) => {
    const win = new BrowserWindow({
      width: 420,
      height: 200,
      useContentSize: true,
      // 无边框 + 透明：只显示那张卡片本身，不要原生标题栏和白色窗口底。
      // 高度由渲染层量完卡片后回调 window:fitHeight 贴合。
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      // Windows 上无边框窗口仍带 WS_THICKFRAME（可缩放边框），透明窗口上它表现为
      // 一圈浅灰的**方角**描边。关掉它，圆角外面才是真正透明。
      thickFrame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      center: true,
      show: false,
      title: '工作流条件',
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    })
    conditionWindow = win
    const id = 'cond-' + String(++conditionAskSeq)

    let settled = false
    let timer: NodeJS.Timeout | undefined
    const finish = (ok: boolean | null): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      conditionAsk = null
      if (!win.isDestroyed()) win.close()
      resolve(ok)
    }

    timer = setTimeout(() => finish(false), CONDITION_ASK_TIMEOUT_MS)
    conditionAsk = { id, resolve: finish }

    let shown = false
    const showOnce = (): void => {
      if (shown || win.isDestroyed()) return
      shown = true
      conditionShowOnce = null
      win.show()
      win.focus()
    }
    conditionShowOnce = showOnce
    /** 发问询：可重放（见 conditionSendAsk 的注释）。 */
    const sendAsk = (): void => {
      if (win.isDestroyed()) return
      win.webContents.send('condition:confirm', { id, prompt })
    }
    conditionSendAsk = sendAsk
    win.webContents.once('did-finish-load', () => {
      if (win.isDestroyed()) return
      sendAsk()
      // 渲染层应用完主题（浅色/深色、字号）再显示 —— 否则会先闪一下默认配色。
      // 1.5s 兜底：万一 ready 没来，也不能让用户看不到这个确认框。
      setTimeout(showOnce, 1500)
    })
    // 页面根本没加载出来（渲染层异常等）：交给调用方回落原生模态，
    // 免得用户永远看不到这个确认框
    win.webContents.on('did-fail-load', () => finish(null))
    // 用户直接关窗 = 不成立（与原生的 cancelId=0 一致）
    win.on('closed', () => {
      if (conditionWindow === win) conditionWindow = null
      conditionSendAsk = null
      finish(false)
    })

    if (process.env.ELECTRON_RENDERER_URL) {
      void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}?condition=1`)
    } else {
      void win.loadFile(join(__dirname, '../renderer/index.html'), { query: { condition: '1' } })
    }
  })
}

async function pumpConditionQueue(): Promise<void> {
  if (conditionQueueBusy) return
  const next = conditionQueue.shift()
  if (!next) return
  conditionQueueBusy = true
  try {
    next.resolve(await showConditionWindow(next.prompt))
  } finally {
    conditionQueueBusy = false
    void pumpConditionQueue()
  }
}

function registerConditionAsk(): void {
  setConditionAsker(
    (prompt) =>
      new Promise<boolean | null>((resolve) => {
        conditionQueue.push({ prompt, resolve })
        void pumpConditionQueue()
      })
  )
  ipcMain.on('condition:ready', () => {
    conditionShowOnce?.()
    // 渲染层说「我挂好了」—— 这时再发一次问询，保证它一定收得到（见 conditionSendAsk 的注释）
    conditionSendAsk?.()
  })
  ipcMain.on('condition:answer', (_e, id: string, ok: boolean) => {
    if (!conditionAsk || conditionAsk.id !== String(id ?? '')) return
    conditionAsk.resolve(ok === true)
  })
}

/** 外部任务同步的定时器（开关关掉或没配地址时不跑） */
let taskSyncTimer: NodeJS.Timeout | null = null
let taskSyncBootTimer: NodeJS.Timeout | null = null

async function runTaskSync(): Promise<Awaited<ReturnType<typeof syncExternalTasks>>> {
  const res = await syncExternalTasks()
  if (res.ok && (res.created > 0 || res.updated > 0)) broadcastDataChanged('task')
  return res
}

/**
 * 定时同步的失败出口。
 *
 * 两个定时器都是 `void runTaskSync()` —— 没有 catch，一次异常就是未处理的 rejection，
 * 用户那边只表现为「同步悄悄不工作了」。这里把失败写进日志并弹一条可见提示。
 */
function runTaskSyncSafely(): void {
  void runTaskSync().catch((err: unknown) => {
    console.error('[task-sync] 同步失败', err)
    sendAction('notice', '外部同步失败：' + (err instanceof Error ? err.message : String(err)))
  })
}

/**
 * 按设置重排自动同步：关掉开关就不跑；间隔改了立刻生效。
 * 启动后先等 30 秒再跑第一次（别和启动时的一堆初始化抢资源）。
 */
function scheduleTaskSync(): void {
  if (taskSyncTimer) {
    clearInterval(taskSyncTimer)
    taskSyncTimer = null
  }
  if (taskSyncBootTimer) {
    clearTimeout(taskSyncBootTimer)
    taskSyncBootTimer = null
  }
  const s = currentSettings()
  if (!s.task_api_enabled || !s.task_api_url.trim()) return
  const every = Math.max(5, s.task_api_interval_min) * 60_000
  taskSyncBootTimer = setTimeout(() => runTaskSyncSafely(), 30_000)
  taskSyncTimer = setInterval(() => runTaskSyncSafely(), every)
}

function registerTaskSyncHandlers(): void {
  ipcMain.handle('taskSync:now', () => runTaskSync())
  ipcMain.handle('taskSync:status', () => taskSyncStatus())
  // 设置页改完地址 / 开关 / 间隔后调一次，重排定时器
  ipcMain.handle('taskSync:reload', () => {
    scheduleTaskSync()
    return true
  })
}

function registerAiHandlers(): void {
  // 整库整理是长任务：进度用事件推给所有窗口，界面据此显示「第 n/m 篇」与停止按钮
  setAiLibraryNotifier((p) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('ai:libraryProgress', p)
    }
    // 每处理完一篇就刷新一次：笔记树（新文件夹）、图谱、任务引用都会跟着变
    if (p.done > 0) broadcastDataChanged('note')
  })
  ipcMain.handle('ai:organizeNote', async (_e, noteId: number) => {
    const outcome = await organizeNoteWithAi(Number(noteId))
    // 整理会改标题 / 文件夹 / 正文：笔记、任务（引用）与图谱都可能受影响
    if (outcome.ok) {
      broadcastDataChanged('note')
      broadcastDataChanged('task')
    }
    return outcome
  })
  ipcMain.handle('ai:testConnection', () => testAiConnection())
  ipcMain.handle('ai:organizeLibrary', async () => {
    const outcome = await organizeLibraryWithAi()
    broadcastDataChanged('note')
    return outcome
  })
  ipcMain.handle('ai:cancelLibrary', () => cancelOrganizeLibrary())
  ipcMain.handle('ai:libraryProgress', () => currentLibraryProgress())
}

/**
 * 剪藏图片走自定义协议。
 *
 * **必须在 app ready 之前注册为特权协议**，否则渲染层会把它当成未知 scheme：
 * 图片不显示、`fetch` 直接失败（而且不报错，只是空白）。
 * `standard` 让它有正常的 origin 语义，`supportFetchAPI` 让渲染层能用 fetch 读它
 * （端到端脚本靠这条验证图片真的落盘了）。
 */
protocol.registerSchemesAsPrivileged([
  { scheme: CLIP_ATTACH_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

app.whenReady().then(() => {
  app.setName('知行 ZhiXing')
  // `zx-attach://` → <数据目录>/attachments/clip/ 下的真实文件。
  // 路径合法性全部由 resolveAttachFile 判定（挡 .. / 斜杠 / 越界），这里只做 IO。
  // 挂载的本地文件夹：建 watcher（顺带收掉路径已失效的挂载点）
  refreshMountWatches()
  protocol.handle(CLIP_ATTACH_SCHEME, async (req) => {
    const file = resolveAttachFile(req.url)
    if (!file) return new Response('not found', { status: 404 })
    return net.fetch(pathToFileURL(file).toString())
  })
  buildMenu()
  registerDbHandlers()
  registerAiHandlers()
  registerConditionAsk()
  /**
   * 启动自愈：把「停在人工节点却没有任何未完成待办」的实例补派一次。
   * 见 `recoverStuckInstances` 的注释 —— 修好派发逻辑之后，已经卡住的老实例还需要有人把它们叫醒。
   */
  try {
    recoverStuckInstances()
  } catch (err) {
    console.error('[workflow] 启动自愈失败', err)
  }
  registerTaskSyncHandlers()
  registerCaptureWindow()
  registerShellHandlers()
  registerAttachmentHandlers()
  registerDirectoryHandlers()
  registerUserScriptHandlers()
  registerWindowFit()
  registerQuickNote()
  startReminderDispatch()
  registerReminderHandlers()
  scheduleTaskSync()
  startWorkflowScheduler()
  /**
   * 外部触发端点：端口交给系统分配（listen(0)），实际端口写进 settings
   * —— 用户在设置页能看到"要调用哪个地址"。启动失败只记日志，不拦应用。
   */
  void startTriggerServer().then((port) => {
    if (port == null) return
    try {
      setSetting('workflow_trigger_port', String(port))
      console.log(`[wf] 外部触发端点：http://127.0.0.1:${port}/hook/<token>`)
    } catch (err) {
      console.error('[wf] 记录触发端口失败', err)
    }
  })
  // 欢迎页要先于主窗出现
  try {
    winMod.createSplash()
  } catch (err) {
    console.error('[splash] 创建欢迎页失败', err)
  }
  // 首次运行把默认设置落库，避免读取时回退到不一致的默认值。
  try {
    ensureDefaultSettings()
  } catch (err) {
    console.error('[db] 写入默认设置失败', err)
  }
  // 剪贴板监听：
  // 复制后提示可快速捕获，带长度过滤、去重，且不打断用户输入。
  let lastClip = clipboard.readText()
  setInterval(() => {
    try {
      const text = clipboard.readText()
      if (!text || text === lastClip) return
      lastClip = text
      // 剪贴板触发器**不看 clipboard_monitor 开关**：那是"复制后提示我捕获"的开关，
      // 而"复制到某段文本就启动流程"是用户自己配的触发器，没道理被它连坐。
      // 超长文本直接跳过：正则跑在几万字的剪贴上既慢又几乎不可能是用户的本意。
      if (text.length <= 20000) {
        for (const hit of findClipboardTriggers(text)) {
          void instantiateWorkflow(hit.id, null, null, undefined, 'clipboard').then((inst) => {
            if (inst) console.log(`[wf] 剪贴板命中 → 启动「${hit.name}」→ 实例 #${inst.id}`)
          })
        }
      }
      if (!currentSettings().clipboard_monitor) return
      if (text.trim().length < 8 || text.length > 2000) return
      sendAction('clipboard-notice')
    } catch (err) {
      console.error('[clipboard] 监听失败', err)
    }
  }, 2000)

  // 启动自动备份一次
  try {
    autoBackup('auto')
  } catch (err) {
    console.error('[backup] 启动备份失败', err)
  }
  hotkeyMod.registerHotkeys()
  trayMod.createTray()
  // 任何写操作后刷新托盘标题（今日待办数）；主题/主题包改动会走同一条链路，
  // trayMod.refreshTrayIcon 内部按最后一次配色去重，因此不会每次勾选任务都重着色。
  setDataChangedHook((domain) => {
    trayMod.updateTrayTooltip()
    trayMod.refreshTrayIcon()
    // widget_enabled / close_to_widget 改动后浮窗显隐立刻跟着变，不必重启
    widget.syncWidgetVisibility()
    // 工作流模板的触发器刚改过：目录监视立刻重建，不必等下一次分钟级扫描
    if (domain === 'workflow') refreshFolderWatches(listFolderTriggerTargets())
    // 笔记/任务有动静后，让「关联了文件夹」的任务重新对齐自动引用。
    // 它**直接写库、不走写域表**，所以不会把自己再触发一遍；真有改动时补一次广播，
    // 让界面当场看到关联列表变化（否则要切页）。
    if (domain === 'note' || domain === 'task') {
      if (syncAllFolderLinkedTasks() > 0) broadcastDataChanged('task')
    }
  })
  // 浮窗随应用启动创建，但**不显示**：
  // 启动只露主窗，之后由主窗显隐联动浮窗。
  if (currentSettings().widget_enabled) widget.createWidgetWindow()
  // 提醒气泡窗口与浮窗同理：启动就创建，但不显示（首次派发时才露面）。
  // 必须常驻 —— 等有提醒才建的话，reminder:push 会落在窗口加载完成之前，那一条就丢了。
  createReminderWindow()

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    dbPath: dbPath(),
    // ready=库是否打开；readonly=能打开但迁移失败（只读模式）；error=完全打不开的中文原因。
    // 渲染层据此决定是否弹危险横幅并给「恢复备份」入口。
    dbReady: open() !== null,
    dbReadonly: dbReadonlyReason(),
    dbError: open() === null ? dbOpenError() : '',
  }))

  // 主题同时驱动系统外观与窗口底色，避免新窗口或缩放时闪出另一套配色
  ipcMain.handle('theme:set', (e, theme: 'light' | 'dark' | 'system') => {
    nativeTheme.themeSource = theme
    // system 模式下窗口底色取系统实际明暗，避免新窗口闪出另一套配色。
    // **只给主窗**：底色是给不透明窗口防闪屏用的，而浮窗 / 提醒气泡 / 划词捕获都是
    // 透明窗口 —— 给它们设 backgroundColor 会让周围本该透明的部分变成一块方形底色。
    const dark = theme === 'system' ? nativeTheme.shouldUseDarkColors : theme === 'dark'
    const sender = BrowserWindow.fromWebContents(e.sender)
    if (sender && sender === winState.main && !sender.isDestroyed()) {
      sender.setBackgroundColor(dark ? '#1F1F1F' : '#F3F3F3')
    }
    // 托盘图标 = 主题派生色，换明暗要重建
    trayMod.refreshTrayIcon()
  })
  // 系统明暗变化（theme_mode=system 时）同样要重建托盘图标
  nativeTheme.on('updated', () => {
    trayMod.refreshTrayIcon()
    const dark = nativeTheme.shouldUseDarkColors
    // 同上：只碰主窗，透明窗口的底色必须一直是全透明
    if (winState.main && !winState.main.isDestroyed()) {
      winState.main.setBackgroundColor(dark ? '#1F1F1F' : '#F3F3F3')
    }
  })

  // 渲染层首屏就绪 → 关闭欢迎页并显示主窗（splash 流程的「完成」信号）
  ipcMain.handle('app:ready', () => winMod.revealMain())
  // 托盘图标随主题重建：设置页改主题/主题包后由数据变更钩子触发
  ipcMain.handle('app:refreshTray', () => trayMod.refreshTrayIcon())

  // 改键流程：设置页进入捕获态前注销全部热键，避免被系统层吞掉按键；
  // 捕获完成或取消后统一重注册并回传状态。
  /**
   * ⚠️ 通道名必须是 `app:hotkeyStatus` —— 与 preload 的 `hotkeyStatus()` 对应。
   * 这里原本写成了 `'app:hotkeyMod.getHotkeyStatus()'`（某个方法名被当成字符串拼了进来），
   * 于是渲染层每次调用都报 `No handler registered for 'app:hotkeyStatus'`，
   * 设置页的快捷键分区拿不到状态、只显示空白。
   */
  ipcMain.handle('app:hotkeyStatus', () => ({ ...hotkeyMod.getHotkeyStatus() }))
  ipcMain.handle('app:suspendHotkeys', () => {
    globalShortcut.unregisterAll()
  })
  ipcMain.handle('app:rebindHotkeys', () => hotkeyMod.registerHotkeys())
  /**
   * 应用内触发一次全局动作（例如「选中入闪念」）。
   *
   * 为什么需要这条通道：全局热键是**系统级注册**的，注入式按键（SendKeys / SendInput）
   * 不会被 RegisterHotKey 派发，所以自动化里没法「真按一次」；应用内也再没有别的入口。
   * 有了它，界面与端到端验证都能走到与热键**完全相同**的那条分发函数。
   */
  ipcMain.handle('app:hotkeyAction', (_e, action: string) =>
    typeof action === 'string' ? dispatchHotkeyAction(action) : undefined
  )
  /**
   * 探测一个组合键现在能不能注册（注册成功立刻注销）。
   *
   * 为什么需要：只在保存后才报「注册不上」的话，用户得先改一次才知道这个组合被占了。
   * 进入改键捕获态时全部热键已经注销，正是探测的干净时机。
   */
  ipcMain.handle('app:probeHotkey', (_e, raw: string) => {
    const accel = toAccelerator(String(raw ?? ''))
    if (!accel) return false
    if (globalShortcut.isRegistered(accel)) return true
    try {
      const ok = globalShortcut.register(accel, () => undefined)
      if (ok) globalShortcut.unregister(accel)
      return ok
    } catch (e) {
      // 注册失败会让用户「设了快捷键却什么也不发生」，必须留下是哪一组
      quietFailure('注册全局快捷键', e, accel)
      return false
    }
  })

  // 浮窗边缘缩放：渲染层命中边缘后开始/推进/结束
  ipcMain.handle('widget:resizeStart', (_e, edges: string) => widget.widgetResizeStart(edges))
  ipcMain.handle('widget:resizeTo', () => widget.widgetResizeTo())
  ipcMain.handle('widget:resizeEnd', () => widget.widgetResizeEnd())

  ipcMain.handle('widget:toggle', () => {
    widget.toggleWidget()
    return widget.getWindow()?.isVisible() ?? false
  })
  // 浮窗上的「隐藏」= 收起成悬浮球（球留在桌面上，点它随时展开回来）
  ipcMain.handle('widget:close', () => widget.collapseWidgetToBall())
  ipcMain.handle('widget:setOpacity', (_e, value: number) => widget.applyWidgetOpacity(value))
  /** 渲染层挂载时问一次当前透明度（推送可能早于它挂载） */
  ipcMain.handle('widget:opacityGet', () => currentSettings().widget_opacity)
  ipcMain.handle('widget:setClickThrough', (_e, enabled: boolean) => widget.applyWidgetClickThrough(enabled))
  ipcMain.handle('widget:undock', () => widget.expandWidget())
  /** 浮窗当前形态：'ball' 悬浮球 / 'full' 完整卡片（渲染层挂载时先问一次） */
  ipcMain.handle('widget:mode', () => widget.getMode())
  ipcMain.handle('widget:ballShape', () => widget.getBallShape())
  // 与右键菜单同一个入口：应用内也能改体型（也让端到端验证不必去点原生菜单）
  ipcMain.handle('widget:setBallShape', (_e, id: string) => widget.setBallShape(String(id)))
  // 悬浮球拖动：渲染层只报告「正在拖」，位移由主进程按屏幕光标重算（光标可能移出窗口）
  ipcMain.handle('widget:dragStart', () => widget.ballDragStart())
  ipcMain.handle('widget:dragTo', () => widget.ballDragTo())
  ipcMain.handle('widget:dragEnd', (_e, moved: boolean) => widget.ballDragEnd(moved === true))
  // 悬浮球大小（滚轮 / 右键菜单），主进程钳在 BALL_SIZE_MIN~MAX
  ipcMain.handle('widget:setBallSize', (_e, size: number) => widget.setBallSize(Number(size)))
  // 浮窗右键菜单
  ipcMain.handle('widget:contextMenu', () => {
    if (!widget.getWindow()) return
    const items: MenuItemConstructorOptions[] = [{ label: '今日视图', click: () => showMain() }]
    if (widget.isBall()) {
      items.push({ label: '展开浮窗', click: () => widget.expandWidget() })
      items.push({
        label: '悬浮球大小',
        submenu: [
          {
            label: '小（88）',
            type: 'radio',
            checked: widget.getBall().size <= 96,
            click: () => widget.setBallSize(BALL_SIZE_MIN),
          },
          {
            label: '中（112）',
            type: 'radio',
            checked: widget.getBall().size > 96 && widget.getBall().size <= 128,
            click: () => widget.setBallSize(112),
          },
          {
            label: '大（144）',
            type: 'radio',
            checked: widget.getBall().size > 128,
            click: () => widget.setBallSize(144),
          },
        ],
      })
      // 体型只在待机类状态（idle / wink / wide / notify）看得见 —— 这是上游的设计：
      // 其余状态的轮廓本身就是动画，换形状没有意义
      items.push({
        label: '身体形状',
        submenu: BLOUB_SHAPES.map((s) => ({
          label: s.label,
          type: 'radio' as const,
          checked: widget.getBall().shape === s.id,
          click: () => widget.setBallShape(s.id),
        })),
      })
    } else {
      items.push({ label: '贴边停靠', click: () => widget.collapseWidgetToBall() })
    }
    items.push({ type: 'separator' })
    items.push({ label: '隐藏浮窗', click: () => widget.getWindow()?.hide() })
    Menu.buildFromTemplate(items).popup({ window: widget.getWindow() ?? undefined })
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

  /**
   * 密码保险箱。
   *
   * 自动锁定的分钟数从设置里现读（每次 tick 读一遍，改设置立即生效，不用重启）。
   * 锁定时广播给所有窗口 —— 渲染层收到后要把已解密的列表从 React 状态里清掉，
   * 否则锁定后界面上还留着明文（见方案 §7.3）。
   */
  registerVaultIpc({
    getAutoLockMinutes: () => {
      const raw = listSettings().vault_auto_lock_min
      const n = Number.parseInt(raw ?? '5', 10)
      return Number.isFinite(n) && n >= 0 ? n : 5
    },
    onLocked: () => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('vault:locked')
      }
    },
    /**
     * 剪贴板里出现了像密码的内容。
     * **只往界面推一条提示**，不自动建条目、不弹窗 —— 我们不知道那段文本
     * 是不是真的密码，也不知道它属于哪个站点，所以决定权必须留给用户。
     */
    onClipboardCandidate: (text: string) => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('vault:clipboardCandidate', text)
      }
    },
  })

  /**
   * 浏览器扩展用的本地端点。
   * 只监听 127.0.0.1，写入类端点要令牌；锁定状态下拒收任何凭据（见 vault/server.ts）。
   */
  startVaultServer()

  // 知识库：类型 / 可信状态 / 来源引用。没有"直接创建可用知识"的通道。
  registerKnowledgeIpc()

  winMod.createWindow()
  // 初始化完成信号由渲染层给（App.tsx 首屏数据就绪后调 app.ready）；
  // 兜底定时器防止渲染层异常时应用一直停在欢迎页后面没有任何窗口。
  setTimeout(() => winMod.revealMain(), 8000)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      winMod.createWindow()
      winMod.revealMain()
    }
  })
})

// 退出前停掉保险箱的定时器：剪贴板清除与自动锁定不该在退出过程中再触发
app.on('before-quit', () => {
  stopVaultTimers()
  stopVaultServer()
  // 目录监视不主动关也行（fs.watch 是 persistent:false），但显式关掉更干净：
  // 退出过程中目录里再落文件时不该还去启动流程
  stopFolderWatches()
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
