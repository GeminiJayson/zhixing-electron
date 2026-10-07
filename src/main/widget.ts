import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { BLOUB_DEFAULT_SHAPE, normalizeBloubShape } from '../shared/bloub'
import type { PomodoroTick } from '../shared/types'
import { hardenWindow } from './security'
import { saveWidgetBall, saveWidgetGeometry } from './db/maintenance'
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

/** 外部注入的依赖 —— 直接 import 会成环（这些函数在 index.ts 里定义、又反过来用 widget） */
export interface WidgetDeps {
  isDev: boolean
  /** 主窗是否已经过 splash 阶段正式显示 —— 未显示时不弹浮窗 */
  isMainReady: () => boolean
  /** 主窗引用（判断它是否可见/聚焦） */
  getMainWindow: () => { isDestroyed: () => boolean; isVisible: () => boolean; isFocused: () => boolean; isMinimized: () => boolean } | null
  followWidgetSoon: () => void
  /** 未处理的提醒（浮窗上的角标要用） */
  getActiveReminders: () => unknown[]
  /** 提醒变化后通知两个窗口 */
  dispatchReminders: () => void
  showMain: () => void
  sendAction: (action: string, payload?: unknown) => void
  dispatchHotkeyAction: (action: string) => Promise<void>
  currentSettings: () => { ui_state?: string | null; widget_enabled?: boolean }
}

/**
 * 悬浮球与浮窗。
 *
 * 从 main/index.ts 抽出来（那个文件 2445 行，这一组就占 480 行）。
 *
 * **不做成模块级函数**：这一组共享 6 份可变状态（窗口、模式、球几何、拖动、缩放、
 * 手动展开标记），而主进程别处也要读它们（托盘菜单、热键、窗口创建要判断球形态）。
 * 用工厂返回闭包内的访问器，状态既不外泄、也不用把 159 处引用改成 "某个全局对象.x" ——
 * 后者试过，批量替换会把「let widgetWindow: T = null」这种**声明**也改坏。
 */
/*
  返回类型不显式写：它有二十多项，手写一遍等于把 return 里的清单维护两遍 ——
  上一版就是这么漏掉 collapseWidgetToBall 等十几项的。让 TS 从 return 推断，
  调用方拿到的类型一样精确（错的属性名照样报错）。
*/
export function createWidgetModule(deps: WidgetDeps) {
  const {
    isDev,
    followWidgetSoon,
    getActiveReminders,
    dispatchReminders,
    isMainReady,
    getMainWindow,
    showMain,
    sendAction,
    dispatchHotkeyAction,
    currentSettings,
  } = deps

  /** 本模块的可变状态。放在闭包里，外部只能通过下面返回的访问器读。 */
  const S = {
    window: null as BrowserWindow | null,
    mode: 'full' as 'full' | 'ball',
    ball: {
      x: 0,
      y: 0,
      size: 96,
      /** 悬浮球的体型（bloub 的形状 id，见 shared/bloub） */
      shape: BLOUB_DEFAULT_SHAPE,
      expandedWidth: 290,
      expandedHeight: 380,
    },
    drag: null as {
      startCursor: { x: number; y: number }
      start: { x: number; y: number }
    } | null,
    resize: null as {
      edges: string
      startCursor: { x: number; y: number }
      start: { x: number; y: number; width: number; height: number }
    } | null,
    manualOpen: false,
  }
  // ---- 从 index.ts 一并搬来的：widget 自己的常量与几何持久化 ----
  const WIDGET_RESIZE_MARGIN = 6
  const DOCK_RESTORE_INSET = 12
  const WIDGET_SIZE: [number, number] = [290, 380]
  const WIDGET_MIN: [number, number] = [200, 160]

  /** 读取浮窗上次的位置与尺寸（ui_state.widget_geometry）。 */
  function readWidgetGeometry(): { x?: number; y?: number; width: number; height: number } {
    const s = currentSettings()
    let width = WIDGET_SIZE[0]
    let height = WIDGET_SIZE[1]
    try {
      const state = JSON.parse(s.ui_state ?? '') as { widget_geometry?: unknown }
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
      const state = JSON.parse(currentSettings().ui_state ?? '') as { widget_ball?: Record<string, unknown> }
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
  if (S.window) {
    S.window.show()
    S.window.focus()
    return
  }
  const geo = readWidgetGeometry()
  const s = currentSettings()

  S.window = new BrowserWindow({
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
    // setBallSize 完全失效）。卡片形态的边缘缩放另有自实现（S.resizeStart/To/End）。
    resizable: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  hardenWindow(S.window)
  // 刻意**不用** setOpacity：在 Windows 上它给窗口设的是全局 alpha（layered window），
  // 会顶掉透明窗口的逐像素透明 —— 悬浮球四周本该透明的那块矩形会变成一层底色
  // （亮色 / 暗色主题都一样）。透明度改由渲染层的 CSS opacity 画，见 applyWidgetOpacity。
  // 高于普通窗口，但不抢系统级焦点
  S.window.setAlwaysOnTop(true, 'floating')
  S.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  // 几何写库：拖拽/缩放过程中 moved/resized 会连续触发，去抖到停手后只写一次。
  // 球形态的几何写进 widget_ball，绝不覆盖 widget_geometry —— 展开时还要靠后者还原。
  let persistTimer: NodeJS.Timeout | null = null
  const persistNow = (): void => {
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    if (!S.window || S.window.isDestroyed() || S.mode === 'ball') return
    const [x, y] = S.window.getPosition()
    const [w, h] = S.window.getSize()
    saveWidgetGeometry(x, y, w, h)
  }
  const persistSoon = (): void => {
    if (S.mode === 'ball') return
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
  S.window.on('moved', () => {
    // 提醒气泡锚在浮窗旁边，浮窗一动它就得跟着（内含去抖）
    followWidgetSoon()
    // 球形态：窗口本身就是球，拖动只更新球位置（停手后再吸附 + 写库）
    if (S.mode === 'ball') {
      rememberBallPosition()
      persistBallSoon()
      return
    }
    // 卡片形态：拖到屏幕边缘就收成球，否则按老规矩去抖写浮窗几何
    if (maybeDockWidget()) return
    persistSoon()
  })
  S.window.on('resized', () => {
    followWidgetSoon()
    if (S.mode === 'ball') persistBallSoon()
    else persistSoon()
  })
  S.window.on('ready-to-show', () => {
    // 上次退出时就是球 → 直接按保存的位置与大小以球露面
    const restored = readWidgetBall()
    if (restored.active) restoreBall(restored)
    // 否则：上次停在屏幕边缘的浮窗几何 → 第一次露面就收成球，别把整卡片挤进小窗口
    else maybeDockWidget()
    // 启动阶段只创建不显示：
    // 主窗显示→隐藏浮窗、主窗隐藏→显示浮窗，统一由 syncWidgetVisibility 裁决。
    syncWidgetVisibility()
  })
  S.window.on('hide', () => {
    if (S.mode === 'ball') persistBall()
    else persistNow()
  })
  S.window.on('closed', () => {
    if (S.mode === 'ball') persistBall()
    else persistNow()
    S.resize = null
    S.drag = null
    S.window = null
  })

  if (isDev) {
    void S.window.loadURL(`${process.env.ELECTRON_RENDERER_URL}?widget=1`)
  } else {
    void S.window.loadFile(join(__dirname, '../renderer/index.html'), { query: { widget: '1' } })
  }
}

/**
 * 通知渲染层切换形态：'ball' 画悬浮球，'full' 画完整卡片。
 * 渲染层挂载时也会主动问一次（`widget:mode`），这条推送负责后续切换。
 */
function sendWidgetMode(): void {
  if (!S.window || S.window.isDestroyed()) return
  S.window.webContents.send('widget:mode', S.mode)
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
  if (!S.window || S.window.isDestroyed()) return
  /** 只改位置、不改尺寸 —— 改尺寸会再触发一次重排，等于白改 */
  const setPos = (): void => {
    if (!S.window || S.window.isDestroyed()) return
    S.window.setPosition(bounds.x, bounds.y)
  }
  // 第一步落地：隐藏窗口阶段只有 setBounds 能把位置一起带过去（setPosition 落不下去）
  S.window.setBounds(bounds)
  // 第二步纠偏：可见窗口的尺寸重排是异步的，会按「保持左上角」把位置拉回原处，
  // 等它发生之后再纠正位置。setImmediate 覆盖同帧重排，setTimeout 兜底更晚的重排。
  setImmediate(setPos)
  setTimeout(setPos, 120)
}

/** 从窗口当前位置刷新内存里的球坐标（拖动过程中会连续调用）。 */
function rememberBallPosition(): void {
  if (!S.window || S.window.isDestroyed() || S.mode !== 'ball') return
  const [x, y] = S.window.getPosition()
  S.ball.x = x
  S.ball.y = y
}

/** 球状态写库：位置 / 边长 / 体型 / 上次展开尺寸 / 当前是否就是球形态。 */
function persistBall(active = true): void {
  saveWidgetBall({
    x: Math.round(S.ball.x),
    y: Math.round(S.ball.y),
    size: clampBallSize(S.ball.size),
    shape: S.ball.shape,
    active,
    expandedWidth: Math.round(S.ball.expandedWidth),
    expandedHeight: Math.round(S.ball.expandedHeight),
  })
}

/**
 * 换悬浮球体型：改内存 + 落库 + 推给浮窗重画。
 * 不重建窗口、也不动几何 —— 换的是渲染参数，不是布局。
 */
function setBallShape(id: string): void {
  const shape = normalizeBloubShape(id)
  if (S.ball.shape === shape) return
  S.ball.shape = shape
  persistBall(S.mode === 'ball')
  S.window?.webContents.send('widget:ballShape', shape)
}

/** 按保存的球几何以球形态露面（位置越界时钳回对应显示器的工作区）。 */
function restoreBall(saved: ReturnType<typeof readWidgetBall>): void {
  if (!S.window || S.window.isDestroyed()) return
  const win = ballWindowPx(saved.size)
  S.ball.size = saved.size
  S.ball.shape = saved.shape
  S.ball.expandedWidth = saved.expandedWidth
  S.ball.expandedHeight = saved.expandedHeight
  const wa = screen.getDisplayMatching({
    x: saved.x ?? 0,
    y: saved.y ?? 0,
    width: win,
    height: win,
  }).workArea
  const x = saved.x === null ? wa.x : Math.max(wa.x, Math.min(saved.x, wa.x + wa.width - win))
  const y =
    saved.y === null ? wa.y + 120 : Math.max(wa.y, Math.min(saved.y, wa.y + wa.height - win))
  S.ball.x = x
  S.ball.y = y
  S.mode = 'ball'
  S.window.setMinimumSize(BALL_WIN_MIN, BALL_WIN_MIN)
  sendWidgetMode()
  applyWidgetBounds({ x, y, width: win, height: win })
}

/**
 * 收起成球（「隐藏」按钮 / 拖到屏幕边缘 / 右键「贴边停靠」）。
 * 记住当前浮窗尺寸以便展开还原；不指定侧时贴最近的一侧，竖直对齐浮窗中心。
 */
function collapseWidgetToBall(side?: 'left' | 'right'): void {
  if (!S.window || S.window.isDestroyed() || S.mode === 'ball') return
  const b = S.window.getBounds()
  const wa = screen.getDisplayMatching(b).workArea
  S.ball.expandedWidth = Math.max(WIDGET_MIN[0], b.width)
  S.ball.expandedHeight = Math.max(WIDGET_MIN[1], b.height)
  const win = ballWindowPx(S.ball.size)
  const target = side ?? (b.x + b.width / 2 <= wa.x + wa.width / 2 ? 'left' : 'right')
  const x = target === 'left' ? wa.x : wa.x + wa.width - win
  const centerY = b.y + Math.round(b.height / 2)
  const y = Math.max(wa.y, Math.min(centerY - Math.round(win / 2), wa.y + wa.height - win))
  S.ball.x = x
  S.ball.y = y
  S.mode = 'ball'
  // 最小尺寸会把 setBounds 钳回去，收球前必须先放开
  S.window.setMinimumSize(BALL_WIN_MIN, BALL_WIN_MIN)
  sendWidgetMode()
  applyWidgetBounds({ x, y, width: win, height: win })
  persistBall()
  // 「隐藏」按钮走的就是这条路：球必须露出来，否则用户再也找不回浮窗
  S.window.show()
}

/**
 * 浮窗贴边：贴近屏幕左右边缘时收成悬浮球。
 * 返回是否真的收成了球 —— 调用方据此决定要不要再写浮窗几何。
 */
function maybeDockWidget(): boolean {
  if (!S.window || S.window.isDestroyed() || S.mode === 'ball') return false
  const b = S.window.getBounds()
  const wa = screen.getDisplayMatching(b).workArea
  const nearLeft = b.x - wa.x <= DOCK_EDGE
  const nearRight = wa.x + wa.width - (b.x + b.width) <= DOCK_EDGE
  if (!nearLeft && !nearRight) return false
  collapseWidgetToBall(nearLeft ? 'left' : 'right')
  return true
}

/** 球松手后吸附：水平贴进边缘就吸平，竖直只钳进工作区（球可以停在任意高度）。 */
function snapBallToNearestEdge(): void {
  if (!S.window || S.window.isDestroyed() || S.mode !== 'ball') return
  const b = S.window.getBounds()
  const wa = screen.getDisplayMatching(b).workArea
  let x = b.x
  if (b.x - wa.x <= DOCK_EDGE) x = wa.x
  else if (wa.x + wa.width - (b.x + b.width) <= DOCK_EDGE) x = wa.x + wa.width - b.width
  const y = Math.max(wa.y, Math.min(b.y, wa.y + wa.height - b.height))
  if (x !== b.x || y !== b.y) S.window.setBounds({ x, y, width: b.width, height: b.height })
}

/** 改球的大小（滚轮 / 右键菜单）：以球心为锚点缩放，窗口跟着一起变。 */
function setBallSize(size: number): void {
  if (!S.window || S.window.isDestroyed() || S.mode !== 'ball') return
  const next = clampBallSize(size)
  if (next === S.ball.size) return
  const b = S.window.getBounds()
  const cx = b.x + b.width / 2
  const cy = b.y + b.height / 2
  const win = ballWindowPx(next)
  S.ball.size = next
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
  if (!S.window || S.window.isDestroyed() || S.mode !== 'ball') return
  const [x, y] = S.window.getPosition()
  S.drag = { startCursor: screen.getCursorScreenPoint(), start: { x, y } }
}

function ballDragTo(): void {
  const d = S.drag
  if (!d || !S.window || S.window.isDestroyed()) return
  const p = screen.getCursorScreenPoint()
  S.window.setPosition(d.start.x + (p.x - d.startCursor.x), d.start.y + (p.y - d.startCursor.y))
}

/** 结束拖动：只有真拖动过才吸附（纯点击不该把球吸到边缘），随后写库。 */
function ballDragEnd(moved: boolean): void {
  S.drag = null
  if (!S.window || S.window.isDestroyed() || S.mode !== 'ball') return
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
  if (!S.window || S.window.isDestroyed() || S.mode !== 'ball') return
  const ball = S.window.getBounds()
  const wa = screen.getDisplayMatching(ball).workArea
  const width = Math.max(WIDGET_MIN[0], S.ball.expandedWidth)
  const height = Math.max(WIDGET_MIN[1], S.ball.expandedHeight)
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
  S.mode = 'full'
  S.window.setMinimumSize(WIDGET_MIN[0], WIDGET_MIN[1])
  sendWidgetMode()
  applyWidgetBounds({ x, y, width, height })
  // 展开后立即写库：此刻的几何就是用户最终看到的值
  saveWidgetGeometry(x, y, width, height)
  // 球的位置/边长留着（下次收球复用），但标记「当前不在球形态」，下次启动回到浮窗
  persistBall(false)
}

/** 用户显式切过浮窗：该状态下不被主窗显隐联动覆盖，直到主窗再次显隐。 */

function toggleWidget(): void {
  if (S.window && S.window.isVisible()) {
    S.manualOpen = false
    S.window.hide()
    return
  }
  S.manualOpen = true
  if (!S.window) createWidgetWindow()
  S.window?.show()
  S.window?.webContents.send('app:action', 'widget-refresh')
}

/**
 * 主窗显隐 → 浮窗显隐联动：
 * 主窗显示时隐藏浮窗，主窗隐藏（关闭到浮窗/最小化）时显示浮窗并刷新今日待办。
 */
function syncWidgetVisibility(): void {
  // 提前 return 的分支很多，而「浮窗在不在」正是提醒该走气泡还是走主窗口那张卡片的判据，
  // 所以收尾统一放 finally —— 每个分支都漏不掉，也不必在每个 return 前补一遍。
  try {
    if (!S.window || S.window.isDestroyed()) return
    // splash 阶段主窗还没露面，此时不该弹浮窗
    if (!isMainReady()) {
      S.window.hide()
      return
    }
    if (!currentSettings().widget_enabled) {
      S.window.hide()
      return
    }
    if (S.manualOpen) return
    const mw = getMainWindow()
    const mainVisible =
      !!mw && !mw.isDestroyed() && mw.isVisible() && mw.isFocused() && !mw.isMinimized()
    if (mainVisible) {
      // 有欠着的提醒、且浮窗正停在球形态时，别把球藏了 —— 提醒就是从它旁边冒出来的，
      // 球一藏，气泡就成了「从空无一物的地方浮出来」。提醒处理完自然会被收回。
      if (getActiveReminders().length && S.mode === 'ball') return
      S.window.hide()
      return
    }
    S.window.show()
    // 浮窗自身每 5s 轮询一次；主窗刚隐藏时立刻推一次，避免先看到过期列表
    S.window.webContents.send('app:action', 'widget-refresh')
  } finally {
    // 有欠着的提醒时才值得重排，平时这一步是空转
    if (getActiveReminders().length) dispatchReminders()
  }
}

/**
 * 浮窗边缘缩放：
 * 渲染层判定命中的边（'n'/'se'/'w' 等）后开始，主进程按屏幕光标位移重算尺寸。
 * 之所以放主进程算：光标可能移出窗口，渲染层拿不到完整位移。
 */
function widgetResizeStart(edges: string): void {
  // 球形态不参与边缘缩放：球上只有「拖动自己」和「缩放球体」
  if (!S.window || S.window.isDestroyed() || S.mode === 'ball') return
  const b = S.window.getBounds()
  S.resize = {
    edges: String(edges ?? ''),
    startCursor: screen.getCursorScreenPoint(),
    start: { x: b.x, y: b.y, width: b.width, height: b.height },
  }
}

function widgetResizeTo(): void {
  const rs = S.resize
  if (!rs || !S.window || S.window.isDestroyed()) return
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
  S.window.setBounds({ x, y, width, height })
}

/** 结束缩放：清状态并写一次几何。 */
function widgetResizeEnd(): void {
  if (!S.resize) return
  S.resize = null
  if (!S.window || S.window.isDestroyed() || S.mode === 'ball') return
  const [x, y] = S.window.getPosition()
  const [w, h] = S.window.getSize()
  saveWidgetGeometry(x, y, w, h)
}

/**
 * 浮窗透明度：只把百分比推给渲染层，由它写成 CSS opacity 画出来。
 *
 * 窗口自己的 setOpacity 在 Windows 上会破坏透明窗口的逐像素透明（见 createWidgetWindow
 * 里的注释），这里只传值；渲染层挂载时还会主动问一次（widget:opacityGet），
 * 免得推送早于它挂载。
 */
function applyWidgetOpacity(value: number): void {
  const pct = Math.max(30, Math.min(100, Math.round(Number(value) || 100)))
  if (S.window && !S.window.isDestroyed()) {
    S.window.webContents.send('widget:opacity', pct)
  }
}

/**
 * 把番茄钟的倒计时状态转给浮窗。
 *
 * 番茄钟收起后用户看不见它了，倒计时就落在悬浮表情（球）或浮窗标题行上 ——
 * 计时宿主仍是那个小窗，这里只做转发；传 null 表示"没有正在跑的番茄钟"，浮窗据此收起显示。
 */
function sendPomodoro(state: PomodoroTick | null): void {
  if (S.window && !S.window.isDestroyed()) S.window.webContents.send('widget:pomodoro', state)
}

/** 鼠标穿透：开启后浮窗不挡操作，改用热键/托盘隐藏。 */
function applyWidgetClickThrough(enabled: boolean): void {
  S.window?.setIgnoreMouseEvents(enabled, { forward: true })
}
/** 冷启动时收到的深链：等渲染进程就绪后再派发 */

  /*
    这里列出**要被主进程别处调用**的那些。工具函数（readWidgetGeometry / readWidgetBall /
    persistBall / restoreBall / rememberBallPosition / snapBallToNearestEdge）是内部的，
    不外传 —— 上一版把这份清单写短了（只列 6 项），结果调用方报了一串
    "Property 'collapseWidgetToBall' does not exist"。
  */
  return {
    // 窗口与形态
    createWidgetWindow,
    toggleWidget,
    syncWidgetVisibility,
    expandWidget,
    collapseWidgetToBall,
    maybeDockWidget,
    sendWidgetMode,
    applyWidgetBounds,
    // 球体交互
    ballDragStart,
    ballDragTo,
    ballDragEnd,
    setBallSize,
    setBallShape,
    // 边缘缩放
    widgetResizeStart,
    widgetResizeTo,
    widgetResizeEnd,
    // 外观
    applyWidgetOpacity,
    applyWidgetClickThrough,
    // 番茄钟倒计时转发（收起后显示在球 / 标题行上）
    sendPomodoro,
    // 只读访问器
    /** 'full' | 'ball' —— 渲染层与托盘都要用它决定显示形态 */
    getMode: () => S.mode,
    /** 球体几何（位置 + 边长 + 体型） */
    getBall: () => S.ball,
    /** 球体体型 id（bloub 的形状） */
    getBallShape: () => S.ball.shape,
    show: () => {
      if (S.window && !S.window.isDestroyed()) S.window.show()
    },
    getWindow: () => S.window,
    isBall: () => S.mode === 'ball',
    isManualOpen: () => S.manualOpen,
    setManualOpen: (v: boolean) => {
      S.manualOpen = v
    },
  }
}
