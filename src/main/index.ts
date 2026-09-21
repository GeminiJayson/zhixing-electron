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
} from 'electron'
import { basename, dirname, join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx'
import {
  buildDocxParagraphs,
} from './docx-export'
import { release } from 'node:os'
import { extractDeepLink, parseDeepLink, toAccelerator } from '../shared/deep-link'
import { BLOUB_DEFAULT_SHAPE, BLOUB_SHAPES, normalizeBloubShape } from '../shared/bloub'
import { resolveThemePack } from '../shared/theme-packs'
import { initFileLog } from './log'
import { hardenWindow } from './security'
import { autoBackup, broadcastDataChanged, closeDb, currentSettings, dbPath, dbOpenError, dbReadonlyReason, dismissReminder, dueReminders, ensureDefaultSettings, listTodayTasks, open, registerDbHandlers, saveWidgetGeometry, saveWidgetBall, setDataChangedHook, snoozeReminder } from './db'
import {
  cancelOrganizeLibrary,
  currentLibraryProgress,
  organizeLibraryWithAi,
  organizeNoteWithAi,
  setAiLibraryNotifier,
  testAiConnection,
} from './ai'
import { setConditionAsker } from './db/workflow'
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
/**
 * 浮窗形态：'full' 完整卡片 / 'ball' 悬浮球。
 * 与 Python 版「10px 把手」有意分歧：这里收成一颗会做表情的球（bloub 引擎），
 * 而且球**可以拖动、可以改大小**，不再只是贴在边缘的一个把手。
 * 形态与位置是解耦的：球的位置/边长独立存在 widget_ball，贴边只是它的一种停靠状态。
 */
let widgetMode: 'full' | 'ball' = 'full'
/** 球形态几何：位置 + 球体边长 + 上次展开尺寸（展开时按它还原浮窗） */
let widgetBall = {
  x: 0,
  y: 0,
  size: 96,
  /** 悬浮球的体型（bloub 的形状 id，见 shared/bloub） */
  shape: BLOUB_DEFAULT_SHAPE,
  expandedWidth: 290,
  expandedHeight: 380,
}
/** 球拖动中的起点：渲染层按下后由主进程按屏幕光标位移重算位置（光标可能移出窗口） */
let widgetBallDrag: {
  startCursor: { x: number; y: number }
  start: { x: number; y: number }
} | null = null
/** 浮窗边缘缩放进行中的状态（对齐 desktop_widget 的 _resize_dir/_resize_start_geom）。 */
let widgetResize: {
  edges: string
  startCursor: { x: number; y: number }
  start: { x: number; y: number; width: number; height: number }
} | null = null
/** 悬浮球：球体边长下限（88px 起表情才清晰）/ 上限 / 默认值 / 窗口四周留白 */
const BALL_SIZE_MIN = 88
const BALL_SIZE_MAX = 160
const BALL_SIZE_DEFAULT = 96
const BALL_MARGIN = 8
/** 贴边吸附阈值：球（或浮窗）边缘贴进工作区 8px 内即吸附 / 收成球 */
const DOCK_EDGE = 8
/** 球体边长 → 窗口边长（四周留 BALL_MARGIN：放 hover 放大与投影） */
const ballWindowPx = (size: number): number => size + BALL_MARGIN * 2
/** 钳住球体边长：下限 88px，再小表情就看不清了 */
const clampBallSize = (size: number): number =>
  Math.round(Math.max(BALL_SIZE_MIN, Math.min(BALL_SIZE_MAX, size || BALL_SIZE_DEFAULT)))
/**
 * 球形态窗口的最小边长（按最小球体算）。
 * **固定不变**：最小尺寸一变，平台会异步重排窗口（保持左上角），把紧随其后的 setBounds
 * 位置参数盖掉 —— 症状就是「球变大了、位置却没动」。所以缩放时不去动最小尺寸。
 */
const BALL_WIN_MIN = BALL_SIZE_MIN + BALL_MARGIN * 2
/**
 * 展开后距屏幕边缘的留白。必须大于 DOCK_EDGE —— 展开走的 setBounds 同样会触发
 * `moved`，留白不够会被立刻重新判定为贴边，刚展开又收回去。
 */
const DOCK_RESTORE_INSET = 12
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
 * 读取悬浮球上次的位置 / 边长（ui_state.widget_ball）。
 * `active` 表示上次退出时停在球形态 —— 启动要直接以球露面。
 */
function readWidgetBall(): {
  x: number | null
  y: number | null
  size: number
  shape: string
  active: boolean
  expandedWidth: number
  expandedHeight: number
} {
  const fallback = {
    x: null as number | null,
    y: null as number | null,
    size: BALL_SIZE_DEFAULT,
    shape: BLOUB_DEFAULT_SHAPE,
    active: false,
    expandedWidth: WIDGET_SIZE[0],
    expandedHeight: WIDGET_SIZE[1],
  }
  try {
    const state = JSON.parse(currentSettings().ui_state) as { widget_ball?: Record<string, unknown> }
    const b = state.widget_ball
    if (!b || typeof b !== 'object') return fallback
    const num = (v: unknown, d: number): number => (Number.isFinite(Number(v)) ? Number(v) : d)
    return {
      x: Number.isFinite(Number(b.x)) ? num(b.x, 0) : null,
      y: Number.isFinite(Number(b.y)) ? num(b.y, 0) : null,
      size: clampBallSize(num(b.size, BALL_SIZE_DEFAULT)),
      active: b.active === true,
      shape: normalizeBloubShape(typeof b.shape === 'string' ? b.shape : null),
      expandedWidth: Math.max(WIDGET_MIN[0], num(b.expandedWidth, WIDGET_SIZE[0])),
      expandedHeight: Math.max(WIDGET_MIN[1], num(b.expandedHeight, WIDGET_SIZE[1])),
    }
  } catch {
    return fallback
  }
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
    // 必须保持 resizable：Windows 上非 resizable 窗口的 setSize / setBounds 尺寸部分
    // 会被忽略，而球的滚轮缩放、展开收起全靠程序化改尺寸（实测 resizable:false 会让
    // setBallSize 完全失效）。卡片形态的边缘缩放另有自实现（widgetResizeStart/To/End）。
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

  // 几何写库（S19）：拖拽/缩放过程中 moved/resized 会连续触发，去抖到停手后只写一次。
  // 球形态的几何写进 widget_ball，绝不覆盖 widget_geometry —— 展开时还要靠后者还原。
  let persistTimer: NodeJS.Timeout | null = null
  const persistNow = (): void => {
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    if (!widgetWindow || widgetWindow.isDestroyed() || widgetMode === 'ball') return
    const [x, y] = widgetWindow.getPosition()
    const [w, h] = widgetWindow.getSize()
    saveWidgetGeometry(x, y, w, h)
  }
  const persistSoon = (): void => {
    if (widgetMode === 'ball') return
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null
      persistNow()
    }, 400)
  }
  /**
   * 球的去抖收尾：停手后吸附到最近边缘并写库。
   * 拖动过程中 moved 每帧都触发，逐帧吸附会让球「粘」在边缘拖不动。
   */
  const persistBallSoon = (): void => {
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null
      rememberBallPosition()
      snapBallToNearestEdge()
      persistBall()
    }, 400)
  }
  widgetWindow.on('moved', () => {
    // 提醒气泡锚在浮窗旁边，浮窗一动它就得跟着（内含去抖）
    followWidgetSoon()
    // 球形态：窗口本身就是球，拖动只更新球位置（停手后再吸附 + 写库）
    if (widgetMode === 'ball') {
      rememberBallPosition()
      persistBallSoon()
      return
    }
    // 卡片形态：拖到屏幕边缘就收成球，否则按老规矩去抖写浮窗几何
    if (maybeDockWidget()) return
    persistSoon()
  })
  widgetWindow.on('resized', () => {
    followWidgetSoon()
    if (widgetMode === 'ball') persistBallSoon()
    else persistSoon()
  })
  widgetWindow.on('ready-to-show', () => {
    // 上次退出时就是球 → 直接按保存的位置与大小以球露面
    const restored = readWidgetBall()
    if (restored.active) restoreBall(restored)
    // 否则：上次停在屏幕边缘的浮窗几何 → 第一次露面就收成球，别把整卡片挤进小窗口
    else maybeDockWidget()
    // 启动阶段只创建不显示（对齐 app_controller.startup 末尾的 self.widget.hide()）：
    // 主窗显示→隐藏浮窗、主窗隐藏→显示浮窗，统一由 syncWidgetVisibility 裁决。
    syncWidgetVisibility()
  })
  widgetWindow.on('hide', () => {
    if (widgetMode === 'ball') persistBall()
    else persistNow()
  })
  widgetWindow.on('closed', () => {
    if (widgetMode === 'ball') persistBall()
    else persistNow()
    widgetResize = null
    widgetBallDrag = null
    widgetWindow = null
  })

  if (isDev) {
    void widgetWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}?widget=1`)
  } else {
    void widgetWindow.loadFile(join(__dirname, '../renderer/index.html'), { query: { widget: '1' } })
  }
}

/**
 * 通知渲染层切换形态：'ball' 画悬浮球，'full' 画完整卡片。
 * 渲染层挂载时也会主动问一次（`widget:mode`），这条推送负责后续切换。
 */
function sendWidgetMode(): void {
  if (!widgetWindow || widgetWindow.isDestroyed()) return
  widgetWindow.webContents.send('widget:mode', widgetMode)
}

/**
 * 设置窗口几何：**先用 setBounds 原子落地，再只改位置纠偏一次**。
 *
 * 两个 API 在窗口隐藏/可见两种阶段各有一半不可靠，所以必须两者都用：
 *   - 隐藏时（restoreBall 走 ready-to-show）setPosition 落不下去，只能靠 setBounds；
 *   - 可见时 Windows 会因尺寸变化按「保持左上角」异步重排一次，把 setBounds 的位置盖掉
 *     （实测 setBounds(276,276,176,176) 落成 (300,300,176,176)），要等重排过去再只改位置。
 */
function applyWidgetBounds(bounds: {
  x: number
  y: number
  width: number
  height: number
}): void {
  if (!widgetWindow || widgetWindow.isDestroyed()) return
  /** 只改位置、不改尺寸 —— 改尺寸会再触发一次重排，等于白改 */
  const setPos = (): void => {
    if (!widgetWindow || widgetWindow.isDestroyed()) return
    widgetWindow.setPosition(bounds.x, bounds.y)
  }
  // 第一步落地：隐藏窗口阶段只有 setBounds 能把位置一起带过去（setPosition 落不下去）
  widgetWindow.setBounds(bounds)
  // 第二步纠偏：可见窗口的尺寸重排是异步的，会按「保持左上角」把位置拉回原处，
  // 等它发生之后再纠正位置。setImmediate 覆盖同帧重排，setTimeout 兜底更晚的重排。
  setImmediate(setPos)
  setTimeout(setPos, 120)
}

/** 从窗口当前位置刷新内存里的球坐标（拖动过程中会连续调用）。 */
function rememberBallPosition(): void {
  if (!widgetWindow || widgetWindow.isDestroyed() || widgetMode !== 'ball') return
  const [x, y] = widgetWindow.getPosition()
  widgetBall.x = x
  widgetBall.y = y
}

/** 球状态写库：位置 / 边长 / 体型 / 上次展开尺寸 / 当前是否就是球形态。 */
function persistBall(active = true): void {
  saveWidgetBall({
    x: Math.round(widgetBall.x),
    y: Math.round(widgetBall.y),
    size: clampBallSize(widgetBall.size),
    shape: widgetBall.shape,
    active,
    expandedWidth: Math.round(widgetBall.expandedWidth),
    expandedHeight: Math.round(widgetBall.expandedHeight),
  })
}

/**
 * 换悬浮球体型：改内存 + 落库 + 推给浮窗重画。
 * 不重建窗口、也不动几何 —— 换的是渲染参数，不是布局。
 */
function setBallShape(id: string): void {
  const shape = normalizeBloubShape(id)
  if (widgetBall.shape === shape) return
  widgetBall.shape = shape
  persistBall(widgetMode === 'ball')
  widgetWindow?.webContents.send('widget:ballShape', shape)
}

/** 按保存的球几何以球形态露面（位置越界时钳回对应显示器的工作区）。 */
function restoreBall(saved: ReturnType<typeof readWidgetBall>): void {
  if (!widgetWindow || widgetWindow.isDestroyed()) return
  const win = ballWindowPx(saved.size)
  widgetBall.size = saved.size
  widgetBall.shape = saved.shape
  widgetBall.expandedWidth = saved.expandedWidth
  widgetBall.expandedHeight = saved.expandedHeight
  const wa = screen.getDisplayMatching({
    x: saved.x ?? 0,
    y: saved.y ?? 0,
    width: win,
    height: win,
  }).workArea
  const x = saved.x === null ? wa.x : Math.max(wa.x, Math.min(saved.x, wa.x + wa.width - win))
  const y =
    saved.y === null ? wa.y + 120 : Math.max(wa.y, Math.min(saved.y, wa.y + wa.height - win))
  widgetBall.x = x
  widgetBall.y = y
  widgetMode = 'ball'
  widgetWindow.setMinimumSize(BALL_WIN_MIN, BALL_WIN_MIN)
  sendWidgetMode()
  applyWidgetBounds({ x, y, width: win, height: win })
}

/**
 * 收起成球（「隐藏」按钮 / 拖到屏幕边缘 / 右键「贴边停靠」）。
 * 记住当前浮窗尺寸以便展开还原；不指定侧时贴最近的一侧，竖直对齐浮窗中心。
 */
function collapseWidgetToBall(side?: 'left' | 'right'): void {
  if (!widgetWindow || widgetWindow.isDestroyed() || widgetMode === 'ball') return
  const b = widgetWindow.getBounds()
  const wa = screen.getDisplayMatching(b).workArea
  widgetBall.expandedWidth = Math.max(WIDGET_MIN[0], b.width)
  widgetBall.expandedHeight = Math.max(WIDGET_MIN[1], b.height)
  const win = ballWindowPx(widgetBall.size)
  const target = side ?? (b.x + b.width / 2 <= wa.x + wa.width / 2 ? 'left' : 'right')
  const x = target === 'left' ? wa.x : wa.x + wa.width - win
  const centerY = b.y + Math.round(b.height / 2)
  const y = Math.max(wa.y, Math.min(centerY - Math.round(win / 2), wa.y + wa.height - win))
  widgetBall.x = x
  widgetBall.y = y
  widgetMode = 'ball'
  // 最小尺寸会把 setBounds 钳回去，收球前必须先放开
  widgetWindow.setMinimumSize(BALL_WIN_MIN, BALL_WIN_MIN)
  sendWidgetMode()
  applyWidgetBounds({ x, y, width: win, height: win })
  persistBall()
  // 「隐藏」按钮走的就是这条路：球必须露出来，否则用户再也找不回浮窗
  widgetWindow.show()
}

/**
 * 浮窗贴边：贴近屏幕左右边缘时收成悬浮球（对齐 desktop_widget 的贴边半隐语义）。
 * 返回是否真的收成了球 —— 调用方据此决定要不要再写浮窗几何。
 */
function maybeDockWidget(): boolean {
  if (!widgetWindow || widgetWindow.isDestroyed() || widgetMode === 'ball') return false
  const b = widgetWindow.getBounds()
  const wa = screen.getDisplayMatching(b).workArea
  const nearLeft = b.x - wa.x <= DOCK_EDGE
  const nearRight = wa.x + wa.width - (b.x + b.width) <= DOCK_EDGE
  if (!nearLeft && !nearRight) return false
  collapseWidgetToBall(nearLeft ? 'left' : 'right')
  return true
}

/** 球松手后吸附：水平贴进边缘就吸平，竖直只钳进工作区（球可以停在任意高度）。 */
function snapBallToNearestEdge(): void {
  if (!widgetWindow || widgetWindow.isDestroyed() || widgetMode !== 'ball') return
  const b = widgetWindow.getBounds()
  const wa = screen.getDisplayMatching(b).workArea
  let x = b.x
  if (b.x - wa.x <= DOCK_EDGE) x = wa.x
  else if (wa.x + wa.width - (b.x + b.width) <= DOCK_EDGE) x = wa.x + wa.width - b.width
  const y = Math.max(wa.y, Math.min(b.y, wa.y + wa.height - b.height))
  if (x !== b.x || y !== b.y) widgetWindow.setBounds({ x, y, width: b.width, height: b.height })
}

/** 改球的大小（滚轮 / 右键菜单）：以球心为锚点缩放，窗口跟着一起变。 */
function setBallSize(size: number): void {
  if (!widgetWindow || widgetWindow.isDestroyed() || widgetMode !== 'ball') return
  const next = clampBallSize(size)
  if (next === widgetBall.size) return
  const b = widgetWindow.getBounds()
  const cx = b.x + b.width / 2
  const cy = b.y + b.height / 2
  const win = ballWindowPx(next)
  widgetBall.size = next
  // 不动最小尺寸：球窗口的最小边长固定为 BALL_WIN_MIN，缩放不会触发平台重排
  applyWidgetBounds({
    x: Math.round(cx - win / 2),
    y: Math.round(cy - win / 2),
    width: win,
    height: win,
  })
  rememberBallPosition()
  persistBall()
}

/**
 * 球的拖动：与边缘缩放同款做法 —— 渲染层只报告「正在拖」，主进程按屏幕光标位移重算
 * 位置。**不能**改用 `-webkit-app-region: drag`：那个会把球上的 click 一起吞掉，
 * 而球最主要的交互恰恰是「点一下展开浮窗」。
 */
function ballDragStart(): void {
  if (!widgetWindow || widgetWindow.isDestroyed() || widgetMode !== 'ball') return
  const [x, y] = widgetWindow.getPosition()
  widgetBallDrag = { startCursor: screen.getCursorScreenPoint(), start: { x, y } }
}

function ballDragTo(): void {
  const d = widgetBallDrag
  if (!d || !widgetWindow || widgetWindow.isDestroyed()) return
  const p = screen.getCursorScreenPoint()
  widgetWindow.setPosition(d.start.x + (p.x - d.startCursor.x), d.start.y + (p.y - d.startCursor.y))
}

/** 结束拖动：只有真拖动过才吸附（纯点击不该把球吸到边缘），随后写库。 */
function ballDragEnd(moved: boolean): void {
  widgetBallDrag = null
  if (!widgetWindow || widgetWindow.isDestroyed() || widgetMode !== 'ball') return
  if (moved) snapBallToNearestEdge()
  rememberBallPosition()
  persistBall()
}

/**
 * 展开：从球恢复上次的浮窗尺寸。
 * 展开方向是**球所在侧的反方向** —— 球在左半屏就向右展开，在右半屏就向左展开，
 * 这样球始终落在浮窗的外侧，不会被浮窗盖住。
 */
function expandWidget(): void {
  if (!widgetWindow || widgetWindow.isDestroyed() || widgetMode !== 'ball') return
  const ball = widgetWindow.getBounds()
  const wa = screen.getDisplayMatching(ball).workArea
  const width = Math.max(WIDGET_MIN[0], widgetBall.expandedWidth)
  const height = Math.max(WIDGET_MIN[1], widgetBall.expandedHeight)
  const goRight = ball.x + ball.width / 2 <= wa.x + wa.width / 2
  // 贴边阈值是 DOCK_EDGE：两侧各留 DOCK_RESTORE_INSET 的间隙，免得这次 setBounds
  // 触发的 `moved` 又把刚展开的浮窗收回去
  const rawX = goRight ? ball.x : ball.x + ball.width - width
  const x = Math.max(
    wa.x + DOCK_RESTORE_INSET,
    Math.min(rawX, wa.x + wa.width - width - DOCK_RESTORE_INSET)
  )
  const centerY = ball.y + Math.round(ball.height / 2)
  const y = Math.max(wa.y, Math.min(centerY - Math.round(height / 2), wa.y + wa.height - height))
  widgetMode = 'full'
  widgetWindow.setMinimumSize(WIDGET_MIN[0], WIDGET_MIN[1])
  sendWidgetMode()
  applyWidgetBounds({ x, y, width, height })
  // 展开后立即写库：此刻的几何就是用户最终看到的值
  saveWidgetGeometry(x, y, width, height)
  // 球的位置/边长留着（下次收球复用），但标记「当前不在球形态」，下次启动回到浮窗
  persistBall(false)
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
  // 提前 return 的分支很多，而「浮窗在不在」正是提醒该走气泡还是走主窗口那张卡片的判据，
  // 所以收尾统一放 finally —— 每个分支都漏不掉，也不必在每个 return 前补一遍。
  try {
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
      // 有欠着的提醒、且浮窗正停在球形态时，别把球藏了 —— 提醒就是从它旁边冒出来的，
      // 球一藏，气泡就成了「从空无一物的地方浮出来」。提醒处理完自然会被收回。
      if (activeReminders.length && widgetMode === 'ball') return
      widgetWindow.hide()
      return
    }
    widgetWindow.show()
    // 浮窗自身每 5s 轮询一次；主窗刚隐藏时立刻推一次，避免先看到过期列表
    widgetWindow.webContents.send('app:action', 'widget-refresh')
  } finally {
    // 有欠着的提醒时才值得重排，平时这一步是空转
    if (activeReminders.length) dispatchReminders()
  }
}

/**
 * 浮窗边缘缩放（S17，对齐 desktop_widget 的 _resize_hit/_apply_resize）：
 * 渲染层判定命中的边（'n'/'se'/'w' 等）后开始，主进程按屏幕光标位移重算尺寸。
 * 之所以放主进程算：光标可能移出窗口，渲染层拿不到完整位移。
 */
function widgetResizeStart(edges: string): void {
  // 球形态不参与边缘缩放：球上只有「拖动自己」和「缩放球体」
  if (!widgetWindow || widgetWindow.isDestroyed() || widgetMode === 'ball') return
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
  if (!widgetWindow || widgetWindow.isDestroyed() || widgetMode === 'ball') return
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

function sendAction(action: string, payload?: unknown): void {
  showMain()
  mainWindow?.webContents.send('app:action', action, payload ?? '')
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
  if (SELECTION_ACTIONS.has(action)) {
    const selected = await readSelectedText()
    // 独立窗口，且**不显示主窗口**：用户正按着热键在别的应用里选词
    openCaptureWindow(action === 'quick-capture' ? 'quick' : 'capture', selected)
    return
  }
  sendAction(action)
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
  { setting: 'flash_quick_hotkey', action: 'flash-quick' },
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
        else void dispatchHotkeyAction(action)
      })
    } catch (err) {
      console.error('[hotkey] 注册失败', accel, err)
      ok = false
    }
    // 文案要说清「这个组合用不了」：说成「已降级为托盘菜单」会让人以为热键还生效，
    // 于是改完键按下去没反应也不知道为什么（用户报的就是这个现象）
    hotkeyStatus[setting] = ok ? '✓ 已注册' : '✗ 未注册：组合已被别的程序占用'
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
      { label: '快速添加任务', click: () => void dispatchHotkeyAction('quick-capture') },
      { label: '新建笔记', click: () => sendAction('new-note') },
      { label: '记闪念', click: () => sendAction('flash-inbox') },
      { label: '划词捕获', click: () => void dispatchHotkeyAction('capture') },
      // 与热键同一条静默路径：不进捕获窗，直接入闪念
      { label: '选中入闪念', click: () => void dispatchHotkeyAction('flash-quick') },
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

/**
 * 独立弹窗的高度贴合：无边框窗口里多出来的空白很显眼，
 * 让渲染层量完卡片后回报，窗口高度跟着卡片走（宽度保持不变）。
 */
function registerWindowFit(): void {
  ipcMain.on('window:fitHeight', (e, height: number) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || win.isDestroyed()) return
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
  const anchor = widgetWindow && !widgetWindow.isDestroyed() ? widgetWindow.getBounds() : null
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
 * 刻意**不要求浮窗此刻可见** —— 主窗口在前台时浮窗是隐藏的（syncWidgetVisibility 的
 * 显隐联动），若把可见性也算进来，那种情况下提醒又会退回主窗口右上角那张卡片，
 * 「从悬浮表情出现」就等于没做。球不可见时气泡照样锚在它上次的位置上。
 */
function bubbleAvailable(): boolean {
  return !!widgetWindow && !widgetWindow.isDestroyed() && currentSettings().widget_enabled
}

function sendRemindersTo(win: BrowserWindow | null, rows: ReminderRow[]): void {
  if (!win || win.isDestroyed()) return
  win.webContents.send('reminder:push', rows)
}

/** 把这一批提醒交给该显示它的那个窗口，并同步悬浮球的表情。 */
function dispatchReminders(): void {
  const toBubble = bubbleAvailable()
  sendRemindersTo(reminderWindow, toBubble ? activeReminders : [])
  sendRemindersTo(mainWindow, toBubble ? [] : activeReminders)
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    // 有提醒时球切 notify 表情（由 WidgetBall 的节拍接管，见 widget:notice）
    widgetWindow.webContents.send('widget:notice', toBubble ? activeReminders.length : 0)
  }
  if (toBubble && activeReminders.length) {
    // 「从悬浮表情出现」：球可能正被主窗口的显隐联动藏着，提醒来了就让它露面。
    // 只唤球，不唤整块卡片 —— 卡片凭空弹出来太打扰。
    if (
      widgetMode === 'ball' &&
      widgetWindow &&
      !widgetWindow.isDestroyed() &&
      !widgetWindow.isVisible()
    ) {
      widgetWindow.show()
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
      // 确认已经交出去（webContents.send 是同步入队）之后才消费：一次性的前提是它真的弹出来了
      for (const t of rows) dismissReminder(t.id)
    } catch (err) {
      console.error('[reminder] 派发失败', err)
    }
  }, 30_000)
}

function registerReminderHandlers(): void {
  // 渲染层挂载时先拉一次：推送可能早于窗口加载完成
  ipcMain.handle('reminder:current', () => activeReminders)
  ipcMain.handle('reminder:dismiss', (_e, id: number) => {
    activeReminders = activeReminders.filter((t) => t.id !== id)
    dispatchReminders()
    return activeReminders
  })
  ipcMain.handle('reminder:snooze', (_e, id: number, minutes: number) => {
    snoozeReminder(Number(id), Number(minutes))
    activeReminders = activeReminders.filter((t) => t.id !== id)
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
    mainWindow?.webContents.send('reminder:openTask', Number(id))
  })
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
    (_e, noteId: number, files: { fileName: string; base64: string }[]) =>
      importAttachmentDataBatch(
        Number(noteId),
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
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:action', 'notice', String(message ?? ''))
    }
  })
}

/** 正在等待应答的人工确认（工作流条件节点）：一次只开一个窗口 */
let conditionAsk: { id: string; resolve: (ok: boolean) => void } | null = null
let conditionAskSeq = 0
let conditionWindow: BrowserWindow | null = null
/** 当前窗口的「可以显示了」回调（渲染层应用完主题后调用） */
let conditionShowOnce: (() => void) | null = null
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
    win.webContents.once('did-finish-load', () => {
      if (win.isDestroyed()) return
      win.webContents.send('condition:confirm', { id, prompt })
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
  ipcMain.on('condition:ready', () => conditionShowOnce?.())
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

app.whenReady().then(() => {
  app.setName('知行 ZhiXing')
  buildMenu()
  registerDbHandlers()
  registerAiHandlers()
  registerConditionAsk()
  registerTaskSyncHandlers()
  registerCaptureWindow()
  registerShellHandlers()
  registerAttachmentHandlers()
  registerWindowFit()
  startReminderDispatch()
  registerReminderHandlers()
  scheduleTaskSync()
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
  })
  // 浮窗随应用启动创建，但**不显示**（对齐 app_controller.startup 末尾的 self.widget.hide()）：
  // 启动只露主窗，之后由主窗显隐联动浮窗。
  if (currentSettings().widget_enabled) createWidgetWindow()
  // 提醒气泡窗口与浮窗同理：启动就创建，但不显示（首次派发时才露面）。
  // 必须常驻 —— 等有提醒才建的话，reminder:push 会落在窗口加载完成之前，那一条就丢了。
  createReminderWindow()

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
    } catch {
      return false
    }
  })

  // 浮窗边缘缩放（S17）：渲染层命中边缘后开始/推进/结束
  ipcMain.handle('widget:resizeStart', (_e, edges: string) => widgetResizeStart(edges))
  ipcMain.handle('widget:resizeTo', () => widgetResizeTo())
  ipcMain.handle('widget:resizeEnd', () => widgetResizeEnd())

  ipcMain.handle('widget:toggle', () => {
    toggleWidget()
    return widgetWindow?.isVisible() ?? false
  })
  // 浮窗上的「隐藏」= 收起成悬浮球（球留在桌面上，点它随时展开回来）
  ipcMain.handle('widget:close', () => collapseWidgetToBall())
  ipcMain.handle('widget:setOpacity', (_e, value: number) => applyWidgetOpacity(value))
  ipcMain.handle('widget:setClickThrough', (_e, enabled: boolean) => applyWidgetClickThrough(enabled))
  ipcMain.handle('widget:undock', () => expandWidget())
  /** 浮窗当前形态：'ball' 悬浮球 / 'full' 完整卡片（渲染层挂载时先问一次） */
  ipcMain.handle('widget:mode', () => widgetMode)
  ipcMain.handle('widget:ballShape', () => widgetBall.shape)
  // 与右键菜单同一个入口：应用内也能改体型（也让端到端验证不必去点原生菜单）
  ipcMain.handle('widget:setBallShape', (_e, id: string) => setBallShape(String(id)))
  // 悬浮球拖动：渲染层只报告「正在拖」，位移由主进程按屏幕光标重算（光标可能移出窗口）
  ipcMain.handle('widget:dragStart', () => ballDragStart())
  ipcMain.handle('widget:dragTo', () => ballDragTo())
  ipcMain.handle('widget:dragEnd', (_e, moved: boolean) => ballDragEnd(moved === true))
  // 悬浮球大小（滚轮 / 右键菜单），主进程钳在 BALL_SIZE_MIN~MAX
  ipcMain.handle('widget:setBallSize', (_e, size: number) => setBallSize(Number(size)))
  // 浮窗右键菜单（对齐 desktop_widget 的右键项：今日视图 / 贴边 / 隐藏浮窗）
  ipcMain.handle('widget:contextMenu', () => {
    if (!widgetWindow) return
    const items: MenuItemConstructorOptions[] = [{ label: '今日视图', click: () => showMain() }]
    if (widgetMode === 'ball') {
      items.push({ label: '展开浮窗', click: () => expandWidget() })
      items.push({
        label: '悬浮球大小',
        submenu: [
          {
            label: '小（88）',
            type: 'radio',
            checked: widgetBall.size <= 96,
            click: () => setBallSize(BALL_SIZE_MIN),
          },
          {
            label: '中（112）',
            type: 'radio',
            checked: widgetBall.size > 96 && widgetBall.size <= 128,
            click: () => setBallSize(112),
          },
          {
            label: '大（144）',
            type: 'radio',
            checked: widgetBall.size > 128,
            click: () => setBallSize(144),
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
          checked: widgetBall.shape === s.id,
          click: () => setBallShape(s.id),
        })),
      })
    } else {
      items.push({ label: '贴边停靠', click: () => collapseWidgetToBall() })
    }
    items.push({ type: 'separator' })
    items.push({ label: '隐藏浮窗', click: () => widgetWindow?.hide() })
    Menu.buildFromTemplate(items).popup({ window: widgetWindow })
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
