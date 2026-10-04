import { app, globalShortcut } from 'electron'
import { broadcastDataChanged } from './db'
import { toAccelerator } from '../shared/deep-link'

/** 外部注入 —— 这些函数定义在 index.ts 里、又反过来要用热键，直接 import 会成环 */
export interface HotkeyDeps {
  currentSettings: () => { hotkeys?: Record<string, string>; autostart_enabled?: boolean }
  addFlash: (content: string, remark?: string, sourceApp?: string) => unknown
  readSelectedText: () => Promise<{ text: string; html: string }>
  sendAction: (action: string, payload?: unknown) => void
  toggleWidget: () => void
  openQuickNoteWindow: () => void
  openCaptureWindow: (mode: 'quick' | 'capture', seed: { text: string; html: string }) => void
}

/**
 * 全局热键：注册、注销、动作派发。
 *
 * 从 main/index.ts 抽出来（88 行）。做法与 widget.ts / tray.ts 一致：
 * 跨组调用走注入。这里没有可变状态，所以不需要闭包 —— 工厂只是把 deps 收进来。
 */
export function createHotkeyModule(deps: HotkeyDeps) {
  const {
    currentSettings,
    addFlash,
    readSelectedText,
    sendAction,
    toggleWidget,
    openQuickNoteWindow,
    openCaptureWindow,
  } = deps



  /**
   * 热键动作分发。读选区的三个动作必须**先取文本、再显示窗口** ——
   * showMain 会把焦点抢过来，之后模拟复制就只剩自己的界面可复制了。
   */
  async function dispatchHotkeyAction(action: string): Promise<void> {
    // 划词直接入闪念：读完选区**不打开任何窗口**，直接落库。
    // 它和下面三个「读选区 + 开捕获窗」的动作不同，是按下即完成的静默路径，
    // 所以必须在 openCaptureWindow 那条分支之前单独处理掉。
    if (action === 'flash-quick') {
      const selected = await deps.readSelectedText()
      const text = selected.text.trim()
      // 没选中任何文字就当没按过：写一条空闪念只会变成垃圾数据
      if (!text) return
      deps.addFlash(text)
      broadcastDataChanged('flash')
      return
    }
    if (action === 'quick-note') {
      // 快速笔记浮窗：独立窗口、不显示主窗口 —— 用户是按热键唤出来随手记的
      openQuickNoteWindow()
      return
    }
    if (SELECTION_ACTIONS.has(action)) {
      const selected = await deps.readSelectedText()
      // 独立窗口，且**不显示主窗口**：用户正按着热键在别的应用里选词
      openCaptureWindow(action === 'quick-capture' ? 'quick' : 'capture', selected)
      return
    }
    deps.sendAction(action)
  }

  /**
   * 热键注册状态：settings 键 → 中文状态串，
   * 设置页据此显示「已注册 / 冲突降级」。
   */
  const hotkeyStatus: Record<string, string> = {}

  /** 热键设置键 → 动作名。 */
  const HOTKEY_BINDINGS: { setting: string; action: string }[] = [
    { setting: 'capture_hotkey', action: 'capture' },
    { setting: 'select_quick_hotkey', action: 'select-quick' },
    { setting: 'quick_capture_hotkey', action: 'quick-capture' },
    { setting: 'flash_quick_hotkey', action: 'flash-quick' },
    { setting: 'quick_note_hotkey', action: 'quick-note' },
    { setting: 'widget_hotkey', action: 'toggle-widget' },
  ]

  /**
   * 全局热键：键名从 settings 表读，
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
          if (action === 'toggle-widget') deps.toggleWidget()
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
    // 开机自启
    try {
      app.setLoginItemSettings({ openAtLogin: s.autostart_enabled })
    } catch (err) {
      console.error('[autostart] 设置失败', err)
    }
    return { ...hotkeyStatus }
  }
  /** 这些动作要读选中文字（走剪贴板 + 模拟 Ctrl+C） */
  const SELECTION_ACTIONS = new Set(['capture', 'select-quick', 'quick-capture', 'flash-quick'])

  return {
    dispatchHotkeyAction,
    registerHotkeys,
    /** 注册状态（settings 键 → 中文状态串），设置页据此显示「已注册 / 冲突降级」 */
    getHotkeyStatus: () => hotkeyStatus,
  }
}
