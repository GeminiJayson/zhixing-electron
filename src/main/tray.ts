import { BrowserWindow, Menu, Tray, app, nativeImage } from 'electron'
import type { TodayTasks } from '../shared/types'
import { join } from 'node:path'
import { nearestAccent } from './accent'

/** 外部注入 —— 这些函数定义在 index.ts 里、又反过来要用托盘，直接 import 会成环 */
export interface TrayDeps {
  currentSettings: () => { accent_color?: string | null }
  listTodayTasks: () => TodayTasks
  showMain: () => void
  sendAction: (action: string, payload?: unknown) => void
  dispatchHotkeyAction: (action: string) => Promise<void>
  toggleWidget: () => void
  getMainWindow: () => BrowserWindow | null
}

/**
 * 系统托盘：图标（跟随强调色）、tooltip（今日待办数）、右键菜单。
 *
 * 从 main/index.ts 抽出来。做法与 widget.ts 一致：状态进闭包、跨组调用走注入。
 *
 * 段内替换用带引号断言的规则 —— 段里有 themeIconPath('tray') 这样的字符串，
 * 而 widget 那一组正是栽在「字符串字面量被当成标识符改了」上（IPC 通道名失联）。
 */
export function createTrayModule(deps: TrayDeps) {
  const { currentSettings, listTodayTasks, showMain, sendAction, dispatchHotkeyAction, toggleWidget } = deps

  const S = {
    tray: null as Tray | null,
    accentKey: '',
  }

  /**
   * 托盘提示显示今日待办数。
   * 此前 tooltip 是固定文案，少了一处「不打开应用也能看到今天还剩多少」的提醒。
   */
  function updateTrayTooltip(): void {
    if (!S.tray || S.tray.isDestroyed()) return
    try {
      const n = listTodayTasks().roots.length
      S.tray.setToolTip(`知行 ZhiXing · 今天待办 ${n}`)
    } catch {
      S.tray.setToolTip('知行 ZhiXing')
    }
  }

  /** 当前强调色对应的图标 key（文件名里的小写 6 位 hex） */
  function accentIconKey(): string {
    try {
      return nearestAccent(currentSettings().accent_color || '#0D9488').replace('#', '').toLowerCase()
    } catch {
      return '0d9488'
    }
  }

  /** 主题图标路径；文件缺失时由调用方退回打包图标，绝不让图标空掉 */
  function themeIconPath(kind: 'app' | 'tray'): string {
    return join(__dirname, '../../resources/theme-icons/' + kind + '-' + accentIconKey() + '.png')
  }

  /**
   * 托盘图标：直接读当前强调色对应的那份 PNG（构建期烘好，见上面 PRESET_ACCENTS 的注释）。
   * 任何一步失败都要退回**打包图标**——绝不出现「托盘图标消失」这种更糟的回退。
   */
  function buildTrayImage(): Electron.NativeImage {
    // macOS 仍然用模板图：菜单栏会按明暗自动反色，彩色图标在菜单栏里反而是异类
    if (process.platform === 'darwin') {
      const base = nativeImage.createFromPath(join(__dirname, '../../resources/trayTemplate.png'))
      if (!base.isEmpty()) base.setTemplateImage(true)
      return base
    }
    const img = nativeImage.createFromPath(themeIconPath('tray'))
    if (!img.isEmpty()) return img
    return nativeImage.createFromPath(join(__dirname, '../../resources/icon-256.png'))
  }

  /**
   * 强调色变化后重建图标：**窗口图标与托盘图标一起换**。
   *
   * 原本这里只换托盘（按主题包的 fg2 单色重着色）；现在两者都跟随强调色 ——
   * 窗口图标决定任务栏上显示什么，用户换强调色时它也该跟着变。
   */
  function refreshTrayIcon(): void {
    const key = accentIconKey()
    if (key === S.accentKey) return
    S.accentKey = key
    const mw = deps.getMainWindow()
    if (mw && !mw.isDestroyed()) {
      const appIcon = nativeImage.createFromPath(themeIconPath('app'))
      if (!appIcon.isEmpty()) mw.setIcon(appIcon)
    }
    if (!S.tray || S.tray.isDestroyed()) return
    const img = buildTrayImage()
    if (!img.isEmpty()) S.tray.setImage(img)
  }


  /**
   * 系统托盘菜单：动作集为
   * quick-capture / new-note / flash-inbox / capture / select-quick / widget。
   */
  function createTray(): void {
    const image = buildTrayImage()
    if (image.isEmpty()) return
    S.accentKey = accentIconKey()
    S.tray = new Tray(image)
    updateTrayTooltip()
    S.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示主窗口', click: () => deps.showMain() },
        { label: '快速添加任务', click: () => void deps.dispatchHotkeyAction('quick-capture') },
        { label: '新建笔记', click: () => deps.sendAction('new-note') },
        { label: '记闪念', click: () => deps.sendAction('flash-inbox') },
        { label: '快速笔记', click: () => void deps.dispatchHotkeyAction('quick-note') },
        { label: '划词捕获', click: () => void deps.dispatchHotkeyAction('capture') },
        // 与热键同一条静默路径：不进捕获窗，直接入闪念
        { label: '选中入闪念', click: () => void deps.dispatchHotkeyAction('flash-quick') },
        { label: '读取选中并速记', click: () => deps.sendAction('select-quick') },
        { label: '显示/隐藏浮窗', click: () => deps.toggleWidget() },
        { type: 'separator' },
        {
          label: '退出',
          click: () => {
            app.quit()
          },
        },
      ])
    )
    S.tray.on('click', () => deps.showMain())
  }
  return {
    createTray,
    refreshTrayIcon,
    updateTrayTooltip,
    getTray: () => S.tray,
    /**
     * 主题图标的路径。窗口图标（任务栏）要用它 —— 与托盘图标同一套烘好的 PNG，
     * 换强调色时两者一起变（refreshTrayIcon 里同时 setIcon 与 setImage）。
     */
    appIconPath: (kind: 'app' | 'tray') => themeIconPath(kind),
  }
}
